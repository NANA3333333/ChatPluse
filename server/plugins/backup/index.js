const fs = require('fs');
const path = require('path');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const archiver = require('archiver');
const unzipper = require('unzipper');

module.exports = function (app, pluginContext) {
    const { getMemory, getUserDb, getEngine, getWsClients, authMiddleware, JWT_SECRET } = pluginContext;
    const { clearMemoryCache } = require('../../memory');
    const { closeSchedulerDb } = require('../scheduler/db');

    // Resolve path to the shared uploads directory (server/public/uploads)
    const uploadsDir = path.join(__dirname, '..', '..', 'public', 'uploads');
    const tempUploadsDir = path.join(uploadsDir, 'temp');

    const toUploadRelativePath = (value) => {
        const raw = String(value || '').trim();
        if (!raw) return null;
        const marker = '/uploads/';
        const markerIdx = raw.indexOf(marker);
        if (markerIdx >= 0) {
            return raw.slice(markerIdx + 1).replaceAll('/', path.sep);
        }
        if (raw.startsWith('uploads/')) {
            return raw.replaceAll('/', path.sep);
        }
        return null;
    };

    const collectUploadReferences = (userDb, sql, mapper = (row) => Object.values(row || {})) => {
        const refs = new Set();
        try {
            const rows = userDb.prepare(sql).all();
            for (const row of rows) {
                for (const value of mapper(row)) {
                    const relPath = toUploadRelativePath(value);
                    if (relPath) refs.add(relPath);
                }
            }
        } catch (e) { }
        return refs;
    };

    const getReferencedUploadsForUser = (dbInstance) => {
        const rawDb = typeof dbInstance?.getRawDb === 'function' ? dbInstance.getRawDb() : null;
        if (!rawDb) return [];
        return Array.from(new Set([
            ...collectUploadReferences(rawDb, 'SELECT avatar, banner FROM user_profile'),
            ...collectUploadReferences(rawDb, 'SELECT avatar FROM characters'),
            ...collectUploadReferences(rawDb, 'SELECT avatar FROM group_chats'),
            ...collectUploadReferences(rawDb, 'SELECT image_url FROM moments'),
        ]));
    };

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

            // Add only the current user's referenced upload files.
            for (const relPath of getReferencedUploadsForUser(db)) {
                const fullPath = path.join(__dirname, '..', '..', 'public', relPath);
                if (!fs.existsSync(fullPath)) continue;
                archive.file(fullPath, { name: relPath.replaceAll(path.sep, '/') });
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
            clearMemoryCache(userId);

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
            const { userDbCache } = require('../../db');
            const { engineCache } = require('../../engine');

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

            const currentUploadRefs = getReferencedUploadsForUser(req.db);

            // Wipe existing memory indexes
            const characters = req.db.getCharacters();
            for (const c of characters) {
                await memory.wipeIndex(c.id);
            }

            const dbPath = req.db.getDbPath();

            // Stop all live workers touching this user's DB before overwriting it.
            closeSchedulerDb(userId);
            const oldEngine = engineCache.get(userId);
            if (oldEngine && typeof oldEngine.stopAllTimers === 'function') {
                oldEngine.stopAllTimers();
            }

            // Checkpoint and close current DB
            try {
                await req.db.backup(dbPath + '.tmp');
            } catch (e) { }

            req.db.close();
            userDbCache.delete(userId);

            // Delete existing WAL and SHM files
            if (fs.existsSync(dbPath + '-wal')) fs.unlinkSync(dbPath + '-wal');
            if (fs.existsSync(dbPath + '-shm')) fs.unlinkSync(dbPath + '-shm');

            // Overwrite the database
            fs.copyFileSync(dbFilePath, dbPath);

            // Restore uploads from zip if present. Keep the shared temp dir untouched.
            if (isZip && extractedDir) {
                const extractedUploads = path.join(extractedDir, 'uploads');
                if (fs.existsSync(extractedUploads)) {
                    removeReferencedUploads(currentUploadRefs);
                    copyDirRecursive(extractedUploads, uploadsDir);
                    console.log('[Backup] Restored upload files (avatars, images) from backup.');
                }
            }

            clearMemoryCache(userId);
            engineCache.delete(userId);

            // Re-open the restored database and rebuild memory search indices so restore is usable immediately.
            const restoredDb = getUserDb(userId);
            const restoredMemory = getMemory(userId);
            const restoredCharacters = restoredDb.getCharacters();
            for (const character of restoredCharacters) {
                await restoredMemory.rebuildIndex(character.id);
            }

            // Clean up temp files only after rebuild finishes.
            cleanupTemp(uploadedPath, extractedDir);

            res.json({
                success: true,
                restoredCharacters: restoredCharacters.length,
                rebuiltMemoryIndexes: restoredCharacters.length
            });
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

    function removeReferencedUploads(relPaths = []) {
        for (const relPath of relPaths) {
            if (!relPath) continue;
            const fullPath = path.join(__dirname, '..', '..', 'public', relPath);
            try {
                if (fs.existsSync(fullPath) && fullPath !== tempUploadsDir && !fullPath.startsWith(tempUploadsDir + path.sep)) {
                    fs.rmSync(fullPath, { recursive: true, force: true });
                }
            } catch (e) { }
        }
        if (!fs.existsSync(uploadsDir)) {
            fs.mkdirSync(uploadsDir, { recursive: true });
        }
        if (!fs.existsSync(tempUploadsDir)) {
            fs.mkdirSync(tempUploadsDir, { recursive: true });
        }
    }

    function copyDirRecursive(src, dest) {
        if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
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
