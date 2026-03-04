const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const dbCandidates = [
    path.join(process.cwd(), 'database.db'),
    path.join(process.cwd(), 'database.db.LOCKED')
];

const dbPath = dbCandidates.find(p => fs.existsSync(p));
if (!dbPath) {
    console.error('ERRORE: nessun database trovato (database.db / database.db.LOCKED).');
    process.exit(1);
}

console.log(`Database selezionato: ${path.basename(dbPath)}`);
const db = new Database(dbPath);

db.pragma('foreign_keys = ON');

const tx = db.transaction(() => {
    db.exec(`
        CREATE TABLE IF NOT EXISTS "DocumentoTipo" (
            "ID" INTEGER NOT NULL,
            "Tipo" INTEGER NOT NULL UNIQUE,
            PRIMARY KEY("ID" AUTOINCREMENT)
        );

        CREATE TABLE IF NOT EXISTS "Documento" (
            "ID" INTEGER,
            "IDTipologia" INTEGER NOT NULL,
            "IDTipo" INTEGER NOT NULL,
            "Nome" TEXT NOT NULL,
            "Link" TEXT NOT NULL,
            "Note" TEXT,
            FOREIGN KEY("IDTipo") REFERENCES "DocumentoTipo"("ID") ON UPDATE CASCADE ON DELETE RESTRICT,
            FOREIGN KEY("IDTipologia") REFERENCES "Tipologia"("ID") ON UPDATE CASCADE ON DELETE RESTRICT,
            PRIMARY KEY("ID" AUTOINCREMENT)
        );

        CREATE UNIQUE INDEX IF NOT EXISTS "idx_documento_univoco" ON "Documento" (
            "Nome",
            "IDTipologia",
            "IDTipo"
        );

        CREATE UNIQUE INDEX IF NOT EXISTS "idx_mail" ON "Mail" (
            "IDAssociazione",
            "Indirizzo"
        );
    `);
});

try {
    tx();
    const hasDocumento = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='Documento'").get();
    const hasDocumentoTipo = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='DocumentoTipo'").get();
    const tipoInfo = hasDocumentoTipo
        ? db.prepare("PRAGMA table_info('DocumentoTipo')").all().find(c => c.name === 'Tipo')
        : null;

    console.log('Migrazione completata con successo.');
    console.log(`- Tabella Documento: ${hasDocumento ? 'OK' : 'MANCANTE'}`);
    console.log(`- Tabella DocumentoTipo: ${hasDocumentoTipo ? 'OK' : 'MANCANTE'}`);
    if (tipoInfo) {
        console.log(`- Colonna DocumentoTipo.Tipo: type='${tipoInfo.type}'`);
    }
} catch (error) {
    console.error('Errore migrazione:', error.message);
    process.exitCode = 1;
} finally {
    db.close();
}
