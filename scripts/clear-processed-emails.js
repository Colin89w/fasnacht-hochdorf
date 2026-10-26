// Einmaliges Werkzeug: leert NUR die "processedEmails"-Collection (die
// Dedup-Sperre), lässt "pendingRegistrations" unangetastet. Danach behandelt
// check-emails.js beim nächsten Lauf alle Mails im Suchzeitraum wieder als
// neu - nützlich, um nach einem Parser-Fix rückwirkend zu prüfen, ob noch
// weitere Mails (nicht nur die bereits bekannte Trebiä-Mail) falsch erfasst
// wurden.
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
  const snap = await db.collection("processedEmails").get();
  console.log(`${snap.size} Dokument(e) in "processedEmails" gefunden - werden gelöscht.`);
  const batchSize = 400; // Firestore-Limit pro Batch ist 500
  const docs = snap.docs;
  for(let i = 0; i < docs.length; i += batchSize){
    const batch = db.batch();
    docs.slice(i, i + batchSize).forEach(d => batch.delete(d.ref));
    await batch.commit();
  }
  console.log("Fertig: processedEmails geleert.");
}

main().catch(err => {
  console.error("Leeren fehlgeschlagen:", err);
  process.exitCode = 1;
});
