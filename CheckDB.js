const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

// Cerca il DB (sia normale che bloccato)
let dbPath = 'database.db';
if (!fs.existsSync(dbPath) && fs.existsSync('database.db.LOCKED')) {
    dbPath = 'database.db.LOCKED';
    console.log("Trovato solo file BLOCCATO. Controllo quello...");
}

if (!fs.existsSync(dbPath)) {
    console.error("ERRORE: Nessun database trovato!");
    process.exit(1);
}

const db = new Database(dbPath);

console.log(`\n--- CONTROLLO DATABASE: ${dbPath} ---`);

// 1. Elenco Tabelle
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
console.log(`Tabelle trovate: ${tables.length}`);
tables.forEach(t => console.log(` - ${t.name}`));

// 2. Conteggio Dati (Esempio)
if (tables.some(t => t.name === 'Associazioni')) {
    const count = db.prepare("SELECT COUNT(*) as c FROM Associazioni").get();
    console.log(`\nRecord in Associazioni: ${count.c}`);
} else {
    console.log("\n[!] Tabella 'Associazioni' MANCANTE!");
}

if (tables.some(t => t.name === 'Utenti')) {
    const users = db.prepare("SELECT Nome, Email FROM Utenti").all();
    console.log("\nUtenti presenti:");
    users.forEach(u => console.log(` - ${u.Nome} (${u.Email})`));
}