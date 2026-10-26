// Einmaliges Diagnose-Werkzeug: liest NUR aus Firestore (kein IMAP) und
// druckt alle pendingRegistrations-Dokumente, deren Vereinsname zu
// INSPECT_FILTER passt (Teilstring, Gross/Klein egal) - vollständig, inkl.
// aller erkannten Felder, um Parser-Abweichungen zu finden.
import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

const { FIREBASE_SERVICE_ACCOUNT, INSPECT_FILTER } = process.env;
const FIREBASE_PROJECT_ID = process.env.FIREBASE_PROJECT_ID || "fasnacht-hofdere";

if(!FIREBASE_SERVICE_ACCOUNT) throw new Error("Fehlende Umgebungsvariable: FIREBASE_SERVICE_ACCOUNT");

initializeApp({
  credential: cert(JSON.parse(FIREBASE_SERVICE_ACCOUNT)),
  projectId: FIREBASE_PROJECT_ID
});
const db = getFirestore();

async function main(){
  const filter = (INSPECT_FILTER || "").toLowerCase();
  const snap = await db.collection("pendingRegistrations").get();
  console.log(`${snap.size} Dokument(e) insgesamt in "pendingRegistrations".`);
  let matches = 0;
  snap.forEach(doc => {
    const data = doc.data();
    const haystack = JSON.stringify(data).toLowerCase();
    if(filter && !haystack.includes(filter)) return;
    matches++;
    console.log(`--- Dokument ${doc.id} ---`);
    console.log(JSON.stringify(data, null, 2));
  });
  console.log(`${matches} Treffer für Filter "${INSPECT_FILTER || ""}".`);
}

main().catch(err => {
  console.error("Inspektion fehlgeschlagen:", err);
  process.exitCode = 1;
});
