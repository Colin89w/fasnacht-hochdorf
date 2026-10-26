// Prüft das IMAP-Postfach auf neue Anmeldungs-Mails, die noch nicht im Tool
// erfasst sind, parst sie (gleiche Logik wie der manuelle Import in
// index.html, siehe email-parser.js) und legt sie in Firestore als
// pendingRegistrations an - genau das Schema, das die App im "Neue
// Anmeldungen"-Bereich bereits anzeigt und zur Freigabe anbietet.
//
// Welche Mails schon importiert wurden, wird NICHT über das IMAP-Seen-Flag
// entschieden (das kann sich durch andere Mail-Clients/Zugriffe ändern),
// sondern über eine eigene Firestore-Collection "processedEmails", in der
// pro Mail ein Hash ihrer Message-ID abgelegt wird. Das macht den Lauf
// idempotent: ein erneuter Lauf (z.B. durch den Cron-Zeitplan) importiert
// nichts doppelt, selbst wenn die Mail im Postfach weiterhin "ungelesen" ist.
//
// Läuft via .github/workflows/check-emails.yml periodisch als GitHub Action.

import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import { convert as htmlToText } from "html-to-text";
import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore, FieldValue, Timestamp } from "firebase-admin/firestore";
import crypto from "node:crypto";
import { parseFormFields, EMAIL_IMPORT_LABELS } from "../email-parser.js";

// Nur für Debugging bei nicht erkannten Mails: zeigt pro Zeile nur Länge und
// ob/welches Label (fast) gematcht hätte - NIE den eigentlichen Inhalt, damit
// keine persönlichen Daten in den Action-Logs landen.
function diagnoseLines(text){
  const lines = text.split(/\r?\n/).map(l => l.trim().normalize("NFC"));
  return lines.map((line, i) => {
    if(!line) return `#${i} (leer)`;
    let matched = null;
    for(const [label, , isPrefix] of EMAIL_IMPORT_LABELS){
      const normLabel = label.normalize("NFC");
      if(isPrefix ? line.startsWith(normLabel) : line === normLabel){ matched = label; break; }
    }
    return `#${i} len=${line.length}${matched ? " MATCH:\""+matched+"\"" : ""}`;
  }).join(" | ");
}

// Nicht per Destructuring-Default ("= wert"), weil GitHub Actions bei einem
// nicht gesetzten Secret einen LEEREN String setzt (nicht undefined) - ein
// Destructuring-Default greift nur bei undefined, nicht bei "". Mit "||"
// schlägt der Fallback auch bei einem leeren String zu.
const {
  IMAP_HOST,
  IMAP_USER,
  IMAP_PASSWORD,
  EMAIL_SINCE_DATE,
  FIREBASE_SERVICE_ACCOUNT
} = process.env;
const IMAP_PORT = process.env.IMAP_PORT || "993";
const IMAP_FOLDER = process.env.IMAP_FOLDER || "INBOX";
const EMAIL_SUBJECT_FILTER = process.env.EMAIL_SUBJECT_FILTER || "Anmeldung";
const FIREBASE_PROJECT_ID = process.env.FIREBASE_PROJECT_ID || "fasnacht-hofdere";
const NTFY_URL = process.env.NTFY_URL || "https://ntfy.sh/hofdere-anmeldung-x7k2";
const APP_URL = process.env.APP_URL || "https://colin89w.github.io/fasnacht-hochdorf/";

function requireEnv(name, value){
  if(!value) throw new Error(`Fehlende Umgebungsvariable: ${name}`);
  return value;
}
requireEnv("IMAP_HOST", IMAP_HOST);
requireEnv("IMAP_USER", IMAP_USER);
requireEnv("IMAP_PASSWORD", IMAP_PASSWORD);
requireEnv("FIREBASE_SERVICE_ACCOUNT", FIREBASE_SERVICE_ACCOUNT);

initializeApp({
  credential: cert(JSON.parse(FIREBASE_SERVICE_ACCOUNT)),
  projectId: FIREBASE_PROJECT_ID
});
const db = getFirestore();

function hashMessageId(id){
  return crypto.createHash("sha256").update(id).digest("hex");
}

async function getProcessed(hash){
  const doc = await db.collection("processedEmails").doc(hash).get();
  return doc.exists ? doc.data() : null;
}

async function markProcessed(hash, meta){
  await db.collection("processedEmails").doc(hash).set({
    ...meta,
    processedAt: FieldValue.serverTimestamp()
  });
}

async function createPendingRegistration(fields, meta){
  await db.collection("pendingRegistrations").add({
    ...fields,
    status: "pending",
    source: "imap-auto-import",
    subject: meta.subject || "",
    receivedAt: meta.date ? Timestamp.fromDate(meta.date) : FieldValue.serverTimestamp(),
    importedAt: FieldValue.serverTimestamp()
  });
}

async function notify(newEntries){
  if(!newEntries.length) return;
  const lines = newEntries.map(e =>
    "• " + (e.vereinsname || "(kein Name erkannt)") + (e.vereinsart ? " [" + e.vereinsart + "]" : "") + (e.incomplete ? " ⚠️ nur teilweise erkannt - bitte prüfen" : "")
  );
  const title = newEntries.length === 1 ? "Neue Anmeldung" : newEntries.length + " neue Anmeldungen";
  const body = lines.join("\n") + "\n\nJetzt prüfen: " + APP_URL;
  try{
    await fetch(NTFY_URL, {
      method: "POST",
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Title": title,
        "Click": APP_URL
      },
      body
    });
  }catch(e){
    console.error("ntfy-Benachrichtigung fehlgeschlagen:", e);
  }
}

