// Einmaliges Werkzeug: leert NUR die "pendingRegistrations"-Collection
// (die Anmeldungen-Warteliste), lässt "processedEmails" unangetastet.
// Genutzt um Duplikate zu bereinigen, bevor check-emails.js (mit bereits
// geleertem processedEmails) einen frischen, einmaligen Satz neu anlegt.
import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

const { FIREBASE_SERVICE_ACCOUNT } = process.env;
const FIREBASE_PROJECT_ID = process.env.FIREBASE_PROJECT_ID || "fasnacht-hofdere";

if(!FIREBASE_SERVICE_ACCOUNT) throw new Error("Fehlende Umgebungsvariable: FIREBASE_SERVICE_ACCOUNT");

initializeApp({
  credential: cert(JSON.parse(FIREBASE_SERVICE_ACCOUNT)),
  projectId: FIREBASE_PROJECT_ID
});
const db = getFirestore();

async function main(){
  const snap = await db.collection("pendingRegistrations").get();
  console.log(`${snap.size} Dokument(e) in "pendingRegistrations" gefunden - werden gelöscht.`);
  const batchSize = 400;
  const docs = snap.docs;
  for(let i = 0; i < docs.length; i += batchSize){
    const batch = db.batch();
    docs.slice(i, i + batchSize).forEach(d => batch.delete(d.ref));
    await batch.commit();
  }
  console.log("Fertig: pendingRegistrations geleert.");
}

main().catch(err => {
  console.error("Leeren fehlgeschlagen:", err);
  process.exitCode = 1;
});
