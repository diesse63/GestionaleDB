// --- FIX TOTALE PER PKG (Bypass TextDecoder per encoding mancanti) ---
if (typeof TextDecoder !== 'undefined') {
    const OriginalTextDecoder = TextDecoder;
    global.TextDecoder = class extends OriginalTextDecoder {
        constructor(encoding, options) {
            const enc = encoding ? String(encoding).toLowerCase().replace(/[-_]/g, '') : 'utf8';
            if (enc === 'ascii' || enc === 'latin1' || enc === 'windows1252') {
                super('utf-8', options); 
                this.shouldUseBuffer = true;
                this.targetEncoding = (enc === 'windows1252') ? 'latin1' : enc;
            } else {
                super(encoding, options);
            }
        }
        decode(input, options) {
            if (this.shouldUseBuffer) {
                if (!input) return '';
                const buf = Buffer.isBuffer(input) ? input : Buffer.from(input);
                return buf.toString(this.targetEncoding);
            }
            return super.decode(input, options);
        }
    };
}
// --- FINE FIX ---

const express = require('express');
const cors = require('cors');
const path = require('path');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const fs = require('fs');
const os = require('os');
const multer = require('multer');
const XLSX = require('xlsx'); 
const PDFDocument = require('pdfkit'); 
const archiver = require('archiver'); 
const Database = require('better-sqlite3');

// ============================================================================
// 1. CONFIGURAZIONE
// ============================================================================

const DB_FILENAME = 'database.db';
const DB_LOCKED_NAME = 'database.db.LOCKED';
const LOCK_INFO_FILE = 'session.lock';
const BACKUP_DIR_NAME = 'backups_db';
const MAX_BACKUPS = 5;          // Regola: Ultimi 5 file per i Backup
const MAX_PDF_TEMP = 5;         // Regola: Ultimi 5 file per i PDF
const EXCEL_TTL_MS = 5 * 60 * 1000; // Regola: Excel durano 5 minuti

// Root Dir
const rootDir = (typeof process.pkg !== 'undefined') ? path.dirname(process.execPath) : __dirname;

const pathDbLibero = path.join(rootDir, DB_FILENAME);
const pathDbOccupato = path.join(rootDir, DB_LOCKED_NAME);
const pathLockInfo = path.join(rootDir, LOCK_INFO_FILE);
const pathBackupDir = path.join(rootDir, BACKUP_DIR_NAME);

// Cartelle Upload
const uploadDir = path.join(rootDir, 'archivio_files');
const verbaliDir = path.join(uploadDir, 'verbali');
const documentiDir = path.join(uploadDir, 'documenti');
const tempDir = path.join(uploadDir, 'temp');

const MY_HOSTNAME = os.hostname();
let db = null;
let dbIsLockedByMe = false;
let isClosing = false;

// Creazione cartelle
try {
    if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);
    if (!fs.existsSync(verbaliDir)) fs.mkdirSync(verbaliDir);
    if (!fs.existsSync(documentiDir)) fs.mkdirSync(documentiDir);
    if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir);
} catch (err) { console.error("Errore cartelle:", err.message); }

// ============================================================================
// 2. SISTEMA DI PULIZIA AVANZATO (NETTURBINO)
// ============================================================================

function manutenzioneCartellaTemp() {
    // Questa funzione viene chiamata ogni minuto per controllare la cartella temp
    try {
        if (!fs.existsSync(tempDir)) return;

        const allFiles = fs.readdirSync(tempDir).map(file => {
            return {
                name: file,
                path: path.join(tempDir, file),
                time: fs.statSync(path.join(tempDir, file)).mtime.getTime(),
                ext: path.extname(file).toLowerCase()
            };
        });

        // 1. GESTIONE EXCEL (.xlsx) -> Cancella se più vecchi di 5 minuti
        const now = Date.now();
        const excelFiles = allFiles.filter(f => f.ext === '.xlsx');
        
        excelFiles.forEach(f => {
            if ((now - f.time) > EXCEL_TTL_MS) {
                try {
                    fs.unlinkSync(f.path);
                    console.log(`> Pulizia: Eliminato Excel scaduto ${f.name}`);
                } catch(e) {}
            }
        });

        // 2. GESTIONE PDF (.pdf) -> Tieni solo gli ultimi 5 (Quantità)
        const pdfFiles = allFiles.filter(f => f.ext === '.pdf');
        
        // Ordina dal più recente al più vecchio
        pdfFiles.sort((a, b) => b.time - a.time);

        if (pdfFiles.length > MAX_PDF_TEMP) {
            // Prendi quelli che eccedono il limite (dall'indice 5 in poi)
            const daCancellare = pdfFiles.slice(MAX_PDF_TEMP);
            daCancellare.forEach(f => {
                try {
                    fs.unlinkSync(f.path);
                    console.log(`> Pulizia: Eliminato PDF vecchio (limite 5) ${f.name}`);
                } catch(e) {}
            });
        }

    } catch (e) {
        console.error("> Errore manutenzione temp:", e.message);
    }
}

// Avvia il ciclo di pulizia ogni 60 secondi
setInterval(manutenzioneCartellaTemp, 60000);
// Esegui una volta all'avvio
manutenzioneCartellaTemp();


