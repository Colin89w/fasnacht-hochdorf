// Einmaliges Diagnose-Werkzeug: holt EINE spezifische Mail per UID (IMAP) und
// zeigt, wie viele field-name/field-value-Paare die Extraktion findet (nur
// die LABEL-Texte, nie die Werte) + ein sicheres HTML-Skelett (Text UND
// Attributwerte wie href entfernt - anders als die frühere Skelett-Version,
// die versehentlich mailto-Adressen in Attributen stehen liess).
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";

const { IMAP_HOST, IMAP_USER, IMAP_PASSWORD, INSPECT_UID } = process.env;
const IMAP_PORT = process.env.IMAP_PORT || "993";
const IMAP_FOLDER = process.env.IMAP_FOLDER || "INBOX";

function requireEnv(name, value){
  if(!value) throw new Error(`Fehlende Umgebungsvariable: ${name}`);
  return value;
}
requireEnv("IMAP_HOST", IMAP_HOST);
requireEnv("IMAP_USER", IMAP_USER);
requireEnv("IMAP_PASSWORD", IMAP_PASSWORD);
requireEnv("INSPECT_UID", INSPECT_UID);

// Entfernt Text zwischen Tags UND alle Attributwerte (href, style, etc.) -
// sicherer als die frühere Variante, die mailto-Adressen in href stehen liess.
function safeSkeleton(html){
  return html
    .replace(/="[^"]*"/g, '="…"')
    .replace(/>([^<]*)</g, (m, inner) => inner.trim() ? ">…<" : "><");
}

function extractFieldNamePositions(html){
  const re = /<td[^>]*class="field-name"[^>]*>([\s\S]*?)<\/td>\s*<\/tr>\s*<tr[^>]*>\s*<td[^>]*class="field-value"[^>]*>/gi;
  const labels = [];
  let m;
  while((m = re.exec(html))){
    labels.push(m[1].replace(/<[^>]+>/g, "").trim());
  }
  return labels;
}

// Exakt die gleiche Regex wie in check-emails.js (inkl. Wert-Gruppe) - zeigt
// Label + Wert-LÄNGE (nie den Wert selbst), um zu sehen, ob/wo die
// Wert-Erfassung abweicht von der reinen Label-Erkennung oben.
function extractFieldNameValuePairsDiag(html){
  const re = /<td[^>]*class="field-name"[^>]*>([\s\S]*?)<\/td>\s*<\/tr>\s*<tr[^>]*>\s*<td[^>]*class="field-value"[^>]*>([\s\S]*?)<\/td>/gi;
  const pairs = [];
  let m;
  while((m = re.exec(html))){
    pairs.push([m[1].replace(/<[^>]+>/g, "").trim(), m[2].length]);
  }
  return pairs;
}

async function main(){
  const client = new ImapFlow({
    host: IMAP_HOST,
    port: Number(IMAP_PORT),
    secure: true,
    auth: { user: IMAP_USER, pass: IMAP_PASSWORD },
    logger: false
  });
  await client.connect();
  try{
    const lock = await client.getMailboxLock(IMAP_FOLDER);
    try{
      const msg = await client.fetchOne(Number(INSPECT_UID), { source: true }, { uid: true });
      if(!msg || !msg.source){ console.log("Mail nicht gefunden."); return; }
      const parsedMail = await simpleParser(msg.source);
      const html = parsedMail.html || "";
      console.log(`HTML-Länge: ${html.length}`);
      const labels = extractFieldNamePositions(html);
      console.log(`Gefundene field-name-Labels (${labels.length}):`, JSON.stringify(labels));
      const pairs = extractFieldNameValuePairsDiag(html);
      console.log(`Gefundene Label/Wert-Paare (${pairs.length}):`, JSON.stringify(pairs));
      console.log("Sicheres Skelett (Text + Attributwerte entfernt):");
      console.log(safeSkeleton(html));
    } finally {
      lock.release();
    }
  } finally {
    await client.logout();
  }
}

main().catch(err => {
  console.error("Fehlgeschlagen:", err);
  process.exitCode = 1;
});