async function main(){
  const client = new ImapFlow({
    host: IMAP_HOST,
    port: Number(IMAP_PORT),
    secure: true,
    auth: { user: IMAP_USER, pass: IMAP_PASSWORD },
    logger: false
  });

  const newEntries = [];
  await client.connect();
  try{
    const lock = await client.getMailboxLock(IMAP_FOLDER);
    try{
      const searchCriteria = { header: { subject: EMAIL_SUBJECT_FILTER } };
      // Ohne explizites Since-Datum nur ab heute suchen, damit der erste
      // Lauf nicht die komplette Postfach-Historie als "neu" importiert.
      const sinceDate = EMAIL_SINCE_DATE ? new Date(EMAIL_SINCE_DATE) : new Date(new Date().setHours(0,0,0,0));
      searchCriteria.since = sinceDate;

      const uids = await client.search(searchCriteria, { uid: true });
      console.log(`Suche ab ${sinceDate.toISOString()}, Betreff-Filter "${EMAIL_SUBJECT_FILTER}", Ordner "${IMAP_FOLDER}": ${uids.length} Mail(s) gefunden.`);

      let alreadyDone = 0;
      const unrecognized = [];

      for(const uid of uids){
        const msg = await client.fetchOne(uid, { source: true, envelope: true }, { uid: true });
        if(!msg || !msg.source) continue;

        const parsedMail = await simpleParser(msg.source);
        const messageId = parsedMail.messageId
          || ((msg.envelope?.date || "") + "-" + (msg.envelope?.subject || "") + "-" + uid);
        const hash = hashMessageId(messageId);

        const existing = await getProcessed(hash);
        if(existing && !existing.skipped){
          // Schon erfolgreich importiert - nichts tun.
          alreadyDone++;
          continue;
        }
        // existing ist entweder null (neue Mail) oder {skipped:true} (frühere
        // Mail, die damals nicht erkannt wurde) - in beiden Fällen jetzt
        // (erneut) versuchen zu parsen, damit ein verbesserter Parser auch
        // rückwirkend auf zuvor übersprungene Mails wirkt.
        if(existing) alreadyDone++;

        // Nur Struktur-Infos (keine Inhalte) fürs Debugging, falls eine Mail
        // nicht erkannt wird - z.B. um HTML-only-Mails (ohne Text-Teil) zu
        // identifizieren, ohne persönliche Daten zu loggen.
        const textLen = (parsedMail.text || "").length;
        const htmlLen = (parsedMail.html || "").length;
        const contentType = parsedMail.headers?.get("content-type");
        const contentTypeStr = contentType && typeof contentType === "object"
          ? JSON.stringify(contentType)
          : String(contentType || "?");

        let bodyText = (parsedMail.text || "").normalize("NFC");
        let fields = parseFormFields(bodyText);

        if(Object.keys(fields).length === 0 && parsedMail.html){
          // Manche Absender-Systeme liefern einen schlecht umgebrochenen
          // Text-Teil (z.B. durchgehend bei ~76 Zeichen umgebrochener
          // Fliesstext, der die Label/Wert-Zeilenstruktur zerstört - sichtbar
          // an vielen gleich langen Zeilen quer durch den ganzen Text, ohne
          // Bezug zum Inhalt). Der HTML-Teil bildet dasselbe Formular meist
          // weiterhin ein Feld pro Absatz ab -> daraus als Fallback Text
          // gewinnen (wordwrap:false, damit kein Label mitten im Wort
          // zerschnitten wird).
          const htmlText = htmlToText(parsedMail.html, { wordwrap: false }).normalize("NFC");
          const htmlFields = parseFormFields(htmlText);
          if(Object.keys(htmlFields).length > 0){
            fields = htmlFields;
            bodyText = htmlText;
          }
        }

        if(Object.keys(fields).length === 0){
          // Keine einzige erkannte Zeile (auch nicht über den HTML-Fallback)
          // -> keine Anmeldung (z.B. eine Rückfrage-Antwort im selben
          // Mail-Thread) - nichts anlegen, aber als geprüft markieren.
          unrecognized.push({ subject: parsedMail.subject || "", uid, date: parsedMail.date, textLen, htmlLen, lineDiag: diagnoseLines(bodyText), contentType: contentTypeStr });
          await markProcessed(hash, { subject: parsedMail.subject || "", skipped: true });
          continue;
        }

        const incomplete = !fields.vereinsname || !fields.praesidentName;
        await createPendingRegistration(fields, { date: parsedMail.date, subject: parsedMail.subject });
        await markProcessed(hash, { subject: parsedMail.subject || "", skipped: false });
        newEntries.push({ vereinsname: fields.vereinsname, vereinsart: fields.vereinsart, incomplete });
      }

      console.log(`Davon bereits zuvor verarbeitet: ${alreadyDone}.`);
      if(unrecognized.length){
        console.log(`Nicht als Anmeldung erkannt (0 Felder gefunden), daher übersprungen: ${unrecognized.length}.`);
        unrecognized.forEach(u => {
          console.log(`  - UID ${u.uid}${u.previously ? " (bereits in früherem Lauf übersprungen)" : ""}, Betreff: "${u.subject}", Datum: ${u.date || "?"}, Text-Länge: ${u.textLen}, HTML-Länge: ${u.htmlLen}, Content-Type: ${u.contentType}`);
          console.log(`    Zeilen: ${u.lineDiag}`);
        });
      }
    } finally {
      lock.release();
    }
  } finally {
    await client.logout();
  }

  await notify(newEntries);
  console.log(`Fertig: ${newEntries.length} neue Anmeldung(en) importiert.`);
}

main().catch(err => {
  console.error("E-Mail-Check fehlgeschlagen:", err);
  process.exitCode = 1;
});