function deletePhysicalFile(relPath) {
    if(!relPath) return;
    const cleanRel = relPath.replace(/^(\/|\\)/, '').replace(/^(archivio_files[\/\\])/, '');
    const fullPath = path.join(uploadDir, cleanRel.replace('verbali/', 'verbali\\').replace('documenti/', 'documenti\\'));
    const fullPathB = path.join(rootDir, relPath.replace(/^\//, ''));
    if(fs.existsSync(fullPath)) try{fs.unlinkSync(fullPath);}catch(e){}
    else if(fs.existsSync(fullPathB)) try{fs.unlinkSync(fullPathB);}catch(e){}
}

function sanitizeFilePart(value) {
    return String(value || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-zA-Z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .replace(/_+/g, '_')
        .slice(0, 80) || 'doc';
}

function buildDocumentBaseName(nome, tipologiaLabel, tipoLabel) {
    const n = sanitizeFilePart(nome);
    const t = sanitizeFilePart(tipologiaLabel);
    const tp = sanitizeFilePart(tipoLabel);
    return `${n}_${t}_${tp}`;
}

function makeUniqueDocumentFilename(baseName, ext = '.pdf') {
    let candidate = `${baseName}${ext}`;
    let i = 2;
    while (fs.existsSync(path.join(documentiDir, candidate))) {
        candidate = `${baseName}_${i}${ext}`;
        i += 1;
    }
    return candidate;
}

function resolveAbsoluteFromDocumentLink(relPath) {
    if (!relPath) return null;
    const fileName = path.basename(String(relPath));
    return path.join(documentiDir, fileName);
}

// ============================================================================
// 3. MOTORE DI SICUREZZA (BACKUP DB & LOCK)
// ============================================================================

function eseguiBackup(sourcePath) {
    try {
        if (!fs.existsSync(pathBackupDir)) fs.mkdirSync(pathBackupDir);
        const now = new Date();
        const timeStr = now.toISOString().replace(/[:.]/g, '-');
        const destName = `backup_${timeStr}.bak`;
        const destPath = path.join(pathBackupDir, destName);

        console.log(`> Backup automatico: ${destName}`);
        fs.copyFileSync(sourcePath, destPath);

        // Rotazione Backup DB (Tiene ultimi 5)
        const files = fs.readdirSync(pathBackupDir)
            .filter(f => f.endsWith('.bak'))
            .map(f => ({ name: f, path: path.join(pathBackupDir, f), time: fs.statSync(path.join(pathBackupDir, f)).mtime.getTime() }))
            .sort((a, b) => b.time - a.time);

        if (files.length > MAX_BACKUPS) {
            files.slice(MAX_BACKUPS).forEach(f => { try{fs.unlinkSync(f.path)}catch(e){} });
        }
    } catch (error) { console.error("> Warning Backup:", error.message); }
}

function scriviLockInfo() {
    try { fs.writeFileSync(pathLockInfo, JSON.stringify({ user: MY_HOSTNAME, timestamp: Date.now() })); } catch (e) {}
}

function leggiLockInfo() {
    if (!fs.existsSync(pathLockInfo)) return null;
    try { return JSON.parse(fs.readFileSync(pathLockInfo, 'utf8')); } catch (e) { return null; }
}

function avviaDatabaseInEsclusiva() {
    console.log(`\n--- AVVIO SISTEMA (${MY_HOSTNAME}) ---`);

    if (fs.existsSync(pathDbLibero)) {
        try {
            eseguiBackup(pathDbLibero);
            console.log("> Blocco database...");
            fs.renameSync(pathDbLibero, pathDbOccupato);
            scriviLockInfo();
            dbIsLockedByMe = true;
        } catch (e) {
            console.error("> ERRORE: Impossibile bloccare il file.");
            return null;
        }
    } else if (fs.existsSync(pathDbOccupato)) {
        const info = leggiLockInfo();
        if (info && info.user === MY_HOSTNAME) {
            console.log("> Rilevato crash precedente. Ripristino sessione.");
            scriviLockInfo();
            dbIsLockedByMe = true;
        } else {
            const chi = info ? info.user : "Sconosciuto";
            console.log(`\n!!! ACCESSO NEGATO !!! Database in uso da: ${chi}`);
            return null;
        }
    } else {
        console.log("> Creazione nuovo database.");
        scriviLockInfo();
        dbIsLockedByMe = true;
    }

    try {
        const database = new Database(pathDbOccupato);
        database.pragma('journal_mode = DELETE');
        database.pragma('foreign_keys = ON');

        console.log("> Verifica integrità schema tabelle...");
        
        // --- STRUTTURA TABELLE ---
        database.exec(`
            CREATE TABLE IF NOT EXISTS "Utenti" (
                "ID" INTEGER PRIMARY KEY AUTOINCREMENT,
                "Nome" TEXT,
                "Email" TEXT UNIQUE,
                "Password" TEXT,
                "Amministratore" INTEGER DEFAULT 0
            );
            CREATE TABLE IF NOT EXISTS "Tipologia" (
                "ID" INTEGER PRIMARY KEY AUTOINCREMENT,
                "Tipologia" TEXT NOT NULL UNIQUE
            );
            CREATE TABLE IF NOT EXISTS "Associazioni" (
                "ID" INTEGER PRIMARY KEY AUTOINCREMENT,
                "ID_TIPOLOGIA" INTEGER NOT NULL,
                "COLONNA3" TEXT,
                "TAVOLO" INTEGER NOT NULL DEFAULT 0 CHECK("TAVOLO" IN (0, 1)),
                "DIRETTIVO_DELEGAZIONE" INTEGER NOT NULL DEFAULT 0 CHECK("DIRETTIVO_DELEGAZIONE" IN (0, 1)),
                "SOGGETTO" TEXT NOT NULL UNIQUE,
                "CODICEFISCALE" TEXT,
                FOREIGN KEY("ID_TIPOLOGIA") REFERENCES "Tipologia"("ID") ON UPDATE CASCADE ON DELETE RESTRICT
            );
            CREATE TABLE IF NOT EXISTS "Referenti" (
                "ID" INTEGER PRIMARY KEY AUTOINCREMENT,
                "ID_Associazione" INTEGER NOT NULL,
                "Nome" TEXT NOT NULL,
                "MAILREFERENTE" TEXT,
                FOREIGN KEY("ID_Associazione") REFERENCES "Associazioni"("ID") ON UPDATE CASCADE ON DELETE CASCADE,
                UNIQUE("ID_Associazione","Nome")
            );
            CREATE TABLE IF NOT EXISTS "AltriSoggetti" (
                "ID" INTEGER PRIMARY KEY AUTOINCREMENT,
                "ID_Associazione" INTEGER NOT NULL,
                "Nome" TEXT NOT NULL,
                "MAILALTRISOGGETTI" TEXT,
                FOREIGN KEY("ID_Associazione") REFERENCES "Associazioni"("ID") ON UPDATE CASCADE ON DELETE CASCADE,
                UNIQUE("ID_Associazione","Nome")
            );
            CREATE TABLE IF NOT EXISTS "Mail" (
                "ID" INTEGER PRIMARY KEY AUTOINCREMENT,
                "IDAssociazione" INTEGER NOT NULL,
                "Indirizzo" TEXT NOT NULL,
                "PEC" INTEGER DEFAULT 0 CHECK("PEC" IN (0, 1)),
                "Predefinito" INTEGER DEFAULT 0 CHECK("Predefinito" IN (0, 1)),
                FOREIGN KEY("IDAssociazione") REFERENCES "Associazioni"("ID") ON UPDATE CASCADE ON DELETE CASCADE,
                UNIQUE("IDAssociazione","Indirizzo")
            );
            CREATE TABLE IF NOT EXISTS "Telefono" (
                "ID" INTEGER PRIMARY KEY AUTOINCREMENT,
                "IDAssociazione" INTEGER NOT NULL,
                "Telefono" TEXT NOT NULL,
                "Predefinito" INTEGER DEFAULT 0,
                FOREIGN KEY("IDAssociazione") REFERENCES "Associazioni"("ID") ON UPDATE CASCADE ON DELETE CASCADE,
                UNIQUE("IDAssociazione","Telefono")
            );
            CREATE TABLE IF NOT EXISTS "Runts" (
                "CodiceFiscale" TEXT UNIQUE,
                "Denominazione" TEXT,
                "Cognome" TEXT,
                "Nome" TEXT,
                "IDAssociazione" INTEGER,
                "Provincia" TEXT,
                PRIMARY KEY("CodiceFiscale")
            );
            CREATE TABLE IF NOT EXISTS "CesvotTelefono" (
                "ID" INTEGER PRIMARY KEY AUTOINCREMENT,
                "Denominazione" TEXT,
                "Telefono" TEXT,
                UNIQUE("Denominazione","Telefono")
            );
            CREATE TABLE IF NOT EXISTS "CesvotMail" (
                "ID" INTEGER PRIMARY KEY AUTOINCREMENT,
                "Denominazione" TEXT,
                "Mail" TEXT,
                UNIQUE("Denominazione","Mail")
            );
            CREATE TABLE IF NOT EXISTS "Temporanea" (
                "SOGGETTO" TEXT,
                "MAIL" TEXT
            );
            CREATE TABLE IF NOT EXISTS "MailList" (
                "ID" INTEGER PRIMARY KEY AUTOINCREMENT,
                "Descrizione" TEXT NOT NULL UNIQUE,
                "Note" TEXT
            );
            CREATE TABLE IF NOT EXISTS "ListaMail" (
                "ID" INTEGER PRIMARY KEY AUTOINCREMENT,
                "IDListaMail" INTEGER NOT NULL,
                "IDMail" INTEGER NOT NULL,
                "TipoInvio" TEXT DEFAULT 'CCN',
                FOREIGN KEY("IDListaMail") REFERENCES "MailList"("ID") ON UPDATE CASCADE ON DELETE CASCADE,
                FOREIGN KEY("IDMail") REFERENCES "Mail"("ID") ON UPDATE CASCADE ON DELETE CASCADE,
                UNIQUE("IDListaMail","IDMail")
            );
            CREATE TABLE IF NOT EXISTS "AgoraTipoEvento" (
                "ID" INTEGER PRIMARY KEY AUTOINCREMENT,
                "IntestazionePagina" TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS "Agora" (
                "ID" INTEGER NOT NULL PRIMARY KEY,
                "Data" TEXT NOT NULL,
                "Evento" TEXT,
                "ODG" TEXT,
                "Verbale" TEXT,
                "Documenti" TEXT,
                "IDTipoEvento" INTEGER NOT NULL,
                FOREIGN KEY("IDTipoEvento") REFERENCES "AgoraTipoEvento"("ID") ON DELETE RESTRICT
            );
            CREATE TABLE IF NOT EXISTS "AgoraPresenti" (
                "ID" INTEGER PRIMARY KEY AUTOINCREMENT,
                "IDRiunioni" INTEGER NOT NULL,
                "IDAssociazione" INTEGER NOT NULL,
                "Rappresentante" TEXT,
                FOREIGN KEY("IDAssociazione") REFERENCES "Associazioni"("ID") ON UPDATE CASCADE ON DELETE RESTRICT,
                FOREIGN KEY("IDRiunioni") REFERENCES "Agora"("ID") ON UPDATE CASCADE ON DELETE CASCADE,
                UNIQUE("IDRiunioni","IDAssociazione","Rappresentante")
            );
            CREATE TABLE IF NOT EXISTS "AgoraOld" (
                "ID" INTEGER NOT NULL,
                "Data" TEXT NOT NULL,
                "Evento" TEXT,
                "ODG" TEXT,
                "Verbale" TEXT,
                "Documenti" TEXT,
                "IDTipoEvento" INTEGER NOT NULL,
                PRIMARY KEY("ID")
            );
            CREATE TABLE IF NOT EXISTS "Report" (
                "ID" INTEGER NOT NULL,
                "Password" TEXT NOT NULL,
                PRIMARY KEY("ID" AUTOINCREMENT)
            );
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
            CREATE UNIQUE INDEX IF NOT EXISTS "idx_documento_univoco" ON "Documento"(
                "Nome",
                "IDTipologia",
                "IDTipo"
            );
        `);

        // Seed
        if(database.prepare("SELECT COUNT(*) as c FROM Tipologia").get().c === 0) {
            ['ODV', 'APS', 'Onlus', 'Altro'].forEach(t => database.prepare("INSERT INTO Tipologia (Tipologia) VALUES (?)").run(t));
        }
        if(database.prepare("SELECT COUNT(*) as c FROM AgoraTipoEvento").get().c === 0) {
            database.prepare("INSERT INTO AgoraTipoEvento (IntestazionePagina) VALUES (?)").run('Tavolo Agorà');
        }

        console.log("> Database connesso.");
        return database;
    } catch (e) { console.error("> Errore critico DB:", e); return null; }
}

function chiudiTutto() {
    if (!dbIsLockedByMe) return;
    console.log("\n> Chiusura e sblocco...");
    if (db) { try { db.close(); db = null; } catch(e){} }
    if (fs.existsSync(pathDbOccupato)) {
        try {
            fs.renameSync(pathDbOccupato, pathDbLibero);
            if (fs.existsSync(pathLockInfo)) fs.unlinkSync(pathLockInfo);
            console.log("> Database rilasciato.");
            dbIsLockedByMe = false;
        } catch (e) { console.error("> ERRORE SBLOCCO: Usa SBLOCCO_EMERGENZA.bat"); }
    }
}

// ============================================================================
// 4. EXPRESS APP
// ============================================================================

const app = express();
const port = 3000;
const publicPath = path.join(__dirname, 'public');

const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        if (file.fieldname === 'verbale') cb(null, verbaliDir);
        else if (file.fieldname === 'documenti') cb(null, documentiDir);
        else cb(null, tempDir);
    },
    filename: (req, file, cb) => {
        let prefix = file.fieldname === 'verbale' ? 'ver' : (file.fieldname === 'documenti' ? 'doc' : 'runts');
        cb(null, `${prefix}_${Date.now()}_${file.originalname}`);
    }
});
const upload = multer({ storage: storage });
const uploadFields = upload.fields([{ name: 'verbale' }, { name: 'documenti' }, { name: 'fileRunts' }]);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cors({ origin: true, credentials: true }));
app.use(session({
    name: 'gestionale_sid',
    secret: 'secret-key-123',
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, maxAge: 86400000 }
}));
app.use('/archivio_files', express.static(uploadDir));
app.use(express.static(publicPath));

