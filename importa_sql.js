const fs = require('fs');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = path.join(process.cwd(), 'database.db');
const sqlPath = path.join(process.cwd(), 'database.db.sql');

// 1. BACKUP DI SICUREZZA (Se esiste già un database, lo rinominiamo)
if (fs.existsSync(dbPath)) {
    console.log("Trovato un database esistente. Rinomino in database_old.db...");
    try {
        if (fs.existsSync(path.join(process.cwd(), 'database_old.db'))) {
            fs.unlinkSync(path.join(process.cwd(), 'database_old.db')); // Cancella backup precedente se c'è
        }
        fs.renameSync(dbPath, path.join(process.cwd(), 'database_old.db'));
    } catch (e) {
        console.error("Impossibile rinominare il vecchio DB. Chiudi eventuali programmi che lo usano.", e);
        process.exit(1);
    }
}

// 2. LETTURA DEL FILE SQL
if (!fs.existsSync(sqlPath)) {
    console.error("ERRORE: Non trovo il file 'database.db.sql'. Assicurati di averlo creato nella cartella del progetto.");
    process.exit(1);
}

const sqlContent = fs.readFileSync(sqlPath, 'utf8');

// 3. CREAZIONE NUOVO DB E IMPORTAZIONE
const db = new sqlite3.Database(dbPath);

console.log("Inizio importazione dati...");

db.exec(sqlContent, (err) => {
    if (err) {
        console.error("ERRORE durante l'importazione:", err);
    } else {
        console.log("---------------------------------------------------");
        console.log("SUCCESSO! Database rigenerato correttamente.");
        console.log("Tutte le tabelle (Referenti, Associazioni, ecc.) sono state create.");
        console.log("Puoi ora avviare il server.");
        console.log("---------------------------------------------------");
    }
    db.close();
});