require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const { join } = require('path');
const cookieParser = require('cookie-parser');
const crypto = require('crypto');

function startWebServer(client, activeRecordings, TALKS_DIR) {
    const app = express();
    const webPort = parseInt(process.env.PORT) || 8080;
    const webHost = process.env.WEB_HOST || '0.0.0.0';
    const webUsername = process.env.WEB_USERNAME || 'admin';
    const webPassword = process.env.WEB_PASSWORD || 'admin123';

    if (webUsername === 'admin' && webPassword === 'admin123') {
        console.warn('[WARN] Default credentials! Set WEB_USERNAME and WEB_PASSWORD in .env');
    }

    app.use(express.json());
    app.use(express.urlencoded({ extended: true }));
    app.use(cookieParser());
    app.use(express.static(path.join(__dirname, '..', 'public')));

    // Persistent session store
    const SESSIONS_FILE = join(__dirname, '..', 'sessions.json');
    let sessions = {};
    const SESSION_MAX_AGE = 7 * 24 * 60 * 60 * 1000; // 7 days
    const SESSION_CLEANUP_INTERVAL = 60 * 60 * 1000; // 1 hour

    // Load existing sessions from disk
    function loadSessions() {
        try {
            if (fs.existsSync(SESSIONS_FILE)) {
                const data = fs.readFileSync(SESSIONS_FILE, 'utf-8');
                sessions = JSON.parse(data);
                // Clean expired sessions on load
                const now = Date.now();
                let cleaned = 0;
                for (const token in sessions) {
                    if (now - sessions[token].created > SESSION_MAX_AGE) {
                        delete sessions[token];
                        cleaned++;
                    }
                }
                if (cleaned > 0) saveSessions();
                console.log(`[Sessions] ${Object.keys(sessions).length} geladen, ${cleaned} abgelaufen entfernt`);
            }
        } catch (err) {
            sessions = {};
        }
    }

    function saveSessions() {
        try {
            fs.writeFileSync(SESSIONS_FILE, JSON.stringify(sessions, null, 2), 'utf-8');
        } catch (err) {
            console.error('[Fehler] Sessions speichern:', err.message);
        }
    }

    loadSessions();

    // Cleanup expired sessions periodically
    function cleanupExpiredSessions() {
        const now = Date.now();
        let cleaned = 0;
        for (const token in sessions) {
            if (now - sessions[token].created > SESSION_MAX_AGE) {
                delete sessions[token];
                cleaned++;
            }
        }
        if (cleaned > 0) saveSessions();
    }

    setInterval(cleanupExpiredSessions, SESSION_CLEANUP_INTERVAL);

    function createSession(username) {
        const token = crypto.randomBytes(32).toString('hex');
        sessions[token] = { username, created: Date.now() };
        saveSessions();
        return token;
    }

    function getSession(req) {
        const token = req.cookies?.session;
        if (!token || !sessions[token]) return null;
        const session = sessions[token];
        if (Date.now() - session.created > SESSION_MAX_AGE) {
            delete sessions[token];
            saveSessions();
            return null;
        }
        return session;
    }

    function requireAuth(req, res, next) {
        if (getSession(req)) return next();
        const publicPaths = ['/login', '/api/login', '/health', '/css', '/js'];
        if (publicPaths.some(p => req.path === p || req.path.startsWith(p + '/')) || req.path === '/favicon.ico') {
            return next();
        }
        if (req.path.startsWith('/api/')) {
            return res.status(401).json({ error: 'Nicht angemeldet' });
        }
        return res.redirect('/login');
    }

    app.use(requireAuth);

    // Health endpoint
    app.get('/health', (req, res) => {
        res.json({
            status: 'healthy',
            bot: client.user ? client.user.tag : 'offline',
            recordings: activeRecordings.size,
            uptime: process.uptime()
        });
    });

    function getRecordingFolders() {
        if (!fs.existsSync(TALKS_DIR)) return [];
        const entries = fs.readdirSync(TALKS_DIR, { withFileTypes: true });
        const folders = [];
        for (const entry of entries) {
            if (entry.isDirectory()) {
                const folderPath = join(TALKS_DIR, entry.name);
                const files = fs.readdirSync(folderPath);
                const wavFiles = files.filter(f => f.endsWith('.wav')).map(f => ({
                    name: f,
                    size: fs.statSync(join(folderPath, f)).size,
                    url: `/api/download/${encodeURIComponent(entry.name)}/${encodeURIComponent(f)}`
                }));
                const stats = fs.statSync(folderPath);
                folders.push({
                    name: entry.name,
                    created: stats.birthtime,
                    fileCount: wavFiles.length,
                    totalSize: wavFiles.reduce((sum, f) => sum + f.size, 0),
                    files: wavFiles
                });
            }
        }
        folders.sort((a, b) => new Date(b.created) - new Date(a.created));
        return folders;
    }

    // Login page
    app.get('/login', (req, res) => {
        if (getSession(req)) return res.redirect('/');
        res.sendFile(path.join(__dirname, '..', 'public', 'login.html'));
    });

    // Login API
    app.post('/api/login', (req, res) => {
        const { username, password } = req.body;
        if (!username || !password) {
            return res.status(400).json({ success: false, error: 'Benutzername und Passwort erforderlich' });
        }
        if (username === webUsername && password === webPassword) {
            const token = createSession(username);
            const isHttps = req.protocol === 'https' || req.get('x-forwarded-proto') === 'https';
            res.cookie('session', token, {
                httpOnly: true,
                secure: isHttps,
                sameSite: 'lax',
                maxAge: SESSION_MAX_AGE,
                path: '/'
            });
            return res.json({ success: true });
        }
        res.status(401).json({ success: false, error: 'Falsche Anmeldedaten' });
    });

    // Logout
    app.post('/api/logout', (req, res) => {
        const token = req.cookies?.session;
        if (token && sessions[token]) {
            delete sessions[token];
            saveSessions();
        }
        res.clearCookie('session');
        res.json({ success: true });
    });

    // API: Recordings
    app.get('/api/recordings', (req, res) => {
        const folders = getRecordingFolders();
        res.json({ folders, recordings: activeRecordings.size > 0, activeRecordings: activeRecordings.size });
    });

    // API: Status
    app.get('/api/status', (req, res) => {
        res.json({
            bot: client.user ? client.user.tag : 'offline',
            guilds: client.guilds.cache.size,
            activeRecordings: activeRecordings.size,
            uptime: process.uptime(),
            folders: getRecordingFolders().length
        });
    });

    // API: Download single file
    app.get('/api/download/:folder/:file', (req, res) => {
        const folder = req.params.folder;
        const file = req.params.file;
        const filePath = join(TALKS_DIR, folder, file);
        const realPath = path.resolve(filePath);
        const realDir = path.resolve(TALKS_DIR);
        if (!realPath.startsWith(realDir)) {
            return res.status(403).json({ error: 'Zugriff verweigert' });
        }
        if (!fs.existsSync(filePath)) {
            return res.status(404).json({ error: 'Datei nicht gefunden' });
        }
        const safeFile = path.basename(file);
        res.setHeader('Content-Disposition', `attachment; filename="${safeFile}"`);
        res.setHeader('Content-Type', 'audio/wav');
        res.setHeader('Content-Length', fs.statSync(filePath).size);
        const stream = fs.createReadStream(filePath);
        stream.on('error', () => {
            if (!res.headersSent) res.status(500).json({ error: 'Lesefehler' });
        });
        stream.pipe(res);
    });

    // API: Download all files in folder
    app.get('/api/download-all/:folder', (req, res) => {
        const folder = req.params.folder;
        const folderPath = join(TALKS_DIR, folder);
        const realPath = path.resolve(folderPath);
        const realDir = path.resolve(TALKS_DIR);
        if (!realPath.startsWith(realDir)) {
            return res.status(403).json({ error: 'Zugriff verweigert' });
        }
        if (!fs.existsSync(folderPath)) {
            return res.status(404).json({ error: 'Ordner nicht gefunden' });
        }
        const files = fs.readdirSync(folderPath).filter(f => f.endsWith('.wav'));
        if (files.length === 0) {
            return res.status(404).json({ error: 'Keine WAV-Dateien' });
        }
        if (files.length === 1) {
            const filePath = join(folderPath, files[0]);
            const safeFile = path.basename(files[0]);
            res.setHeader('Content-Disposition', `attachment; filename="${safeFile}"`);
            res.setHeader('Content-Type', 'audio/wav');
            const stream = fs.createReadStream(filePath);
            stream.on('error', () => {
                if (!res.headersSent) res.status(500).json({ error: 'Lesefehler' });
            });
            stream.pipe(res);
        } else {
            res.json({
                folder,
                files: files.map(f => ({ name: f, url: `/api/download/${encodeURIComponent(folder)}/${encodeURIComponent(f)}` }))
            });
        }
    });

    // API 404 handler
    app.get('/api/*', (req, res) => {
        res.status(404).json({ error: 'Endpunkt nicht gefunden' });
    });

    // SPA catch-all
    app.get('*', (req, res) => {
        res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
    });

    app.listen(webPort, webHost, () => {
        console.log(`[Web] Portal: http://${webHost}:${webPort}`);
    });
}

module.exports = startWebServer;