const checkAuth = (req, res, next) => (req.session && req.session.userId) ? next() : res.status(401).json({error:"Login richiesto"});
const checkAdmin = (req, res, next) => (req.session && req.session.isAdmin === 1) ? next() : res.status(403).json({error:"Admin richiesto"});

// --- ROTTE HTML ---
app.get('/login.html', (req, res) => { if (req.session.userId) return res.redirect('/'); res.sendFile(path.join(publicPath, 'login.html')); });
app.get('/', (req, res) => { if (!req.session.userId) return res.redirect('/login.html'); res.sendFile(path.join(publicPath, 'index.html')); });

app.get('/servizi.html', (req, res) => res.redirect('/dashboard_servizi'));

['agora','gestione_associazioni','gestione_referenti','gestione_altri','anagrafica_singola','gestione_mailinglist','dashboard_servizi','gestione_utenti','anagrafica','agora_tipo_eventi','documento_tipi','gestione_documentale'].forEach(p => {
    app.get(`/${p}`, (req, res) => {
        if(!req.session.userId) return res.redirect('/login.html');
        if(['dashboard_servizi','gestione_utenti','anagrafica','agora_tipo_eventi','documento_tipi'].includes(p) && req.session.isAdmin !== 1) return res.redirect('/');
        res.sendFile(path.join(publicPath, p === 'agora' ? 'registro_agora.html' : `${p}.html`));
    });
    app.get(`/${p}.html`, (req, res) => res.redirect(`/${p}`));
});

// ============================================================================
// 5. API ENDPOINTS
// ============================================================================

db = avviaDatabaseInEsclusiva();

