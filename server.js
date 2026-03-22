
// ============================================================================
// 1. CONFIGURAZIONE
// ============================================================================

    // --- SYNC EXCEL AGORA ---
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
const MAX_BACKUPS = 5;

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
// 2. MOTORE DI SICUREZZA (BACKUP & LOCK)
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

        const files = fs.readdirSync(pathBackupDir)
            .filter(f => f.endsWith('.bak'))
            .map(f => ({ name: f, path: path.join(pathBackupDir, f), time: fs.statSync(path.join(pathBackupDir, f)).mtime.getTime() }))
            .sort((a, b) => b.time - a.time);

        if (files.length > MAX_BACKUPS) {
            files.slice(MAX_BACKUPS).forEach(f => { try{fs.unlinkSync(f.path)}catch(e){} });
        }
    } catch (error) { console.error("> Warning Backup:", error.message); 
        
    }}


   function scriviLockInfo() {
    try { 
        const now = Date.now(); 
        fs.writeFileSync(pathLockInfo, JSON.stringify({ 
            user: MY_HOSTNAME, 
            timestamp: now,
            data_leggibile: new Date(now).toLocaleString() 
        }, null, 2)); 
    } catch (e) {
        console.error("ERRORE CRITICO SCRITTURA LOCK:", e.message);
    }
}

function leggiLockInfo() {
    if (!fs.existsSync(pathLockInfo)) return null;
    try { return JSON.parse(fs.readFileSync(pathLockInfo, 'utf8')); } catch (e) { return null; }
}

