// Einmaliges Wiederherstellungs-Werkzeug: durchsucht das IMAP-Postfach wie
// check-emails.js, aber IGNORIERT die "processedEmails"-Sperre (durchsucht
// also auch Mails, die schon als verarbeitet markiert sind) und legt NUR für
// Vereinsnamen, die zum RECOVER_FILTER passen (Komma-getrennte Teilstrings,
// Gross/Klein egal), eine neue pendingRegistration an.
//
// Hintergrund: einzelne Anmeldungen wurden aus Firestore
// ("pendingRegistrations") gelöscht (vermutlich versehentlich über
// "Verwerfen"), bevor sie als Gruppe übernommen wurden. Die Original-Mails
// liegen aber weiterhin im Postfach - dieses Skript liest sie gezielt erneut
// ein, ohne die bereits korrekt übernommenen ~19 anderen Anmeldungen
// nochmal anzulegen (das würde Duplikate erzeugen).
//
// Ohne RECOVER_FILTER (oder mit RECOVER_LIST=true) wird NUR aufgelistet
// (Vereinsname, Vereinsart, Datum, UID), es wird NICHTS angelegt - zum
// sicheren Identifizieren der richtigen Mails, bevor man RECOVER_FILTER setzt.
//
// Aufruf (lokal/Action): RECOVER_FILTER="Trebiä,Näburuger" node scripts/recover-pending.js

import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import { convert as htmlToText } from "html-to-text";
import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore, FieldValue, Timestamp } from "firebase-admin/firestore";
import { parseFormFields, fieldsFromLabelValuePairs } from "../email-parser.js";

const {
  IMAP_HOST,
  IMAP_USER,
  IMAP_PASSWORD,
  EMAIL_SINCE_DATE,
  FIREBASE_SERVICE_ACCOUNT,
  RECOVER_FILTER
} = process.env;
const IMAP_PORT = process.env.IMAP_PORT || "993";
const IMAP_FOLDER = process.env.IMAP_FOLDER || "INBOX";
const EMAIL_SUBJECT_FILTER = process.env.EMAIL_SUBJECT_FILTER || "Anmeldung";
const FIREBASE_PROJECT_ID = process.env.FIREBASE_PROJECT_ID || "fasnacht-hofdere";

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

const HTML_ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", nbsp: " " };
function stripHtmlFragment(fragment){
  return fragment
    .replace(/<br[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (m, e) => HTML_ENTITIES[e]);
}
function extractFieldNameValuePairs(html){
  const pairs = [];
  const re = /<td[^>]*class="field-name"[^>]*>([\s\S]*?)<\/td>\s*<\/tr>\s*<tr[^>]*>\s*<td[^>]*class="field-value"[^>]*>([\s\S]*?)<\/td>/gi;
  let m;
  while((m = re.exec(html))){
    pairs.push([stripHtmlFragment(m[1]), stripHtmlFragment(m[2])]);
  }
  return pairs;
}

// Gleiche Fallback-Kette wie check-emails.js: Text -> field-name/field-value-
// Paare aus HTML -> generisches HTML-zu-Text.
function extractFields(parsedMail){
  const bodyText = (parsedMail.text || "").normalize("NFC");
  let fields = parseFormFields(bodyText);
  if(Object.keys(fields).length === 0 && parsedMail.html){
    const pairFields = fieldsFromLabelValuePairs(extractFieldNameValuePairs(parsedMail.html));
    if(Object.keys(pairFields).length > 0) fields = pairFields;
  }
  if(Object.keys(fields).length === 0 && parsedMail.html){
    const htmlText = htmlToText(parsedMail.html, { wordwrap: false }).normalize("NFC");
    const htmlFields = parseFormFields(htmlText);
    if(Object.keys(htmlFields).length > 0) fields = htmlFields;
  }
  return fields;
}

async function createPendingRegistration(fields, meta){
  await db.collection("pendingRegistrations").add({
    ...fields,
    status: "pending",
    source: "imap-recovery",
    subject: meta.subject || "",
    receivedAt: meta.date ? Timestamp.fromDate(meta.date) : FieldValue.serverTimestamp(),
    importedAt: FieldValue.serverTimestamp()
  });
}

async function main(){
  const filters = (RECOVER_FILTER || "").split(",").map(s => s.trim()).filter(Boolean);
  const listOnly = filters.length === 0;
  console.log(listOnly
    ? "Modus: NUR AUFLISTEN (kein RECOVER_FILTER gesetzt) - es wird nichts angelegt."
    : `Modus: WIEDERHERSTELLEN für Vereinsname-Treffer: ${filters.join(", ")}`);

  const client = new ImapFlow({
    host: IMAP_HOST,
    port: Number(IMAP_PORT),
    secure: true,
    auth: { user: IMAP_USER, pass: IMAP_PASSWORD },
    logger: false
  });

  let restored = 0;
  await client.connect();
  try{
    const lock = await client.getMailboxLock(IMAP_FOLDER);
    try{
      const searchCriteria = { header: { subject: EMAIL_SUBJECT_FILTER } };
      const sinceDate = EMAIL_SINCE_DATE ? new Date(EMAIL_SINCE_DATE) : new Date(new Date().setHours(0,0,0,0));
      searchCriteria.since = sinceDate;
      const uids = await client.search(searchCriteria, { uid: true });
      console.log(`${uids.length} Mail(s) im Suchzeitraum gefunden.`);

      for(const uid of uids){
        const msg = await client.fetchOne(uid, { source: true, envelope: true }, { uid: true });
        if(!msg || !msg.source) continue;
        const parsedMail = await simpleParser(msg.source);
        const fields = extractFields(parsedMail);
        const vereinsname = fields.vereinsname || "";

        console.log(`  - UID ${uid}, Datum: ${parsedMail.date || "?"}, Vereinsname: "${vereinsname}", Vereinsart: "${fields.vereinsart||""}"`);

        if(listOnly) continue;
        const match = filters.some(f => vereinsname.toLowerCase().includes(f.toLowerCase()));
        if(!match) continue;

        await createPendingRegistration(fields, { date: parsedMail.date, subject: parsedMail.subject });
        restored++;
        console.log(`    -> wiederhergestellt als neue pendingRegistration.`);
      }
    } finally {
      lock.release();
    }
  } finally {
    await client.logout();
  }

  console.log(`Fertig: ${restored} Anmeldung(en) wiederhergestellt.`);
}

main().catch(err => {
  console.error("Wiederherstellung fehlgeschlagen:", err);
  process.exitCode = 1;
});