if (!db) {
    console.log("Premi CTRL+C per uscire...");
    setTimeout(() => process.exit(1), 20000);
} else {

    // Auth
    app.post('/api/login', (req, res) => {
        try {
            const user = db.prepare("SELECT * FROM Utenti WHERE Email = ?").get(req.body.email);
            if (!user || !bcrypt.compareSync(req.body.password, user.Password)) return res.status(401).json({success:false});
            req.session.userId = user.Email; req.session.userName = user.Nome; req.session.isAdmin = user.Amministratore;
            res.json({success:true, nome: user.Nome, admin: user.Amministratore});
        } catch(e) { res.status(500).json({error:e.message}); }
    });
    app.post('/api/logout', (req, res) => req.session.destroy(() => res.json({success:true})));
    app.get('/api/me', checkAuth, (req, res) => res.json({logged:true, nome:req.session.userName, isAdmin:req.session.isAdmin===1}));

    // MASTER DATA
    app.get('/api/associazioni', checkAuth, (req, res) => res.json(db.prepare("SELECT a.*, t.Tipologia as Tipologia_Nome FROM Associazioni a LEFT JOIN Tipologia t ON a.ID_TIPOLOGIA = t.ID ORDER BY a.SOGGETTO").all()));
    app.post('/api/associazioni', checkAuth, checkAdmin, (req, res) => {
        const {ID_TIPOLOGIA,SOGGETTO,TAVOLO,DIRETTIVO_DELEGAZIONE,CODICEFISCALE} = req.body;
        try{res.json({success:true, id:db.prepare("INSERT INTO Associazioni (ID_TIPOLOGIA,SOGGETTO,TAVOLO,DIRETTIVO_DELEGAZIONE,CODICEFISCALE) VALUES (?,?,?,?,?)").run(ID_TIPOLOGIA,SOGGETTO,TAVOLO==1?1:0,DIRETTIVO_DELEGAZIONE==1?1:0,CODICEFISCALE).lastInsertRowid});}catch(e){res.status(500).json({error:e.message});}
    });
    app.put('/api/associazioni/:id', checkAuth, checkAdmin, (req, res) => {
        const {ID_TIPOLOGIA,SOGGETTO,TAVOLO,DIRETTIVO_DELEGAZIONE,CODICEFISCALE} = req.body;
        try{db.prepare("UPDATE Associazioni SET ID_TIPOLOGIA=?,SOGGETTO=?,TAVOLO=?,DIRETTIVO_DELEGAZIONE=?,CODICEFISCALE=? WHERE ID=?").run(ID_TIPOLOGIA,SOGGETTO,TAVOLO==1?1:0,DIRETTIVO_DELEGAZIONE==1?1:0,CODICEFISCALE,req.params.id);res.json({success:true});}catch(e){res.status(500).json({error:e.message});}
    });
    app.delete('/api/associazioni/:id', checkAuth, checkAdmin, (req, res) => { try{db.prepare("DELETE FROM Associazioni WHERE ID=?").run(req.params.id);res.json({success:true});}catch(e){res.status(500).json({error:e.message});} });

    // MAIL/TELEFONO
    app.get('/api/associazioni/:id/mail', checkAuth, (req, res) => res.json(db.prepare("SELECT * FROM Mail WHERE IDAssociazione=? ORDER BY Predefinito DESC").all(req.params.id)));
    app.post('/api/mail', checkAuth, checkAdmin, (req, res) => {
        const {IDAssociazione,Indirizzo,PEC,Predefinito}=req.body; const d=Predefinito==1?1:0;
        try{db.transaction(()=>{if(d)db.prepare("UPDATE Mail SET Predefinito=0 WHERE IDAssociazione=?").run(IDAssociazione);db.prepare("INSERT INTO Mail(IDAssociazione,Indirizzo,PEC,Predefinito) VALUES(?,?,?,?)").run(IDAssociazione,Indirizzo,PEC==1?1:0,d);})();res.json({success:true});}catch(e){res.status(500).json({error:e.message});}
    });
    app.delete('/api/mail/:id', checkAuth, checkAdmin, (req, res) => { try{db.prepare("DELETE FROM Mail WHERE ID=?").run(req.params.id);res.json({success:true});}catch(e){res.status(500).json({error:e.message});} });
    
    app.get('/api/associazioni/:id/telefono', checkAuth, (req, res) => res.json(db.prepare("SELECT * FROM Telefono WHERE IDAssociazione=? ORDER BY Predefinito DESC").all(req.params.id)));
    app.post('/api/telefono', checkAuth, checkAdmin, (req, res) => {
        const {IDAssociazione,Telefono,Predefinito}=req.body; const d=Predefinito==1?1:0;
        try{db.transaction(()=>{if(d)db.prepare("UPDATE Telefono SET Predefinito=0 WHERE IDAssociazione=?").run(IDAssociazione);db.prepare("INSERT INTO Telefono(IDAssociazione,Telefono,Predefinito) VALUES(?,?,?)").run(IDAssociazione,Telefono,d);})();res.json({success:true});}catch(e){res.status(500).json({error:e.message});}
    });
    app.delete('/api/telefono/:id', checkAuth, checkAdmin, (req, res) => { try{db.prepare("DELETE FROM Telefono WHERE ID=?").run(req.params.id);res.json({success:true});}catch(e){res.status(500).json({error:e.message});} });

    // REFERENTI & ALTRI
    const getAllReferenti = () => db.prepare("SELECT r.*, a.SOGGETTO FROM Referenti r LEFT JOIN Associazioni a ON r.ID_Associazione=a.ID ORDER BY r.Nome").all();
    const getAllAltri = () => db.prepare("SELECT s.*, a.SOGGETTO FROM AltriSoggetti s LEFT JOIN Associazioni a ON s.ID_Associazione=a.ID ORDER BY s.Nome").all();

    app.get('/api/referenti', checkAuth, (req, res) => res.json(getAllReferenti()));
    app.get('/api/all-referenti', checkAuth, (req, res) => res.json(getAllReferenti()));

    app.post('/api/referenti', checkAuth, checkAdmin, (req, res) => { try{db.prepare("INSERT INTO Referenti(ID_Associazione,Nome,MAILREFERENTE) VALUES(?,?,?)").run(req.body.ID_Associazione,req.body.Nome,req.body.MAILREFERENTE);res.json({success:true});}catch(e){res.status(500).json({error:e.message});} });
    app.put('/api/referenti/:id', checkAuth, checkAdmin, (req, res) => {
        try { db.prepare("UPDATE Referenti SET ID_Associazione=?, Nome=?, MAILREFERENTE=? WHERE ID=?").run(req.body.ID_Associazione, req.body.Nome, req.body.MAILREFERENTE, req.params.id); res.json({success:true}); } catch(e) { res.status(500).json({error:e.message}); }
    });
    app.delete('/api/referenti/:id', checkAuth, checkAdmin, (req, res) => { try{db.prepare("DELETE FROM Referenti WHERE ID=?").run(req.params.id);res.json({success:true});}catch(e){res.status(500).json({error:e.message});} });

    app.get('/api/altrisoggetti', checkAuth, (req, res) => res.json(getAllAltri()));
    app.get('/api/all-altri-soggetti', checkAuth, (req, res) => res.json(getAllAltri())); 
    app.get('/api/all-altri', checkAuth, (req, res) => res.json(getAllAltri()));        

    app.post('/api/altri-soggetti', checkAuth, checkAdmin, (req, res) => { try{db.prepare("INSERT INTO AltriSoggetti(ID_Associazione,Nome,MAILALTRISOGGETTI) VALUES(?,?,?)").run(req.body.ID_Associazione,req.body.Nome,req.body.MAILALTRISOGGETTI);res.json({success:true});}catch(e){res.status(500).json({error:e.message});} });
    app.put('/api/altri-soggetti/:id', checkAuth, checkAdmin, (req, res) => {
        try { db.prepare("UPDATE AltriSoggetti SET ID_Associazione=?, Nome=?, MAILALTRISOGGETTI=? WHERE ID=?").run(req.body.ID_Associazione, req.body.Nome, req.body.MAILALTRISOGGETTI, req.params.id); res.json({success:true}); } catch(e) { res.status(500).json({error:e.message}); }
    });
    app.delete('/api/altri-soggetti/:id', checkAuth, checkAdmin, (req, res) => { try{db.prepare("DELETE FROM AltriSoggetti WHERE ID=?").run(req.params.id);res.json({success:true});}catch(e){res.status(500).json({error:e.message});} });

    app.get('/api/persone/tutti', checkAuth, (req, res) => res.json(db.prepare(`SELECT r.Nome, 'Referente' as Tipo, r.ID_Associazione, a.SOGGETTO FROM Referenti r JOIN Associazioni a ON r.ID_Associazione = a.ID UNION ALL SELECT s.Nome, 'Altro Soggetto' as Tipo, s.ID_Associazione, a.SOGGETTO FROM AltriSoggetti s JOIN Associazioni a ON s.ID_Associazione = a.ID ORDER BY SOGGETTO ASC, Nome ASC`).all()));
    app.get('/api/tipologie', checkAuth, (req, res) => res.json(db.prepare("SELECT * FROM Tipologia ORDER BY Tipologia").all()));

    // --- UTENTI ---
    app.get('/api/utenti', checkAuth, checkAdmin, (req, res) => res.json(db.prepare("SELECT ID, Nome, Email, Amministratore FROM Utenti ORDER BY Nome").all()));
    app.post('/api/utenti', checkAuth, checkAdmin, (req, res) => {
        const {Nome,Email,Password,Amministratore} = req.body;
        try { db.prepare("INSERT INTO Utenti (Nome,Email,Password,Amministratore) VALUES (?,?,?,?)").run(Nome,Email,bcrypt.hashSync(Password,10),Amministratore==1?1:0); res.json({success:true}); } catch(e){res.status(500).json({error:e.message});}
    });
    app.put('/api/utenti/:id', checkAuth, checkAdmin, (req, res) => {
        const {Nome,Email,Password,Amministratore} = req.body; const adm = Amministratore==1?1:0;
        try {
            if(Password && Password.trim()) db.prepare("UPDATE Utenti SET Nome=?, Email=?, Password=?, Amministratore=? WHERE ID=?").run(Nome,Email,bcrypt.hashSync(Password,10),adm,req.params.id);
            else db.prepare("UPDATE Utenti SET Nome=?, Email=?, Amministratore=? WHERE ID=?").run(Nome,Email,adm,req.params.id);
            res.json({success:true});
        } catch(e){res.status(500).json({error:e.message});}
    });
    app.delete('/api/utenti/:id', checkAuth, checkAdmin, (req, res) => {
        try {
            if(db.prepare("SELECT Email FROM Utenti WHERE ID=?").get(req.params.id)?.Email === req.session.userId) return res.status(403).json({error:"No auto-delete"});
            db.prepare("DELETE FROM Utenti WHERE ID=?").run(req.params.id);
            res.json({success:true});
        } catch(e){res.status(500).json({error:e.message});}
    });

    // --- AGORA ---
    app.get('/api/agora-tipi', checkAuth, (req, res) => res.json(db.prepare("SELECT * FROM AgoraTipoEvento").all()));
    app.put('/api/agora-tipi/:id', checkAuth, checkAdmin, (req, res) => { try{db.prepare("UPDATE AgoraTipoEvento SET IntestazionePagina=? WHERE ID=?").run(req.body.IntestazionePagina, req.params.id);res.json({success:true});}catch(e){res.status(500).json({error:e.message});} });
    app.post('/api/agora-tipi', checkAuth, checkAdmin, (req, res) => { try{db.prepare("INSERT INTO AgoraTipoEvento(IntestazionePagina) VALUES(?)").run(req.body.IntestazionePagina);res.json({success:true});}catch(e){res.status(500).json({error:e.message});} });
    app.delete('/api/agora-tipi/:id', checkAuth, checkAdmin, (req, res) => { try{db.prepare("DELETE FROM AgoraTipoEvento WHERE ID=?").run(req.params.id);res.json({success:true});}catch(e){res.status(500).json({error:e.message});} });

    app.get('/api/documenti-tipi', checkAuth, (req, res) => res.json(db.prepare("SELECT ID, Tipo FROM DocumentoTipo ORDER BY Tipo").all()));
    app.post('/api/documenti-tipi', checkAuth, checkAdmin, (req, res) => {
        try {
            const tipo = String(req.body.Tipo ?? '').trim();
            if (!tipo) return res.status(400).json({ error: 'Tipo non valido' });
            db.prepare("INSERT INTO DocumentoTipo(Tipo) VALUES(?)").run(tipo);
            res.json({ success: true });
        } catch (e) {
            if (String(e.message || '').includes('UNIQUE constraint failed: DocumentoTipo.Tipo')) {
                return res.status(409).json({ error: 'Tipologia già esistente' });
            }
            res.status(500).json({ error: e.message });
        }
    });
    app.put('/api/documenti-tipi/:id', checkAuth, checkAdmin, (req, res) => {
        try {
            const tipo = String(req.body.Tipo ?? '').trim();
            if (!tipo) return res.status(400).json({ error: 'Tipo non valido' });
            db.prepare("UPDATE DocumentoTipo SET Tipo=? WHERE ID=?").run(tipo, req.params.id);
            res.json({ success: true });
        } catch (e) {
            if (String(e.message || '').includes('UNIQUE constraint failed: DocumentoTipo.Tipo')) {
                return res.status(409).json({ error: 'Tipologia già esistente' });
            }
            res.status(500).json({ error: e.message });
        }
    });
    app.delete('/api/documenti-tipi/:id', checkAuth, checkAdmin, (req, res) => {
        try {
            db.prepare("DELETE FROM DocumentoTipo WHERE ID=?").run(req.params.id);
            res.json({ success: true });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    app.get('/api/documenti', checkAuth, (req, res) => {
        try {
            const rows = db.prepare(`
                SELECT
                    D.ID,
                    D.IDTipologia,
                    D.IDTipo,
                    D.Nome,
                    D.Link,
                    D.Note,
                    T.Tipologia,
                    DT.Tipo
                FROM Documento D
                LEFT JOIN Tipologia T ON T.ID = D.IDTipologia
                LEFT JOIN DocumentoTipo DT ON DT.ID = D.IDTipo
                ORDER BY D.ID DESC
            `).all();
            res.json(rows);
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    app.post('/api/documenti', checkAuth, checkAdmin, uploadFields, (req, res) => {
        try {
            const idTipologia = Number(req.body.IDTipologia || 0);
            const idTipo = Number(req.body.IDTipo || 0);
            const nome = String(req.body.Nome || '').trim();
            const note = String(req.body.Note || '').trim();
            const fileDoc = req.files?.['documenti']?.[0];

            if (!idTipologia || !idTipo || !nome) {
                return res.status(400).json({ error: 'Campi obbligatori mancanti' });
            }
            if (!fileDoc) {
                return res.status(400).json({ error: 'File documento obbligatorio' });
            }

            if (!/\.pdf$/i.test(String(fileDoc.originalname || ''))) {
                deletePhysicalFile(`/archivio_files/documenti/${fileDoc.filename}`);
                return res.status(400).json({ error: 'È consentito solo il formato PDF' });
            }

            const already = db.prepare("SELECT ID FROM Documento WHERE Nome=? AND IDTipologia=? AND IDTipo=?")
                .get(nome, idTipologia, idTipo);
            if (already) {
                deletePhysicalFile(`/archivio_files/documenti/${fileDoc.filename}`);
                return res.status(409).json({ error: 'Documento già presente con Nome, Tipologia e Tipo selezionati' });
            }

            const tipologiaRow = db.prepare("SELECT Tipologia FROM Tipologia WHERE ID=?").get(idTipologia);
            const tipoRow = db.prepare("SELECT Tipo FROM DocumentoTipo WHERE ID=?").get(idTipo);
            if (!tipologiaRow || !tipoRow) {
                deletePhysicalFile(`/archivio_files/documenti/${fileDoc.filename}`);
                return res.status(400).json({ error: 'Tipologia o Tipo documento non validi' });
            }

            const baseName = buildDocumentBaseName(nome, tipologiaRow.Tipologia, tipoRow.Tipo);
            const finalFileName = makeUniqueDocumentFilename(baseName, '.pdf');
            fs.renameSync(path.join(documentiDir, fileDoc.filename), path.join(documentiDir, finalFileName));

            const link = `/archivio_files/documenti/${finalFileName}`;
            const result = db.prepare("INSERT INTO Documento (IDTipologia, IDTipo, Nome, Link, Note) VALUES (?,?,?,?,?)")
                .run(idTipologia, idTipo, nome, link, note);

            res.json({ success: true, id: result.lastInsertRowid });
        } catch (e) {
            if (String(e.message || '').includes('UNIQUE constraint failed: Documento.Nome, Documento.IDTipologia, Documento.IDTipo')) {
                return res.status(409).json({ error: 'Documento già presente con Nome, Tipologia e Tipo selezionati' });
            }
            res.status(500).json({ error: e.message });
        }
    });

    app.put('/api/documenti/:id', checkAuth, checkAdmin, uploadFields, (req, res) => {
        try {
            const row = db.prepare("SELECT ID, IDTipologia, IDTipo, Nome, Link FROM Documento WHERE ID=?").get(req.params.id);
            if (!row) return res.status(404).json({ error: 'Documento non trovato' });

            const idTipologia = Number(req.body.IDTipologia || 0);
            const idTipo = Number(req.body.IDTipo || 0);
            const nome = String(req.body.Nome || '').trim();
            const note = String(req.body.Note || '').trim();

            if (!idTipologia || !idTipo || !nome) {
                return res.status(400).json({ error: 'Campi obbligatori mancanti' });
            }

            const duplicate = db.prepare("SELECT ID FROM Documento WHERE Nome=? AND IDTipologia=? AND IDTipo=? AND ID<>?")
                .get(nome, idTipologia, idTipo, req.params.id);
            if (duplicate) {
                const uploadedOnConflict = req.files?.['documenti']?.[0];
                if (uploadedOnConflict) deletePhysicalFile(`/archivio_files/documenti/${uploadedOnConflict.filename}`);
                return res.status(409).json({ error: 'Documento già presente con Nome, Tipologia e Tipo selezionati' });
            }

            const tipologiaRow = db.prepare("SELECT Tipologia FROM Tipologia WHERE ID=?").get(idTipologia);
            const tipoRow = db.prepare("SELECT Tipo FROM DocumentoTipo WHERE ID=?").get(idTipo);
            if (!tipologiaRow || !tipoRow) {
                const uploadedInvalid = req.files?.['documenti']?.[0];
                if (uploadedInvalid) deletePhysicalFile(`/archivio_files/documenti/${uploadedInvalid.filename}`);
                return res.status(400).json({ error: 'Tipologia o Tipo documento non validi' });
            }

            let link = row.Link || '';
            const fileDoc = req.files?.['documenti']?.[0];
            const baseName = buildDocumentBaseName(nome, tipologiaRow.Tipologia, tipoRow.Tipo);
            const currentAbs = resolveAbsoluteFromDocumentLink(link);

            if (fileDoc) {
                if (!/\.pdf$/i.test(String(fileDoc.originalname || ''))) {
                    deletePhysicalFile(`/archivio_files/documenti/${fileDoc.filename}`);
                    return res.status(400).json({ error: 'È consentito solo il formato PDF' });
                }

                deletePhysicalFile(link);
                const finalFileName = makeUniqueDocumentFilename(baseName, '.pdf');
                fs.renameSync(path.join(documentiDir, fileDoc.filename), path.join(documentiDir, finalFileName));
                link = `/archivio_files/documenti/${finalFileName}`;
            } else if (req.body.deleteDocumento === 'true') {
                deletePhysicalFile(link);
                link = '';
            } else if (currentAbs && fs.existsSync(currentAbs)) {
                const desiredFileName = `${baseName}.pdf`;
                const currentName = path.basename(currentAbs);
                if (currentName !== desiredFileName) {
                    const finalFileName = makeUniqueDocumentFilename(baseName, '.pdf');
                    fs.renameSync(currentAbs, path.join(documentiDir, finalFileName));
                    link = `/archivio_files/documenti/${finalFileName}`;
                }
            }

            db.prepare("UPDATE Documento SET IDTipologia=?, IDTipo=?, Nome=?, Link=?, Note=? WHERE ID=?")
                .run(idTipologia, idTipo, nome, link, note, req.params.id);

            res.json({ success: true });
        } catch (e) {
            if (String(e.message || '').includes('UNIQUE constraint failed: Documento.Nome, Documento.IDTipologia, Documento.IDTipo')) {
                return res.status(409).json({ error: 'Documento già presente con Nome, Tipologia e Tipo selezionati' });
            }
            res.status(500).json({ error: e.message });
        }
    });

    app.delete('/api/documenti/:id', checkAuth, checkAdmin, (req, res) => {
        try {
            const row = db.prepare("SELECT Link FROM Documento WHERE ID=?").get(req.params.id);
            if (row?.Link) deletePhysicalFile(row.Link);
            db.prepare("DELETE FROM Documento WHERE ID=?").run(req.params.id);
            res.json({ success: true });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    app.get('/api/agora', checkAuth, (req, res) => {
        try { res.json(db.prepare(req.query.tipo ? "SELECT * FROM Agora WHERE IDTipoEvento=? ORDER BY Data DESC" : "SELECT * FROM Agora ORDER BY Data DESC").all(req.query.tipo || [])); } catch(e){res.status(500).json({error:e.message});}
    });
    app.post('/api/agora', checkAuth, checkAdmin, uploadFields, (req, res) => {
        let v = req.files['verbale'] ? `/archivio_files/verbali/${req.files['verbale'][0].filename}` : "";
        let d = req.files['documenti'] ? `/archivio_files/documenti/${req.files['documenti'][0].filename}` : "";
        try { res.json({success:true, id:db.prepare("INSERT INTO Agora (Data,Evento,ODG,Verbale,Documenti,IDTipoEvento) VALUES(?,?,?,?,?,?)").run(req.body.Data,req.body.Evento,req.body.ODG,v,d,req.body.IDTipoEvento||1).lastInsertRowid}); } catch(e){res.status(500).json({error:e.message});}
    });
    app.put('/api/agora/:id', checkAuth, checkAdmin, uploadFields, (req, res) => {
        try {
            const row = db.prepare("SELECT Verbale,Documenti FROM Agora WHERE ID=?").get(req.params.id);
            if(!row) return res.status(404).json({error:"Not found"});
            let v = row.Verbale, d = row.Documenti;
            if(req.files['verbale']) { deletePhysicalFile(v); v=`/archivio_files/verbali/${req.files['verbale'][0].filename}`; }
            else if(req.body.deleteVerbale==='true') { deletePhysicalFile(v); v=""; }
            if(req.files['documenti']) { deletePhysicalFile(d); d=`/archivio_files/documenti/${req.files['documenti'][0].filename}`; }
            else if(req.body.deleteDocumenti==='true') { deletePhysicalFile(d); d=""; }
            db.prepare("UPDATE Agora SET Data=?,Evento=?,ODG=?,Verbale=?,Documenti=?,IDTipoEvento=? WHERE ID=?").run(req.body.Data,req.body.Evento,req.body.ODG,v,d,req.body.IDTipoEvento||1,req.params.id);
            res.json({success:true});
        } catch(e){res.status(500).json({error:e.message});}
    });
    app.delete('/api/agora/:id', checkAuth, checkAdmin, (req, res) => {
        try {
            const row = db.prepare("SELECT Verbale,Documenti FROM Agora WHERE ID=?").get(req.params.id);
            if(row) { deletePhysicalFile(row.Verbale); deletePhysicalFile(row.Documenti); }
            db.transaction(()=>{ db.prepare("DELETE FROM AgoraPresenti WHERE IDRiunioni=?").run(req.params.id); db.prepare("DELETE FROM Agora WHERE ID=?").run(req.params.id); })();
            res.json({success:true});
        } catch(e){res.status(500).json({error:e.message});}
    });
    app.get('/api/agora/:id/presenti', checkAuth, (req, res) => res.json(db.prepare("SELECT P.ID as IDRiga, P.IDAssociazione, A.SOGGETTO, P.Rappresentante FROM AgoraPresenti P JOIN Associazioni A ON P.IDAssociazione=A.ID WHERE P.IDRiunioni=?").all(req.params.id)));
    app.post('/api/agora/presenti', checkAuth, checkAdmin, (req, res) => {
        try { const r = db.prepare("INSERT OR IGNORE INTO AgoraPresenti (IDRiunioni,IDAssociazione,Rappresentante) VALUES(?,?,?)").run(req.body.IDRiunioni,req.body.IDAssociazione,req.body.Rappresentante); res.json({success:true, added:r.changes>0}); } catch(e){res.status(500).json({error:e.message});}
    });
    app.delete('/api/agora/presenti/:id', checkAuth, checkAdmin, (req, res) => { try{db.prepare("DELETE FROM AgoraPresenti WHERE ID=?").run(req.params.id);res.json({success:true});}catch(e){res.status(500).json({error:e.message});} });
    app.post('/api/agora/:id/create-maillist', checkAuth, checkAdmin, (req, res) => {
        try {
            const eventRow = db.prepare("SELECT ID, Data, Evento FROM Agora WHERE ID=?").get(req.params.id);
            if(!eventRow) return res.status(404).json({error:"Evento non trovato"});

            const baseDescr = `${eventRow.Evento || 'Evento'} - ${eventRow.Data || ''}`.trim();
            
            // Controlla se esiste una lista con lo stesso nome
            const existingList = db.prepare("SELECT ID FROM MailList WHERE Descrizione=?").get(baseDescr);
            let idLista;
            let isNew = true;

            if(existingList) {
                idLista = existingList.ID;
                isNew = false;
                // Pulisci la lista esistente dai vecchi membri
                db.prepare("DELETE FROM ListaMail WHERE IDListaMail=?").run(idLista);
            } else {
                const createResult = db.prepare("INSERT INTO MailList(Descrizione, Note) VALUES(?, ?)").run(
                    baseDescr,
                    `Creata automaticamente da Registro Agorà (ID evento: ${eventRow.ID})`
                );
                idLista = createResult.lastInsertRowid;
            }

            const presenti = db.prepare(`
                SELECT p.IDAssociazione, p.Rappresentante
                FROM AgoraPresenti p
                WHERE p.IDRiunioni = ?
            `).all(req.params.id);

            const allMailIds = new Set();
            const noMailList = [];
            const presentiNomi = [];

            const getDefaultMails = db.prepare("SELECT ID, Indirizzo FROM Mail WHERE IDAssociazione=? AND Predefinito=1 AND Indirizzo IS NOT NULL AND TRIM(Indirizzo)<>''");
            const getAllMails = db.prepare("SELECT ID, Indirizzo FROM Mail WHERE IDAssociazione=? AND Indirizzo IS NOT NULL AND TRIM(Indirizzo)<>''");
            const getRefMail = db.prepare("SELECT MAILREFERENTE as MailPersonale FROM Referenti WHERE ID_Associazione=? AND Nome=? AND MAILREFERENTE IS NOT NULL AND TRIM(MAILREFERENTE)<>'' LIMIT 1");
            const getAltroMail = db.prepare("SELECT MAILALTRISOGGETTI as MailPersonale FROM AltriSoggetti WHERE ID_Associazione=? AND Nome=? AND MAILALTRISOGGETTI IS NOT NULL AND TRIM(MAILALTRISOGGETTI)<>'' LIMIT 1");
            const getAssocName = db.prepare("SELECT SOGGETTO FROM Associazioni WHERE ID=?");
            const findMailByAssocAndAddress = db.prepare("SELECT ID FROM Mail WHERE IDAssociazione=? AND LOWER(TRIM(Indirizzo))=LOWER(TRIM(?)) LIMIT 1");
            const insertMail = db.prepare("INSERT INTO Mail(IDAssociazione, Indirizzo, PEC, Predefinito) VALUES(?, ?, 0, 0)");

            presenti.forEach(p => {
                const assocName = getAssocName.get(p.IDAssociazione)?.SOGGETTO || 'N/D';
                const presentiLabel = p.Rappresentante ? `${assocName} - ${p.Rappresentante}` : assocName;
                presentiNomi.push(presentiLabel);

                const preferred = getDefaultMails.all(p.IDAssociazione);
                const selectedAssocMails = preferred.length > 0 ? preferred : getAllMails.all(p.IDAssociazione);
                selectedAssocMails.forEach(m => allMailIds.add(m.ID));

                const nomeRapp = (p.Rappresentante || '').trim();
                const personalEmail = nomeRapp ? ((getRefMail.get(p.IDAssociazione, nomeRapp)?.MailPersonale || getAltroMail.get(p.IDAssociazione, nomeRapp)?.MailPersonale) || '').trim() : '';

                if(personalEmail) {
                    let mailRow = findMailByAssocAndAddress.get(p.IDAssociazione, personalEmail);
                    if(!mailRow) {
                        const insertedMail = insertMail.run(p.IDAssociazione, personalEmail);
                        mailRow = { ID: insertedMail.lastInsertRowid };
                    }
                    if(mailRow?.ID) allMailIds.add(mailRow.ID);
                }

                // Segnala chi non ha mail
                if(!selectedAssocMails.length && !personalEmail) {
                    noMailList.push(presentiLabel);
                }
            });

            let inserted = 0;
            const addMember = db.prepare("INSERT OR IGNORE INTO ListaMail(IDListaMail, IDMail, TipoInvio) VALUES(?, ?, 'CCN')");
            allMailIds.forEach(idMail => {
                const r = addMember.run(idLista, idMail);
                inserted += r.changes;
            });

            res.json({
                success: true,
                idMailList: idLista,
                descrizione: baseDescr,
                totalMails: allMailIds.size,
                inserted,
                isNew,
                presentiNomi,
                noMailList
            });
        } catch(e){
            res.status(500).json({error:e.message});
        }
    });

    // --- AGORA REPORT ---
    app.get('/api/report/agora-pdf', checkAuth, (req, res) => {
        try {
            const events = db.prepare(`SELECT A.ID, A.Data, A.Evento, A.ODG, T.ID as TipoID, T.IntestazionePagina FROM Agora A LEFT JOIN AgoraTipoEvento T ON A.IDTipoEvento = T.ID ORDER BY T.ID ASC, A.Data DESC`).all();
            const participants = db.prepare(`SELECT P.IDRiunioni, A.SOGGETTO FROM AgoraPresenti P JOIN Associazioni A ON P.IDAssociazione = A.ID ORDER BY A.SOGGETTO ASC`).all();
            const doc = new PDFDocument({ margin: 50 });
            res.setHeader('Content-Type', 'application/pdf'); res.setHeader('Content-Disposition', 'attachment; filename=Report_Agora_Associazioni.pdf'); doc.pipe(res);
            doc.fontSize(24).font('Helvetica-Bold').text('Tavolo Agorà', { align: 'center' }); doc.moveDown(1.5);
            let currentTipoID = -1;
            events.forEach((ev) => {
                if (ev.TipoID !== currentTipoID) { if (currentTipoID !== -1) doc.addPage(); currentTipoID = ev.TipoID; doc.fontSize(18).fillColor('#2c3e50').text(ev.IntestazionePagina || 'Tipologia Non Definita', { underline: true }); doc.moveDown(0.5).moveTo(50, doc.y).lineTo(550, doc.y).stroke().moveDown(1); }
                doc.fillColor('black').fontSize(12).font('Helvetica-Bold').text(`Data: ${ev.Data} - ${ev.Evento}`); if (ev.ODG) doc.fontSize(10).font('Helvetica-Oblique').text(`Argomenti Trattati: ${ev.ODG}`, { indent: 10 }); doc.moveDown(0.5);
                const presenti = participants.filter(p => p.IDRiunioni === ev.ID).map(p => p.SOGGETTO); doc.fontSize(10).font('Helvetica').text('Associazioni Presenti:', { indent: 10, underline: true });
                if (presenti.length > 0) doc.fontSize(10).font('Helvetica').text(presenti.join(', '), { indent: 20, align: 'justify' }); else doc.fontSize(10).font('Helvetica-Oblique').text('Nessuna associazione registrata.', { indent: 20 });
                doc.moveDown(1.5);
            });
            doc.end();
        } catch (e) { res.status(500).send("Errore PDF: " + e.message); }
    });

    app.get('/api/report/agora-zip', checkAuth, (req, res) => {
        try {
            const events = db.prepare(`SELECT A.ID, A.Data, A.Evento, A.ODG, A.Verbale, A.Documenti, T.ID as TipoID, T.IntestazionePagina FROM Agora A LEFT JOIN AgoraTipoEvento T ON A.IDTipoEvento = T.ID ORDER BY T.ID ASC, A.Data DESC`).all();
            const participants = db.prepare(`SELECT P.IDRiunioni, A.SOGGETTO, P.Rappresentante FROM AgoraPresenti P JOIN Associazioni A ON P.IDAssociazione = A.ID ORDER BY A.SOGGETTO ASC`).all();

            const archive = archiver('zip', { zlib: { level: 9 } });
            res.setHeader('Content-Type', 'application/zip');
            res.setHeader('Content-Disposition', 'attachment; filename=Agorà_Report_Completo.zip');
            archive.pipe(res);

            const doc = new PDFDocument({ margin: 50 });
            archive.append(doc, { name: 'Report_Dettagliato_Agora.pdf' });
            
            doc.fontSize(20).font('Helvetica-Bold').text('Tavolo Agorà - Report Dettagliato', { align: 'center' });
            doc.moveDown(2);

            let currentTipoID = -1;
            events.forEach((ev) => {
                if (ev.TipoID !== currentTipoID) {
                    if (currentTipoID !== -1) doc.addPage();
                    currentTipoID = ev.TipoID;
                    doc.fontSize(16).fillColor('#0056b3').text(ev.IntestazionePagina || 'Tipologia Non Definita', { underline: true });
                    doc.moveDown(1);
                }
                doc.fillColor('black').fontSize(12).font('Helvetica-Bold').text(`Data: ${ev.Data} - ${ev.Evento}`);
                if (ev.ODG) doc.fontSize(10).font('Helvetica-Oblique').text(`Argomenti Trattati: ${ev.ODG}`, { indent: 10 });
                
                const nomeVerbale = ev.Verbale ? path.basename(ev.Verbale) : "Nessuno";
                const nomeDoc = ev.Documenti ? path.basename(ev.Documenti) : "Nessuno";
                doc.fontSize(9).font('Helvetica').fillColor('#555555');
                doc.text(`File Verbale: ${nomeVerbale}`, { indent: 10 });
                doc.text(`File Documenti: ${nomeDoc}`, { indent: 10 });
                doc.moveDown(0.5);

                doc.fillColor('black').fontSize(10).font('Helvetica-Bold').text('Partecipanti:', { indent: 10, underline: true });
                const myParticipants = participants.filter(p => p.IDRiunioni === ev.ID);
                doc.fontSize(10).font('Helvetica');
                if (myParticipants.length > 0) {
                    myParticipants.forEach(p => {
                        const rapp = p.Rappresentante ? p.Rappresentante : '---';
                        doc.text(`• ${p.SOGGETTO} - ${rapp}`, { indent: 20, align: 'left', width: 480 });
                    });
                } else {
                    doc.text('Nessuno.', { indent: 20, oblique: true });
                }
                doc.moveDown(1.5).moveTo(50, doc.y).lineTo(550, doc.y).strokeColor('#dddddd').stroke().moveDown(1);

                // Add physical files
                const safeName = ev.Evento ? ev.Evento.replace(/[^a-z0-9]/gi, '_').substring(0, 30) : 'Evento';
                const folder = `${ev.Data}_${safeName}_ID${ev.ID}`;
                
                const addFileToZip = (filePath, zipName) => {
                    if(!filePath) return;
                    const cleanP = filePath.replace(/^\/|^\\[a-z0-9_]+\\/, '');
                    const fullP = path.join(uploadDir, cleanP.replace('verbali/','verbali\\').replace('documenti/','documenti\\'));
                    if(fs.existsSync(fullP)) archive.file(fullP, { name: zipName });
                    else {
                        const fullPB = path.join(rootDir, filePath.replace(/^\//,''));
                        if(fs.existsSync(fullPB)) archive.file(fullPB, { name: zipName });
                    }
                };

                if (ev.Verbale) addFileToZip(ev.Verbale, `${folder}/Verbale_${path.basename(ev.Verbale)}`);
                if (ev.Documenti) addFileToZip(ev.Documenti, `${folder}/Documenti_${path.basename(ev.Documenti)}`);
            });

            doc.end();
            archive.finalize();
        } catch (e) { res.status(500).send("Errore ZIP: " + e.message); }
    });

    app.get('/api/report/settings', checkAuth, checkAdmin, (req, res) => {
        try {
            const row = db.prepare('SELECT Password FROM Report ORDER BY ID DESC LIMIT 1').get();
            res.json({ Password: row?.Password || '' });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    app.put('/api/report/settings', checkAuth, checkAdmin, (req, res) => {
        try {
            const password = (req.body?.Password || '').toString().trim();
            const row = db.prepare('SELECT ID FROM Report ORDER BY ID DESC LIMIT 1').get();

            if (row) db.prepare('UPDATE Report SET Password = ? WHERE ID = ?').run(password, row.ID);
            else db.prepare('INSERT INTO Report (Password) VALUES (?)').run(password);

            res.json({ success: true });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    app.post('/api/report/open-folder', checkAuth, checkAdmin, (req, res) => {
        try {
            const reportDir = path.join(rootDir, 'Report');
            const reportExcelDir = path.join(reportDir, 'Excel');
            const reportPdfDir = path.join(reportDir, 'DocumentiPDF');

            if (!fs.existsSync(reportDir)) fs.mkdirSync(reportDir, { recursive: true });
            if (!fs.existsSync(reportExcelDir)) fs.mkdirSync(reportExcelDir, { recursive: true });
            if (!fs.existsSync(reportPdfDir)) fs.mkdirSync(reportPdfDir, { recursive: true });

            const openCmd = process.platform === 'win32'
                ? `start "" "${reportDir}"`
                : process.platform === 'darwin'
                    ? `open "${reportDir}"`
                    : `xdg-open "${reportDir}"`;
            require('child_process').exec(openCmd);

            res.json({ success: true, folder: reportDir });
        } catch (e) {
            res.status(500).json({ success: false, error: e.message });
        }
    });

    app.post('/api/report/export-excel', checkAuth, checkAdmin, (req, res) => {
        try {
            const reportDir = path.join(rootDir, 'Report');
            const reportExcelDir = path.join(reportDir, 'Excel');
            if (!fs.existsSync(reportExcelDir)) fs.mkdirSync(reportExcelDir, { recursive: true });

            const rowsAgora = db.prepare(`
                SELECT
                    A.ID,
                    A.Data,
                    A.Evento,
                    A.ODG,
                    T.IntestazionePagina AS TipologiaEvento,
                    A.Verbale,
                    A.Documenti
                FROM Agora A
                LEFT JOIN AgoraTipoEvento T ON A.IDTipoEvento = T.ID
                ORDER BY A.Data DESC, A.ID DESC
            `).all();

            const rowsPresenti = db.prepare(`
                SELECT
                    P.IDRiunioni,
                    A.SOGGETTO AS Associazione,
                    P.Rappresentante
                FROM AgoraPresenti P
                JOIN Associazioni A ON P.IDAssociazione = A.ID
                ORDER BY P.IDRiunioni DESC, A.SOGGETTO ASC
            `).all();

            const rowsTipoEvento = db.prepare('SELECT ID, IntestazionePagina FROM AgoraTipoEvento ORDER BY ID ASC').all();
            const rowsTipoDocumento = db.prepare('SELECT ID, Tipo FROM DocumentoTipo ORDER BY Tipo ASC').all();

            const wb = XLSX.utils.book_new();
            XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rowsAgora), 'Agora');
            XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rowsPresenti), 'Presenti');
            XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rowsTipoEvento), 'TipiEvento');
            XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rowsTipoDocumento), 'TipiDocumento');

            const fileName = 'BaseDatiExcel.xlsx';
            const filePath = path.join(reportExcelDir, fileName);

            XLSX.writeFile(wb, filePath);

            res.json({
                success: true,
                fileName,
                filePath: path.join('Report', 'Excel', fileName)
            });
        } catch (e) {
            res.status(500).json({ success: false, error: e.message });
        }
    });
    
    // --- RUNTS & CESVOT ---
    app.get('/api/runts/search', checkAuth, (req, res) => {
        const {q,prov} = req.query; if(!q || q.length<3) return res.json([]);
        res.json(db.prepare(`SELECT * FROM Runts WHERE (Denominazione LIKE ? OR CodiceFiscale LIKE ? OR Cognome LIKE ?) AND (Provincia LIKE ? OR Provincia IS NULL OR ?='') LIMIT 20`).all(`%${q}%`,`${q}%`,`%${q}%`,`%${prov||''}%`,prov||''));
    });
    app.get('/api/runts/check/:id', checkAuth, (req, res) => {
        const row = db.prepare(`SELECT r.*, a.CODICEFISCALE as CF_Att, a.ID_TIPOLOGIA as Tipo_Att, a.SOGGETTO FROM Associazioni a LEFT JOIN Runts r ON (r.IDAssociazione=a.ID OR (a.CODICEFISCALE IS NOT NULL AND a.CODICEFISCALE<>'' AND r.CodiceFiscale=a.CODICEFISCALE)) WHERE a.ID=?`).get(req.params.id);
        if(!row) return res.json({status:'NOT_FOUND'}); if(!row.CodiceFiscale) return res.json({status:'MISSING'});
        const refs = db.prepare("SELECT Nome FROM Referenti WHERE ID_Associazione=?").all(req.params.id);
        const isRef = refs.some(r => r.Nome.toLowerCase().includes(row.Cognome?.toLowerCase()) || r.Nome.toLowerCase().includes(row.Nome?.toLowerCase()));
        if(row.CF_Att===row.CodiceFiscale && row.Tipo_Att===1 && (isRef || (!row.Cognome && !row.Nome))) res.json({status:'ON', runtsData:row});
        else res.json({status:'OFF', runtsData:row});
    });
    app.post('/api/runts/align/:id', checkAuth, checkAdmin, (req, res) => {
        const r = db.prepare("SELECT * FROM Runts WHERE CodiceFiscale=?").get(req.body.cfRunts);
        if(!r) return res.status(500).json({error:"Runts not found"});
        db.transaction(()=>{
            db.prepare("UPDATE Associazioni SET CODICEFISCALE=?, ID_TIPOLOGIA=1 WHERE ID=?").run(r.CodiceFiscale,req.params.id);
            db.prepare("UPDATE Runts SET IDAssociazione=? WHERE CodiceFiscale=?").run(req.params.id,r.CodiceFiscale);
            if(r.Cognome && r.Nome) {
                const f = `${r.Cognome} ${r.Nome}`;
                const ref = db.prepare("SELECT ID FROM Referenti WHERE ID_Associazione=? LIMIT 1").get(req.params.id);
                if(ref) db.prepare("UPDATE Referenti SET Nome=? WHERE ID=?").run(f,ref.ID);
                else db.prepare("INSERT INTO Referenti(ID_Associazione,Nome) VALUES(?,?)").run(req.params.id,f);
            }
        })();
        res.json({success:true});
    });

    // --- IMPORT RUNTS AVANZATO (VERIFICA NOME & REFERENTE) ---
    app.post('/api/import/runts', checkAuth, checkAdmin, uploadFields, (req, res) => {
        if(!req.files || !req.files['fileRunts']) return res.status(400).json({error:"No file"});
        const fp = req.files['fileRunts'][0].path;
        
        try {
            const wb = XLSX.readFile(fp, {codepage:65001});
            const data = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], {header:1});
            let changesLog = []; // Per il report PDF
            
            db.transaction(()=>{
                const stmtR = db.prepare("INSERT OR REPLACE INTO Runts (CodiceFiscale,Denominazione,Cognome,Nome,IDAssociazione) VALUES(?,?,?,?,?)");
                const stmtA = db.prepare("UPDATE Associazioni SET CODICEFISCALE=?, ID_TIPOLOGIA=1 WHERE ID=?");
                
                // Mappa per la ricerca rapida delle associazioni
                const assocByCF = {}; 
                const assocByName = {};
                const assocs = db.prepare("SELECT ID, CODICEFISCALE, SOGGETTO FROM Associazioni").all();
                
                assocs.forEach(a => {
                    if(a.CODICEFISCALE) assocByCF[a.CODICEFISCALE.trim()] = a.ID;
                    if(a.SOGGETTO) assocByName[a.SOGGETTO.trim().toUpperCase()] = a.ID;
                });

                for(let i=1; i<data.length; i++){
                    let row = data[i];
                    if(!row || row.length === 0) continue;
                    if(typeof row[0]==='string' && row[0].includes(';')) row = row[0].split(';');
                    const clean = s => s ? String(s).replace(/^"|"$/g,'').trim() : null;
                    
                    const cf = clean(row[0]);
                    const den = clean(row[2]);
                    const cog = clean(row[4]);
                    const nom = clean(row[5]);

                    // Salto se mancano i dati essenziali per l'identificazione
                    if(!cf && !den) continue;

                    // 1. RICERCA ASSOCIAZIONE ESISTENTE
                    // Prima priorità: Codice Fiscale
                    let idAssoc = null;
                    if(cf && assocByCF[cf]) {
                        idAssoc = assocByCF[cf];
                    } 
                    // Seconda priorità: Nome (se CF fallisce o manca)
                    else if(den && assocByName[den.toUpperCase()]) {
                        idAssoc = assocByName[den.toUpperCase()];
                    }

                    // 2. AGGIORNAMENTO TABELLA RUNTS (Solo se c'è CF)
                    if(cf) {
                        stmtR.run(cf, den, cog, nom, idAssoc);
                    }

                    // 3. AGGIORNAMENTO DATI ASSOCIAZIONE (Se trovata)
                    if(idAssoc) {
                        // Aggiorna CF e Tipo in Associazione (se il file ha il CF)
                        if(cf) stmtA.run(cf, idAssoc);
                        
                        // --- VERIFICA REFERENTE ---
                        if(cog && nom) {
                            const newRefName = `${cog} ${nom}`.trim();
                            // Cerco il referente ATTUALE nel DB
                            const currentRef = db.prepare("SELECT * FROM Referenti WHERE ID_Associazione=? LIMIT 1").get(idAssoc);
                            
                            if(!currentRef) {
                                // CASO 1: Referente Mancante -> AGGIUNGO
                                db.prepare("INSERT INTO Referenti(ID_Associazione,Nome) VALUES(?,?)").run(idAssoc, newRefName);
                                changesLog.push({
                                    assoc: den || "N/D",
                                    action: "AGGIUNTO",
                                    detail: `Referente: ${newRefName}`
                                });
                            } else {
                                // CASO 2: Referente Esistente -> CONFRONTO
                                // Normalizzo per evitare differenze di maiuscole/spazi
                                const currNorm = currentRef.Nome.trim().toUpperCase();
                                const newNorm = newRefName.toUpperCase();

                                if(currNorm !== newNorm) {
                                    // Sono diversi -> AGGIORNO
                                    db.prepare("UPDATE Referenti SET Nome=? WHERE ID=?").run(newRefName, currentRef.ID);
                                    changesLog.push({
                                        assoc: den || "N/D",
                                        action: "MODIFICATO",
                                        detail: `Ref: '${currentRef.Nome}' -> '${newRefName}'`
                                    });
                                }
                                // Se sono uguali, non faccio nulla.
                            }
                        }
                    }
                }
            })();

            // GENERAZIONE REPORT PDF
            const reportName = `Report_Import_Runts_${Date.now()}.pdf`;
            const reportPath = path.join(tempDir, reportName);
            const doc = new PDFDocument();
            const stream = fs.createWriteStream(reportPath);
            doc.pipe(stream);

            doc.fontSize(20).text('Report Importazione RUNTS', { align: 'center' });
            doc.moveDown();
            doc.fontSize(12).text(`Data Elaborazione: ${new Date().toLocaleString()}`);
            doc.text(`Totale Modifiche ai Referenti: ${changesLog.length}`);
            doc.moveDown();
            
            if(changesLog.length > 0) {
                changesLog.forEach(log => {
                    doc.fontSize(10).font('Helvetica-Bold').text(`Associazione: ${log.assoc}`);
                    
                    let color = 'black';
                    if(log.action === 'AGGIUNTO') color = 'green';
                    if(log.action === 'MODIFICATO') color = 'orange';

                    doc.fillColor(color).fontSize(10).font('Helvetica').text(`[${log.action}] ${log.detail}`);
                    doc.fillColor('black'); // Reset colore
                    doc.moveDown(0.5);
                });
            } else {
                doc.fontSize(12).text("Nessuna modifica necessaria. Tutti i referenti erano già allineati.", { align: 'center' });
            }

            doc.end();

            stream.on('finish', () => {
                deletePhysicalFile(fp);
                res.json({
                    success: true, 
                    message: `Importazione completata. Modifiche: ${changesLog.length}.`,
                    reportUrl: `/archivio_files/temp/${reportName}`
                });
            });

        } catch(e) { 
            deletePhysicalFile(fp); 
            res.status(500).json({error:e.message}); 
        }
    });

    // --- MAILING LIST ---
    app.get('/api/maillist', checkAuth, (req, res) => res.json(db.prepare("SELECT * FROM MailList ORDER BY Descrizione").all()));
    app.post('/api/maillist', checkAuth, checkAdmin, (req, res) => { try{res.json({success:true, id:db.prepare("INSERT INTO MailList(Descrizione,Note) VALUES(?,?)").run(req.body.Descrizione,req.body.Note).lastInsertRowid});}catch(e){res.status(500).json({error:e.message});} });
    app.delete('/api/maillist/:id', checkAuth, checkAdmin, (req, res) => { try{db.transaction(()=>{db.prepare("DELETE FROM ListaMail WHERE IDListaMail=?").run(req.params.id);db.prepare("DELETE FROM MailList WHERE ID=?").run(req.params.id);})();res.json({success:true});}catch(e){res.status(500).json({error:e.message});} });
    app.get('/api/maillist/:id/members', checkAuth, (req, res) => res.json(db.prepare(`SELECT lm.ID, lm.IDMail, lm.TipoInvio, m.Indirizzo, a.SOGGETTO FROM ListaMail lm JOIN Mail m ON lm.IDMail=m.ID JOIN Associazioni a ON m.IDAssociazione=a.ID WHERE lm.IDListaMail=? ORDER BY a.SOGGETTO`).all(req.params.id)));
    app.post('/api/maillist/:id/add', checkAuth, checkAdmin, (req, res) => {
        const {IDMail,TipoInvio,EmailRaw,IDAssociazione}=req.body; const idL=req.params.id;
        try {
            if(IDMail) res.json({success:true, lastID:db.prepare("INSERT OR IGNORE INTO ListaMail(IDListaMail,IDMail,TipoInvio) VALUES(?,?,?)").run(idL,IDMail,TipoInvio||'CCN').lastInsertRowid});
            else if(EmailRaw && IDAssociazione) {
                let m = db.prepare("SELECT ID FROM Mail WHERE IDAssociazione=? AND Indirizzo=?").get(IDAssociazione,EmailRaw);
                if(!m) m = {ID: db.prepare("INSERT INTO Mail(IDAssociazione,Indirizzo,PEC,Predefinito) VALUES(?,?,0,0)").run(IDAssociazione,EmailRaw).lastInsertRowid};
                res.json({success:true, lastID:db.prepare("INSERT OR IGNORE INTO ListaMail(IDListaMail,IDMail,TipoInvio) VALUES(?,?,?)").run(idL,m.ID,TipoInvio||'CCN').lastInsertRowid});
            } else res.status(400).json({error:"Dati mancanti"});
        } catch(e){res.status(500).json({error:e.message});}
    });
    app.delete('/api/maillist/member/:id', checkAuth, checkAdmin, (req, res) => { try{db.prepare("DELETE FROM ListaMail WHERE ID=?").run(req.params.id);res.json({success:true});}catch(e){res.status(500).json({error:e.message});} });
    app.get('/api/maillist/search/associazioni', checkAuth, (req, res) => {
        const {q,tipo} = req.query; if((!q || q.length<3) && !tipo) return res.json([]);
        let sql = `SELECT m.ID as IDMail, m.Indirizzo, m.Predefinito, a.ID as IDAssoc, a.SOGGETTO, a.ID_TIPOLOGIA FROM Mail m JOIN Associazioni a ON m.IDAssociazione=a.ID LEFT JOIN Referenti r ON a.ID=r.ID_Associazione LEFT JOIN AltriSoggetti s ON a.ID=s.ID_Associazione WHERE 1=1`;
        const params=[]; if(tipo){sql+=` AND a.ID_TIPOLOGIA=?`;params.push(tipo);} if(q){sql+=` AND (a.SOGGETTO LIKE ? OR r.Nome LIKE ? OR s.Nome LIKE ?)`;params.push(`%${q}%`,`%${q}%`,`%${q}%`);}
        res.json(db.prepare(sql+` GROUP BY m.ID ORDER BY a.SOGGETTO LIMIT 100`).all(...params));
    });

    // BACKUP
    app.get('/api/backup/db', checkAuth, checkAdmin, (req, res) => {
        const n = `backup_manuale_${Date.now()}.db`; const p = path.join(tempDir, n);
        db.backup(p).then(() => res.download(p, n, () => setTimeout(() => {if(fs.existsSync(p))fs.unlinkSync(p)},5000))).catch(e=>res.status(500).send(e.message));
    });
    app.get('/api/backup/excel', checkAuth, checkAdmin, (req, res) => {
        try {
            const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
            const wb = XLSX.utils.book_new();
            tables.forEach(t => {
                const rows = db.prepare(`SELECT * FROM "${t.name}"`).all();
                XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), t.name.substring(0,31));
            });
            const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
            
            // AUTODISTRUZIONE EXCEL (2 MINUTI)
            const excelName = `Backup_Full_${Date.now()}.xlsx`;
            
            res.setHeader('Content-Disposition', `attachment; filename="${excelName}"`);
            res.send(buffer);

        } catch(e) { res.status(500).send(e.message); }
    });

    const server = app.listen(port, () => {
        console.log(`\n=== GESTIONALE ATTIVO: http://localhost:${port} ===`);
        try { require('child_process').exec((process.platform=='darwin'?'open':process.platform=='win32'?'start':'xdg-open') + ' ' + `http://localhost:${port}`); } catch(e){}
    });

    const handleShutdown = (signal) => {
        if(isClosing) return; isClosing=true; console.log(`\n> Arresto per ${signal}`); chiudiTutto(); process.exit(0);
    };
    process.on('SIGINT', () => handleShutdown('SIGINT'));
    process.on('SIGBREAK', () => handleShutdown('SIGBREAK'));
    process.on('SIGHUP', () => handleShutdown('SIGHUP'));
    process.on('SIGTERM', () => handleShutdown('SIGTERM'));
    process.on('uncaughtException', (err) => { console.error('\n> CRASH:', err); chiudiTutto(); process.exit(1); });
    process.on('exit', () => { if(!isClosing) chiudiTutto(); });
}