function avviaDatabaseInEsclusiva() {
    console.log(`\n--- AVVIO SISTEMA (${MY_HOSTNAME}) ---`);
    
    // Timeout di tolleranza
    const LOCK_TIMEOUT_MS = 120000; 

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
        const now = Date.now();
        
        // CASO 1: Sono io
        if (info && info.user === MY_HOSTNAME) {
            console.log("> Rilevato crash precedente (stesso PC). Ripristino sessione.");
            scriviLockInfo();
            dbIsLockedByMe = true;
        } 
        // CASO 2: Lock scaduto
        else if (info && (now - info.timestamp > LOCK_TIMEOUT_MS)) {
            console.log(`> ATTENZIONE: Lock di ${info.user} scaduto (${(now - info.timestamp)/1000}s fa).`);
            console.log("> ASSUMO IL CONTROLLO (Recovery).");
            scriviLockInfo(); 
            dbIsLockedByMe = true;
        }
        // CASO 3: Lock attivo di qualcun altro
        else {
            const chi = info ? info.user : "Sconosciuto";
            console.log(`\n!!! ACCESSO NEGATO !!!`);
            console.log(`Database in uso da: ${chi}`);
            console.log(`Se l'altro PC è spento, attendi 2 minuti e riprova.`);
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

        // STRUTTURA TABELLE
        database.exec(`
            CREATE TABLE IF NOT EXISTS Utenti (ID INTEGER PRIMARY KEY AUTOINCREMENT, Email TEXT UNIQUE, Password TEXT, Nome TEXT, Amministratore INTEGER DEFAULT 0);
            CREATE TABLE IF NOT EXISTS Tipologia (ID INTEGER PRIMARY KEY AUTOINCREMENT, Tipologia TEXT);
            CREATE TABLE IF NOT EXISTS Associazioni (ID INTEGER PRIMARY KEY AUTOINCREMENT, ID_TIPOLOGIA INTEGER, SOGGETTO TEXT, TAVOLO INTEGER DEFAULT 0, DIRETTIVO_DELEGAZIONE INTEGER DEFAULT 0, CODICEFISCALE TEXT, FOREIGN KEY(ID_TIPOLOGIA) REFERENCES Tipologia(ID));
            CREATE TABLE IF NOT EXISTS Mail (ID INTEGER PRIMARY KEY AUTOINCREMENT, IDAssociazione INTEGER, Indirizzo TEXT, PEC INTEGER DEFAULT 0, Predefinito INTEGER DEFAULT 0, FOREIGN KEY(IDAssociazione) REFERENCES Associazioni(ID) ON DELETE CASCADE);
            CREATE TABLE IF NOT EXISTS Telefono (ID INTEGER PRIMARY KEY AUTOINCREMENT, IDAssociazione INTEGER, Telefono TEXT, Predefinito INTEGER DEFAULT 0, FOREIGN KEY(IDAssociazione) REFERENCES Associazioni(ID) ON DELETE CASCADE);
            CREATE TABLE IF NOT EXISTS Referenti (ID INTEGER PRIMARY KEY AUTOINCREMENT, ID_Associazione INTEGER, Nome TEXT, MAILREFERENTE TEXT, FOREIGN KEY(ID_Associazione) REFERENCES Associazioni(ID) ON DELETE CASCADE);
            CREATE TABLE IF NOT EXISTS AltriSoggetti (ID INTEGER PRIMARY KEY AUTOINCREMENT, ID_Associazione INTEGER, Nome TEXT, MAILALTRISOGGETTI TEXT, FOREIGN KEY(ID_Associazione) REFERENCES Associazioni(ID) ON DELETE CASCADE);
            CREATE TABLE IF NOT EXISTS Runts (CodiceFiscale TEXT PRIMARY KEY, Denominazione TEXT, Cognome TEXT, Nome TEXT, IDAssociazione INTEGER, Provincia TEXT);
            CREATE TABLE IF NOT EXISTS CesvotMail (Mail TEXT);
            CREATE TABLE IF NOT EXISTS CesvotTelefono (Telefono TEXT);
            CREATE TABLE IF NOT EXISTS AgoraTipoEvento (ID INTEGER PRIMARY KEY AUTOINCREMENT, IntestazionePagina TEXT);
            CREATE TABLE IF NOT EXISTS Agora (ID INTEGER PRIMARY KEY AUTOINCREMENT, Data TEXT, Evento TEXT, ODG TEXT, Verbale TEXT, Documenti TEXT, IDTipoEvento INTEGER DEFAULT 1, FOREIGN KEY(IDTipoEvento) REFERENCES AgoraTipoEvento(ID));
            CREATE TABLE IF NOT EXISTS AgoraPresenti (ID INTEGER PRIMARY KEY AUTOINCREMENT, IDRiunioni INTEGER, IDAssociazione INTEGER, Rappresentante TEXT, FOREIGN KEY(IDRiunioni) REFERENCES Agora(ID) ON DELETE CASCADE, FOREIGN KEY(IDAssociazione) REFERENCES Associazioni(ID) ON DELETE CASCADE);
            CREATE TABLE IF NOT EXISTS MailList (ID INTEGER PRIMARY KEY AUTOINCREMENT, Descrizione TEXT, Note TEXT);
            CREATE TABLE IF NOT EXISTS ListaMail (ID INTEGER PRIMARY KEY AUTOINCREMENT, IDListaMail INTEGER, IDMail INTEGER, TipoInvio TEXT DEFAULT 'CCN', FOREIGN KEY(IDListaMail) REFERENCES MailList(ID) ON DELETE CASCADE, FOREIGN KEY(IDMail) REFERENCES Mail(ID) ON DELETE CASCADE, UNIQUE(IDListaMail, IDMail));
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
// 3. EXPRESS APP
// ============================================================================

const app = express();

// --- FIX REFRESH: DISABILITA CACHE BROWSER PER LE API ---
app.use((req, res, next) => {
    if (req.url.startsWith('/api/')) {
        res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
        res.set('Pragma', 'no-cache');
        res.set('Expires', '0');
    }
    next();
});

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

const deletePhysicalFile = (relPath) => {
    if(!relPath) return;
    const cleanRel = relPath.replace(/^(\/|\\)/, '').replace(/^(archivio_files[\/\\])/, '');
    const fullPath = path.join(uploadDir, cleanRel.replace('verbali/', 'verbali\\').replace('documenti/', 'documenti\\'));
    const fullPathB = path.join(rootDir, relPath.replace(/^\//, ''));
    if(fs.existsSync(fullPath)) try{fs.unlinkSync(fullPath);}catch(e){}
    else if(fs.existsSync(fullPathB)) try{fs.unlinkSync(fullPathB);}catch(e){}
};

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

['agora','gestione_associazioni','gestione_referenti','gestione_altri','anagrafica_singola','gestione_mailinglist','dashboard_servizi','gestione_utenti','anagrafica','agora_tipo_eventi'].forEach(p => {
    app.get(`/${p}`, (req, res) => {
        if(!req.session.userId) return res.redirect('/login.html');
        if(['dashboard_servizi','gestione_utenti','anagrafica','agora_tipo_eventi'].includes(p) && req.session.isAdmin !== 1) return res.redirect('/');
        res.sendFile(path.join(publicPath, p === 'agora' ? 'registro_agora.html' : `${p}.html`));
    });
    app.get(`/${p}.html`, (req, res) => res.redirect(`/${p}`));
});

// ============================================================================
// 4. API ENDPOINTS
// ============================================================================

db = avviaDatabaseInEsclusiva();

if (!db) {
    console.log("Premi CTRL+C per uscire...");
    setTimeout(() => process.exit(1), 20000);
} else {

    // --- HEARTBEAT ---
    setInterval(() => {
        if (dbIsLockedByMe) scriviLockInfo();
    }, 60000);

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

    // --- REFERENTI & ALTRI ---
    
    const getAllReferenti = () => db.prepare("SELECT r.*, a.SOGGETTO FROM Referenti r LEFT JOIN Associazioni a ON r.ID_Associazione=a.ID ORDER BY r.Nome").all();
    const getAllAltri = () => db.prepare("SELECT s.*, a.SOGGETTO FROM AltriSoggetti s LEFT JOIN Associazioni a ON s.ID_Associazione=a.ID ORDER BY s.Nome").all();

    app.get('/api/referenti', checkAuth, (req, res) => res.json(getAllReferenti()));
    app.get('/api/all-referenti', checkAuth, (req, res) => res.json(getAllReferenti()));

    app.post('/api/referenti', checkAuth, checkAdmin, (req, res) => { try{db.prepare("INSERT INTO Referenti(ID_Associazione,Nome,MAILREFERENTE) VALUES(?,?,?)").run(req.body.ID_Associazione,req.body.Nome,req.body.MAILREFERENTE);res.json({success:true});}catch(e){res.status(500).json({error:e.message});} });
    
    app.put('/api/referenti/:id', checkAuth, checkAdmin, (req, res) => {
        try {
            db.prepare("UPDATE Referenti SET ID_Associazione=?, Nome=?, MAILREFERENTE=? WHERE ID=?").run(req.body.ID_Associazione, req.body.Nome, req.body.MAILREFERENTE, req.params.id);
            res.json({success:true});
        } catch(e) { res.status(500).json({error:e.message}); }
    });

    app.delete('/api/referenti/:id', checkAuth, checkAdmin, (req, res) => { try{db.prepare("DELETE FROM Referenti WHERE ID=?").run(req.params.id);res.json({success:true});}catch(e){res.status(500).json({error:e.message});} });

    app.get('/api/altrisoggetti', checkAuth, (req, res) => res.json(getAllAltri()));
    app.get('/api/all-altri-soggetti', checkAuth, (req, res) => res.json(getAllAltri())); 
    app.get('/api/all-altri', checkAuth, (req, res) => res.json(getAllAltri()));        

    app.post('/api/altri-soggetti', checkAuth, checkAdmin, (req, res) => { try{db.prepare("INSERT INTO AltriSoggetti(ID_Associazione,Nome,MAILALTRISOGGETTI) VALUES(?,?,?)").run(req.body.ID_Associazione,req.body.Nome,req.body.MAILALTRISOGGETTI);res.json({success:true});}catch(e){res.status(500).json({error:e.message});} });
    
    app.put('/api/altri-soggetti/:id', checkAuth, checkAdmin, (req, res) => {
        try {
            db.prepare("UPDATE AltriSoggetti SET ID_Associazione=?, Nome=?, MAILALTRISOGGETTI=? WHERE ID=?").run(req.body.ID_Associazione, req.body.Nome, req.body.MAILALTRISOGGETTI, req.params.id);
            res.json({success:true});
        } catch(e) { res.status(500).json({error:e.message}); }
    });
    // Alias
    app.put('/api/altrisoggetti/:id', checkAuth, checkAdmin, (req, res) => {
        try {
            db.prepare("UPDATE AltriSoggetti SET ID_Associazione=?, Nome=?, MAILALTRISOGGETTI=? WHERE ID=?").run(req.body.ID_Associazione, req.body.Nome, req.body.MAILALTRISOGGETTI, req.params.id);
            res.json({success:true});
        } catch(e) { res.status(500).json({error:e.message}); }
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

    // --- AGORA MAILING LIST ---
    app.get('/api/agora/:id/mailinglist', checkAuth, (req, res) => {
        try {
            const eventId = req.params.id;
            // 1. Recupera tutte le associazioni presenti all'evento
            const participants = db.prepare(`
                SELECT P.IDAssociazione, A.SOGGETTO, P.Rappresentante
                FROM AgoraPresenti P 
                JOIN Associazioni A ON P.IDAssociazione = A.ID 
                WHERE P.IDRiunioni = ?
            `).all(eventId);

            const emailsFound = [];
            const missing = [];

            // 2. Per ogni associazione, cerca le email nelle tre fonti
            for (const p of participants) {
                // Cerca solo email istituzionale dell'associazione
                const mails = db.prepare("SELECT Indirizzo, PEC FROM Mail WHERE IDAssociazione = ?").all(p.IDAssociazione);
                let mailAssociazione = mails.filter(m => m.Indirizzo).sort((a, b) => (a.PEC || 0) - (b.PEC || 0))[0];

                // Cerca mail personale del rappresentante (se presente)
                let mailPersonale = null;
                if (p.Rappresentante) {
                    const ref = db.prepare("SELECT MAILREFERENTE FROM Referenti WHERE Nome = ? AND ID_Associazione = ?").get(p.Rappresentante, p.IDAssociazione);
                    if (ref && ref.MAILREFERENTE) mailPersonale = ref.MAILREFERENTE;
                }

                if (mailAssociazione || mailPersonale) {
                    emailsFound.push({
                        email: mailAssociazione ? mailAssociazione.Indirizzo : '',
                        tipo: mailAssociazione && mailAssociazione.PEC === 1 ? 'PEC' : 'Mail',
                        fonte: 'Associazione',
                        soggetto: p.SOGGETTO,
                        rappresentante: p.Rappresentante || '',
                        mailPersonale: mailPersonale || ''
                    });
                } else {
                    missing.push({ soggetto: p.SOGGETTO, rappresentante: p.Rappresentante || '' });
                }
            }

            // Recupera dati evento
            const evento = db.prepare("SELECT Data, Evento FROM Agora WHERE ID = ?").get(eventId) || { Data: '', Evento: '' };

            res.json({
                success: true,
                data: {
                    evento: { data: evento.Data, titolo: evento.Evento },
                    partecipantiConEmail: emailsFound,
                    partecipantiSenzaEmail: missing
                }
            });
        } catch (e) {
            console.error("Errore recupero mailing list agorà:", e);
            res.status(500).json({ error: e.message });
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
                doc.fillColor('black').fontSize(12).font('Helvetica-Bold').text(`Data: ${ev.Data} - ${ev.Evento}`); if (ev.ODG) doc.fontSize(10).font('Helvetica-Oblique').text(`ODG: ${ev.ODG}`, { indent: 10 }); doc.moveDown(0.5);
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
                if (ev.ODG) doc.fontSize(10).font('Helvetica-Oblique').text(`ODG: ${ev.ODG}`, { indent: 10 });
                
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
    
    // --- RUNTS ---
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
    app.post('/api/import/runts', checkAuth, checkAdmin, uploadFields, (req, res) => {
        if(!req.files || !req.files['fileRunts']) return res.status(400).json({error:"No file"});
        const fp = req.files['fileRunts'][0].path;
        try {
            const assocMap = {}; db.prepare("SELECT ID,SOGGETTO FROM Associazioni").all().forEach(r=>{if(r.SOGGETTO)assocMap[r.SOGGETTO.trim()]=r.ID});
            const wb = XLSX.readFile(fp, {codepage:65001});
            const data = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], {header:1});
            let count=0;
            db.transaction(()=>{
                const stmtR = db.prepare("INSERT OR REPLACE INTO Runts (CodiceFiscale,Denominazione,Cognome,Nome,IDAssociazione) VALUES(?,?,?,?,?)");
                const stmtA = db.prepare("UPDATE Associazioni SET CODICEFISCALE=?, ID_TIPOLOGIA=1 WHERE ID=?");
                for(let i=1;i<data.length;i++){
                    let row=data[i]; if(!row || row.length===0) continue;
                    if(typeof row[0]==='string' && row[0].includes(';')) row=row[0].split(';');
                    const clean=s=>s?String(s).replace(/^"|"$/g,'').trim():null;
                    const cf=clean(row[0]), den=clean(row[2]), cog=clean(row[4]), nom=clean(row[5]);
                    if(cf) {
                        const idAssoc = den && assocMap[den] ? assocMap[den] : null;
                        stmtR.run(cf,den,cog,nom,idAssoc);
                        if(idAssoc) { stmtA.run(cf,idAssoc); count++; }
                    }
                }
            })();
            deletePhysicalFile(fp); res.json({success:true, message:`Importati ${count}`});
        } catch(e) { deletePhysicalFile(fp); res.status(500).json({error:e.message}); }
    });

    // --- MAILING LIST ---
        app.put('/api/maillist/member/:id', checkAuth, checkAdmin, (req, res) => {
            try {
                db.prepare("UPDATE ListaMail SET TipoInvio = ? WHERE ID = ?").run(req.body.TipoInvio, req.params.id);
                res.json({ success: true });
            } catch (e) {
                res.status(500).json({ error: e.message });
            }
        });
    app.get('/api/maillist', checkAuth, (req, res) => res.json(db.prepare("SELECT * FROM MailList ORDER BY Descrizione").all()));
    app.post('/api/maillist', checkAuth, checkAdmin, (req, res) => {
        try {
            const { Descrizione, Note, emails } = req.body;
            // 1. Verifica se la lista esiste già
            let lista = db.prepare("SELECT ID FROM MailList WHERE Descrizione = ?").get(Descrizione);
            let idLista;
            if (lista) {
                // Se esiste, aggiorna Note se fornito
                idLista = lista.ID;
                if (Note !== undefined) {
                    db.prepare("UPDATE MailList SET Note = ? WHERE ID = ?").run(Note, idLista);
                }
            } else {
                // Se non esiste, crea la mailing list
                const result = db.prepare("INSERT INTO MailList(Descrizione,Note) VALUES(?,?)").run(Descrizione, Note);
                idLista = result.lastInsertRowid;
            }
            let added = 0, skipped = 0;
            if (Array.isArray(emails)) {
                for (const email of emails) {
                    if (!email || typeof email !== 'string') continue;
                    // Cerca se la mail esiste già in Mail
                    let mail = db.prepare("SELECT ID FROM Mail WHERE Indirizzo = ?").get(email);
                    if (!mail) {
                        // Non inserire la mail se non puoi fornire un IDAssociazione valido
                        skipped++;
                        continue;
                    }
                    // Inserisci in ListaMail (ignora se già presente)
                    try {
                        db.prepare("INSERT OR IGNORE INTO ListaMail(IDListaMail, IDMail, TipoInvio) VALUES (?, ?, 'CCN')").run(idLista, mail.ID);
                        added++;
                    } catch { skipped++; }
                }
            }
            res.json({ success: true, id: idLista, added, skipped, updated: !!lista });
        } catch(e) {
            res.status(500).json({ error: e.message });
        }
    });
    app.delete('/api/maillist/:id', checkAuth, checkAdmin, (req, res) => { try{db.transaction(()=>{db.prepare("DELETE FROM ListaMail WHERE IDListaMail=?").run(req.params.id);db.prepare("DELETE FROM MailList WHERE ID=?").run(req.params.id);})();res.json({success:true});}catch(e){res.status(500).json({error:e.message});} });
    app.get('/api/maillist/:id/members', checkAuth, (req, res) => res.json(db.prepare(`SELECT lm.ID, lm.IDMail, lm.TipoInvio, m.Indirizzo, a.SOGGETTO, m.Predefinito FROM ListaMail lm JOIN Mail m ON lm.IDMail=m.ID JOIN Associazioni a ON m.IDAssociazione=a.ID WHERE lm.IDListaMail=? ORDER BY a.SOGGETTO`).all(req.params.id)));
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
        const term = `%${q||''}%`;
        let whereTipo = tipo ? ` AND a.ID_TIPOLOGIA = ?` : '';
        let params = tipo ? [tipo, term, term, term, term, term, term, term, term] : [term, term, term, term, term, term, term, term];
        const sql = `
            SELECT m.ID as IDMail, m.Indirizzo, m.Predefinito, a.ID as IDAssoc, a.SOGGETTO, a.ID_TIPOLOGIA, NULL as Fonte, NULL as Ruolo
            FROM Mail m 
            JOIN Associazioni a ON m.IDAssociazione=a.ID 
            WHERE (a.SOGGETTO LIKE ? OR m.Indirizzo LIKE ?)
            ${whereTipo}
            
            UNION ALL
            
            SELECT NULL as IDMail, r.MAILREFERENTE as Indirizzo, 0 as Predefinito, a.ID as IDAssoc, a.SOGGETTO, a.ID_TIPOLOGIA, r.Nome as Fonte, 'Legale' as Ruolo
            FROM Referenti r 
            JOIN Associazioni a ON r.ID_Associazione = a.ID 
            WHERE r.MAILREFERENTE IS NOT NULL AND r.MAILREFERENTE <> '' 
            AND (a.SOGGETTO LIKE ? OR r.Nome LIKE ? OR r.MAILREFERENTE LIKE ?)
            ${whereTipo}
            
            UNION ALL
            
            SELECT NULL as IDMail, s.MAILALTRISOGGETTI as Indirizzo, 0 as Predefinito, a.ID as IDAssoc, a.SOGGETTO, a.ID_TIPOLOGIA, s.Nome as Fonte, 'Altro' as Ruolo
            FROM AltriSoggetti s 
            JOIN Associazioni a ON s.ID_Associazione = a.ID 
            WHERE s.MAILALTRISOGGETTI IS NOT NULL AND s.MAILALTRISOGGETTI <> '' 
            AND (a.SOGGETTO LIKE ? OR s.Nome LIKE ? OR s.MAILALTRISOGGETTI LIKE ?)
            ${whereTipo}
            
            ORDER BY a.SOGGETTO ASC, Fonte ASC
            LIMIT 100
        `;
        res.json(db.prepare(sql).all(...params));
    });

    // NUOVA RICERCA UNIFICATA (Aggiornamento Richiesto)
    app.get('/api/maillist/search/unified', checkAuth, (req, res) => {
        const { q } = req.query;
        if (!q || q.length < 3) return res.json([]);

        const term = `%${q}%`;
        
        const sql = `
            SELECT 
                m.ID as IDMail,
                m.Indirizzo, 
                a.ID as IDAssociazione, 
                a.SOGGETTO, 
                'Associazione' as Fonte,
                m.Predefinito
            FROM Mail m 
            JOIN Associazioni a ON m.IDAssociazione = a.ID 
            WHERE (a.SOGGETTO LIKE ? OR m.Indirizzo LIKE ?)
            
            UNION ALL
            
            SELECT 
                NULL as IDMail,
                r.MAILREFERENTE as Indirizzo, 
                a.ID as IDAssociazione, 
                a.SOGGETTO, 
                'Referente: ' || r.Nome as Fonte,
                0 as Predefinito
            FROM Referenti r 
            JOIN Associazioni a ON r.ID_Associazione = a.ID 
            WHERE r.MAILREFERENTE IS NOT NULL AND r.MAILREFERENTE <> '' 
            AND (a.SOGGETTO LIKE ? OR r.Nome LIKE ? OR r.MAILREFERENTE LIKE ?)
            
            UNION ALL
            
            SELECT 
                NULL as IDMail,
                s.MAILALTRISOGGETTI as Indirizzo, 
                a.ID as IDAssociazione, 
                a.SOGGETTO, 
                'Altro: ' || s.Nome as Fonte,
                0 as Predefinito
            FROM AltriSoggetti s 
            JOIN Associazioni a ON s.ID_Associazione = a.ID 
            WHERE s.MAILALTRISOGGETTI IS NOT NULL AND s.MAILALTRISOGGETTI <> '' 
            AND (a.SOGGETTO LIKE ? OR s.Nome LIKE ? OR s.MAILALTRISOGGETTI LIKE ?)
            
            ORDER BY SOGGETTO ASC, Fonte ASC
            LIMIT 100
        `;

        try {
            // Parametri: 2 per Associazione, 3 per Referente, 3 per Altri = 8 totali
            const rows = db.prepare(sql).all(term, term, term, term, term, term, term, term);
            res.json(rows);
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
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
            res.setHeader('Content-Disposition', `attachment; filename="Backup_Full_${Date.now()}.xlsx"`);
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
    // --- EXPORT AGORA EXCEL SOLO FOGLI INTERESSATI ---
    app.post('/api/export/agora-excel', checkAuth, checkAdmin, (req, res) => {
        try {
            const excelPath = path.join(rootDir, 'Report', 'Excel', 'BaseDatiExcel.xlsx');
            let wb;
            if (fs.existsSync(excelPath)) {
                wb = XLSX.readFile(excelPath, {codepage:65001});
            } else {
                wb = XLSX.utils.book_new();
            }
            // Nomi fogli da aggiornare
            const fogli = [
                {nome: 'agora', sql: 'SELECT * FROM Agora'},
                {nome: 'agorapresenti', sql: 'SELECT * FROM AgoraPresenti'},
                {nome: 'agoratipoevento', sql: 'SELECT * FROM AgoraTipoEvento'},
                {nome: 'associazioni', sql: 'SELECT * FROM Associazioni'}
            ];
            // Rimuovi i fogli da aggiornare se già presenti
            fogli.forEach(f => { if (wb.Sheets[f.nome]) delete wb.Sheets[f.nome]; });
            wb.SheetNames = wb.SheetNames.filter(n => !fogli.some(f => f.nome === n));
            // Aggiungi i fogli aggiornati
            fogli.forEach(f => {
                const rows = db.prepare(f.sql).all();
                XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), f.nome);
            });
            XLSX.writeFile(wb, excelPath);

            // --- Copia file collegati in Report/DocumentiPDF ---
            const destDir = path.join(rootDir, 'Report', 'DocumentiPDF');
            if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, {recursive:true});
            const agoraRows = db.prepare('SELECT Verbale, Documenti FROM Agora').all();
            const filesToCopy = [];
            agoraRows.forEach(row => {
                [row.Verbale, row.Documenti].forEach(f => {
                    if (f && typeof f === 'string' && f.trim()) filesToCopy.push(f);
                });
            });
            filesToCopy.forEach(relPath => {
                let src = relPath;
                if (src.startsWith('/')) src = src.substring(1);
                const fullSrc = path.join(rootDir, src.replace(/\//g, path.sep));
                if (fs.existsSync(fullSrc)) {
                    const dest = path.join(destDir, path.basename(fullSrc));
                    try { fs.copyFileSync(fullSrc, dest); } catch(e){}
                }
            });

            // Elimina file orfani in DocumentiPDF
            const keepNames = filesToCopy.map(relPath => path.basename(relPath));
            fs.readdirSync(destDir).forEach(file => {
                if (!keepNames.includes(file)) {
                    try { fs.unlinkSync(path.join(destDir, file)); } catch(e){}
                }
            });

            res.json({success:true, message:'Esportazione completata, file PDF aggiornati'});
        } catch(e) {
            res.status(500).json({error:e.message});
        }
    });

    // --- SYNC EXCEL AGORA ---
    app.post('/api/report/sync-excel-agora', checkAuth, checkAdmin, (req, res) => {
        try {
            const excelPath = path.join(rootDir, 'Report', 'Excel', 'BaseDatiExcel.xlsx');
            if (!fs.existsSync(excelPath)) return res.status(404).json({error:'File Excel non trovato'});
            const wb = XLSX.readFile(excelPath, {codepage:65001});
            const fogli = [
                {nome: 'agora', tab: 'Agora'},
                {nome: 'agorapresenti', tab: 'AgoraPresenti'},
                {nome: 'agoratipoevento', tab: 'AgoraTipoEvento'},
                {nome: 'associazioni', tab: 'Associazioni'}
            ];
            db.transaction(() => {
                fogli.forEach(f => {
                    if (!wb.Sheets[f.nome]) return;
                    const rows = XLSX.utils.sheet_to_json(wb.Sheets[f.nome]);
                    if (!Array.isArray(rows) || rows.length === 0) return;
                    // Svuota la tabella
                    db.prepare(`DELETE FROM ${f.tab}`).run();
                    // Ricava colonne
                    const cols = Object.keys(rows[0]);
                    const placeholders = cols.map(() => '?').join(',');
                    const insert = db.prepare(`INSERT INTO ${f.tab} (${cols.join(',')}) VALUES (${placeholders})`);
                    rows.forEach(r => insert.run(...cols.map(c => r[c])));
                });
            })();
            res.json({success:true, message:'Sincronizzazione completata'});
        } catch(e) {
            res.status(500).json({error:e.message});
        }
    });
    // --- PASSWORD AREA ---
    // GET: Recupera la lista delle password area (esempio base, personalizza secondo necessità)
    app.get('/api/report/password-area', checkAuth, checkAdmin, (req, res) => {
        try {
            const excelPath = path.join(rootDir, 'Report', 'Excel', 'BaseDatiExcel.xlsx');
            if (!fs.existsSync(excelPath)) {
                return res.json({ success: false, error: 'File Excel non trovato' });
            }
            const wb = XLSX.readFile(excelPath, { codepage: 65001 });
            const ws = wb.Sheets['report'] || wb.Sheets[wb.SheetNames[0]];
            if (!ws) return res.json({ success: false, error: 'Foglio report non trovato' });
            const password = ws['B2'] ? ws['B2'].v : '';
            res.json({ success: true, password });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });
    // POST: Modifica la password di un utente (esempio base, personalizza secondo necessità)
    app.post('/api/report/password-area', checkAuth, checkAdmin, (req, res) => {
        const { password } = req.body;
        if (!password) return res.status(400).json({ error: 'Password mancante' });
        try {
            const excelPath = path.join(rootDir, 'Report', 'Excel', 'BaseDatiExcel.xlsx');
            if (!fs.existsSync(excelPath)) {
                return res.status(400).json({ error: 'File Excel non trovato' });
            }
            const wb = XLSX.readFile(excelPath, { codepage: 65001 });
            const ws = wb.Sheets['report'] || wb.Sheets[wb.SheetNames[0]];
            if (!ws) return res.status(400).json({ error: 'Foglio report non trovato' });
            ws['B2'] = { t: 's', v: password };
            XLSX.writeFile(wb, excelPath);
            res.json({ success: true });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });
}
