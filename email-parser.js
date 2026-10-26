// Gemeinsame Parser-Logik für den E-Mail-Import der Anmeldungen.
//
// Wird sowohl im Browser (index.html, manueller Copy-Paste-Import) als
// auch im Node-Script (scripts/check-emails.js, automatischer IMAP-Import
// per GitHub Actions) importiert, damit die Feld-Erkennung nur an einer
// Stelle existiert und nicht auseinanderdriften kann.

export const EMAIL_IMPORT_LABELS = [
  ["Zusätzlich gewünschte Auftritte", "auftritte", true],
  ["Fasnachtstage", "fasnachtstage", false],
  ["Vereinsart", "vereinsart", false],
  ["Vereinsname", "vereinsname", false],
  ["Anzahl Mitglieder", "mitglieder", false],
  ["geplante Anreisezeit", "anreise", false],
  ["geplante Abreisezeit", "abreise", false],
  ["Carparkplatz benötigt", "carpark", false],
  ["Instrumentenanhängerplatz benötigt", "anhaenger", false],
  ["Znachtessen erwünscht", "znacht", true],
  ["Präsident", "praesidentName", false],
  ["Auftrittchef", "tourName", true],
  ["Strasse / Nr. (Kassier)", "_ignore", false],
  ["PLZ Ort (Kassier)", "_ignore", false],
  ["Natel-Nummer (Auftritt)", "tourTel", false],
  ["Natel-Nummer", "praesidentTel", false],
  ["E-Mail", "tourEmail", false],
  ["Email", "praesidentEmail", false],
  ["Bemerkungen", "bemerkungen", false]
];

// Erwartet bereits dekodierten Klartext (Quoted-Printable/HTML schon
// aufgelöst). Erkennt Label-Zeilen und sammelt alle folgenden Zeilen bis
// zum nächsten Label als deren Wert. NFC-normalisiert, weil manche Quellen
// (macOS-Zwischenablage, manche Mailserver) Umlaute zerlegt liefern
// (z.B. "a" + Combining-Diaeresis statt dem einen Zeichen "ä") - sonst
// würden Labels mit Umlaut (Präsident, Zusätzlich, erwünscht) nicht
// erkannt und die Zeile würde in den vorherigen Wert rutschen.
export function parseFormFields(text){
  const lines = text.split(/\r?\n/).map(l => l.trim().normalize("NFC"));
  function matchLabel(line){
    for(const [label, key, isPrefix] of EMAIL_IMPORT_LABELS){
      const normLabel = label.normalize("NFC");
      if(isPrefix ? line.startsWith(normLabel) : line === normLabel) return key;
    }
    return null;
  }
  const buckets = {};
  let currentKey = null;
  lines.forEach(line => {
    const key = matchLabel(line);
    if(key){ currentKey = key; buckets[key] = []; return; }
    if(currentKey && line) buckets[currentKey].push(line);
  });
  const values = {};
  Object.keys(buckets).forEach(k => { values[k] = buckets[k].join(" ").trim(); });
  return values;
}
