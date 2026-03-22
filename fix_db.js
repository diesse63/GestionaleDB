const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const bcrypt = require('bcryptjs');

const dbPath = path.join(process.cwd(), 'database.db');
const db = new sqlite3.Database(dbPath);

console.log("--- RIPRISTINO COMPLETO TABELLA UTENTI ---");

db.serialize(() => {
    // 1. Elimina la tabella corrotta
    db.run("DROP TABLE IF EXISTS Utenti", (err) => {
        if (err) console.error("❌ Errore eliminazione:", err.message);
        else console.log("🗑️  Vecchia tabella eliminata.");
    });

    // 2. Ricrea la tabella con la struttura CORRETTA (incluso ID)
    db.run(`CREATE TABLE Utenti (
        ID INTEGER PRIMARY KEY AUTOINCREMENT,
        Nome TEXT,
        Email TEXT UNIQUE,
        Password TEXT,
        Amministratore INTEGER DEFAULT 0
    )`, (err) => {
        if (err) {
            console.error("❌ Errore creazione tabella:", err.message);
            return;
        }
        console.log("✅ Nuova tabella Utenti creata (con colonna ID).");

        // 3. Inserisce un utente Amministratore di default per farti accedere
        const passHash = bcrypt.hashSync("admin123", 10); // Password: admin123
        
        db.run("INSERT INTO Utenti (Nome, Email, Password, Amministratore) VALUES (?, ?, ?, ?)", 
            ["Super Admin", "admin@example.com", passHash, 1], 
            function(err) {
                if (err) console.error("❌ Errore creazione admin:", err.message);
                else {
                    console.log("👤 Utente Default Creato:");
                    console.log("   📧 Email:    admin@example.com");
                    console.log("   🔑 Password: admin123");
                }
            }
        );
    });
});

setTimeout(() => {
    console.log("--- OPERAZIONE COMPLETATA ---");
    db.close();
}, 2000);