const fs = require('fs');
const path = require('path');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const archiver = require('archiver');
const unzipper = require('unzipper');

module.exports = function (app, pluginContext) {
    const { getMemory, getUserDb, getEngine, getWsClients, authMiddleware } = pluginContext;

    // Use a hardcoded or configured secret, same as index.js
    const JWT_SECRET = process.env.JWT_SECRET || 'chatpulse_super_secret_key';

    // Resolve path to the shared uploads directory (server/public/uploads)
    const uploadsDir = path.join(__dirname, '..', '..', 'public', 'uploads');

    // ─── PRIVATE MULTER CONFIG FOR BACKUP UPLOADS ─────────────────────────
    const storage = multer.diskStorage({
        destination: function (req, file, cb) {
            const tempDir = path.join(uploadsDir, 'temp');
            if (!fs.existsSync(tempDir)) {
                fs.mkdirSync(tempDir, { recursive: true });
            }
            cb(null, tempDir);
        },
        filename: function (req, file, cb) {
            const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
            const ext = path.extname(file.originalname);
            cb(null, 'import-' + uniqueSuffix + ext);
        }
    });

    const fileFilter = (req, file, cb) => {
        const name = file.originalname.toLowerCase();
        if (name.endsWith('.db') || name.endsWith('.zip') ||
            file.mimetype === 'application/octet-stream' ||
            file.mimetype === 'application/x-sqlite3' ||
            file.mimetype === 'application/zip') {
            cb(null, true);
        } else {
            cb(new Error('Invalid file type. Only .db or .zip backups are allowed for import.'), false);
        }
    };

    const upload = multer({
        storage: storage,
        limits: { fileSize: 200 * 1024 * 1024 }, // 200MB limit (zip with images can be large)
        fileFilter: fileFilter
    });


    // ─── EXPORT: Download backup as .zip (DB + uploads) ──────────────────
    app.get('/api/system/export', async (req, res) => {
        try {
            const token = req.query.token;
            if (!token) return res.status(401).send('Unauthorized');
            const decoded = jwt.verify(token, JWT_SECRET);
            const userId = decoded.id;

            const db = getUserDb(userId);
            const dbPath = db.getDbPath(); // Use the correct path from db instance

            if (!fs.existsSync(dbPath)) return res.status(404).send('Database not found');

            // Force ALL WAL content into the main DB file for a fully up-to-date snapshot
            db.checkpoint();

            // Create a synchronous file copy — guaranteed to include all latest data
            const backupFileName = `chatpulse_backup_${userId}_${Date.now()}.db`;
            const backupDir = path.dirname(dbPath);
            const backupPath = path.join(backupDir, backupFileName);
            fs.copyFileSync(dbPath, backupPath);

            res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
            res.setHeader('Pragma', 'no-cache');
            res.setHeader('Expires', '0');
            res.setHeader('Content-Type', 'application/zip');
            res.setHeader('Content-Disposition', `attachment; filename="chatpulse_backup_${userId}_${Date.now()}.zip"`);

            // Stream a zip archive containing the DB and uploads folder
            const archive = archiver('zip', { zlib: { level: 5 } });

            archive.on('error', (err) => {
                console.error('[Backup] Archive error:', err);
                // Clean up temp backup
                if (fs.existsSync(backupPath)) fs.unlinkSync(backupPath);
                if (!res.headersSent) res.status(500).send('Archive creation failed');
            });

            archive.on('end', () => {
                // Clean up temp backup after archive is fully streamed
                if (fs.existsSync(backupPath)) fs.unlinkSync(backupPath);
            });

            archive.pipe(res);

            // Add the database backup file
            archive.file(backupPath, { name: 'chatpulse.db' });

            // Add all upload files (avatars, images, etc.)
            if (fs.existsSync(uploadsDir)) {
                archive.directory(uploadsDir, 'uploads', (entry) => {
                    // Skip the temp/ subdirectory
                    if (entry.name.startsWith('temp/') || entry.name.startsWith('temp\\')) {
                        return false;
                    }
                    return entry;
                });
            }

            await archive.finalize();
        } catch (e) {
            console.error('[Backup] Export error:', e);
            if (!res.headersSent) res.status(500).send(e.message);
        }
    });

    // ─── WIPE ALL DATA ────────────────────────────────────────────────────
    app.delete('/api/system/wipe', authMiddleware, async (req, res) => {
        try {
            const userId = req.user.id;
            const memory = getMemory(userId);

            const characters = req.db.getCharacters();
            for (const c of characters) {
                await memory.wipeIndex(c.id);
            }

            req.db.close();
            const dbPath = req.db.getDbPath();
            if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);

            const { userDbCache } = require('../../db');
            userDbCache.delete(userId);

            // Also clear engine cache so stale DB references are purged
            const { engineCache } = require('../../engine');
            const oldEngine = engineCache.get(userId);
            if (oldEngine && typeof oldEngine.stopAllTimers === 'function') {
                oldEngine.stopAllTimers();
            }
            engineCache.delete(userId);

            res.json({ success: true });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // ─── IMPORT DATABASE (supports .zip or raw .db) ──────────────────────
    app.post('/api/system/import', authMiddleware, upload.single('db_file'), async (req, res) => {
        try {
            if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

            const uploadedPath = req.file.path;
            const userId = req.user.id;
            const memory = getMemory(userId);
            const isZip = req.file.originalname.toLowerCase().endsWith('.zip') ||
                req.file.mimetype === 'application/zip';

            let dbFilePath = uploadedPath; // For raw .db, use directly
            let extractedDir = null;

            if (isZip) {
                // Extract zip to a temp directory
                extractedDir = uploadedPath + '_extracted';
                if (!fs.existsSync(extractedDir)) fs.mkdirSync(extractedDir, { recursive: true });

                await new Promise((resolve, reject) => {
                    fs.createReadStream(uploadedPath)
                        .pipe(unzipper.Extract({ path: extractedDir }))
                        .on('close', resolve)
                        .on('error', reject);
                });

                // Find the .db file inside the extracted directory
                const extractedDbPath = path.join(extractedDir, 'chatpulse.db');
                if (!fs.existsSync(extractedDbPath)) {
                    // Try finding any .db file
                    const files = fs.readdirSync(extractedDir);
                    const dbFile = files.find(f => f.endsWith('.db'));
                    if (dbFile) {
                        dbFilePath = path.join(extractedDir, dbFile);
                    } else {
                        cleanupTemp(uploadedPath, extractedDir);
                        return res.status(400).json({ error: 'No .db file found inside the zip archive.' });
                    }
                } else {
                    dbFilePath = extractedDbPath;
                }
            }

            // Validate SQLite Header
            const buffer = fs.readFileSync(dbFilePath);
            if (buffer.length < 100 || buffer.toString('utf8', 0, 15) !== 'SQLite format 3') {
                cleanupTemp(uploadedPath, extractedDir);
                return res.status(400).json({ error: 'Uploaded file is not a valid SQLite Database.' });
            }

            // Wipe existing memory indexes
            const characters = req.db.getCharacters();
            for (const c of characters) {
                await memory.wipeIndex(c.id);
            }

            const dbPath = req.db.getDbPath();

            // Checkpoint and close current DB
            try {
                await req.db.backup(dbPath + '.tmp');
            } catch (e) { }

            req.db.close();

            // Delete existing WAL and SHM files
            if (fs.existsSync(dbPath + '-wal')) fs.unlinkSync(dbPath + '-wal');
            if (fs.existsSync(dbPath + '-shm')) fs.unlinkSync(dbPath + '-shm');

            // Overwrite the database
            fs.copyFileSync(dbFilePath, dbPath);

            // Restore uploads (avatars) from zip if present
            if (isZip && extractedDir) {
                const extractedUploads = path.join(extractedDir, 'uploads');
                if (fs.existsSync(extractedUploads)) {
                    // Ensure target uploads dir exists
                    if (!fs.existsSync(uploadsDir)) {
                        fs.mkdirSync(uploadsDir, { recursive: true });
                    }
                    // Copy all files from extracted uploads to the real uploads dir
                    copyDirRecursive(extractedUploads, uploadsDir);
                    console.log('[Backup] Restored upload files (avatars, images) from backup.');
                }
            }

            // Clean up temp files
            cleanupTemp(uploadedPath, extractedDir);

            const { userDbCache } = require('../../db');
            userDbCache.delete(userId);

            // Also clear engine cache so stale DB references are purged
            const { engineCache } = require('../../engine');
            const oldEngine = engineCache.get(userId);
            if (oldEngine && typeof oldEngine.stopAllTimers === 'function') {
                oldEngine.stopAllTimers();
            }
            engineCache.delete(userId);

            res.json({ success: true });
        } catch (e) {
            console.error('[Backup] Import error:', e);
            res.status(500).json({ error: e.message });
        }
    });

    // ─── Helpers ─────────────────────────────────────────────────────────
    function cleanupTemp(filePath, dirPath) {
        try { if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch (e) { }
        try { if (dirPath && fs.existsSync(dirPath)) fs.rmSync(dirPath, { recursive: true, force: true }); } catch (e) { }
    }

    function copyDirRecursive(src, dest) {
        const entries = fs.readdirSync(src, { withFileTypes: true });
        for (const entry of entries) {
            const srcPath = path.join(src, entry.name);
            const destPath = path.join(dest, entry.name);
            if (entry.isDirectory()) {
                // Skip 'temp' directory
                if (entry.name === 'temp') continue;
                if (!fs.existsSync(destPath)) fs.mkdirSync(destPath, { recursive: true });
                copyDirRecursive(srcPath, destPath);
            } else {
                fs.copyFileSync(srcPath, destPath);
            }
        }
    }

    console.log('[Plugin] Loaded DLC: backup system');
};
