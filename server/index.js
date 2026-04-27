process.on('uncaughtException', err => {
    console.error('UNCAUGHT EXCEPTION:', err);
});
process.on('unhandledRejection', (reason, promise) => {
    console.error('UNHANDLED REJECTION:', reason);
});

const express = require('express');
const cors = require('cors');
const http = require('http');
const { WebSocketServer } = require('ws');
const { getUserDb } = require('./db');
const authDb = require('./authDb');
const { deriveEmotion } = require('./emotion');
const jwt = require('jsonwebtoken');
const path = require('path');
const fs = require('fs');

require('dotenv').config({ path: path.join(__dirname, '.env') });

// Generate or load a persistent JWT secret (never hardcoded in source)
function getJwtSecret() {
    if (process.env.JWT_SECRET) return process.env.JWT_SECRET;
    const secretPath = path.join(__dirname, 'data', '.jwt_secret');
    try {
        if (fs.existsSync(secretPath)) {
            return fs.readFileSync(secretPath, 'utf8').trim();
        }
    } catch (e) { /* fall through to generate */ }
    // Generate a strong 256-bit random secret and persist
    const dataDir = path.join(__dirname, 'data');
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
    const secret = require('crypto').randomBytes(32).toString('base64url');
    fs.writeFileSync(secretPath, secret, { mode: 0o600 });
    console.log('[Auth] Generated new JWT secret and saved to data/.jwt_secret');
    return secret;
}
const JWT_SECRET = getJwtSecret();
const { getEngine } = require('./engine');
const { getMemory, extractMemoryFromContext, setWsClientsResolver, getEmbeddingDebugStatus } = require('./memory');
const { getTokenCount } = require('./utils/tokenizer');
const { getBackgroundQueueStats } = require('./backgroundQueue');
const qdrant = require('./qdrant');
const crypto = require('crypto');

let pluginContext = null;

function createRequestTraceId(prefix = 'req') {
    const randomPart = typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID().slice(0, 8)
        : Math.random().toString(36).slice(2, 10);
    return `${prefix}-${Date.now().toString(36)}-${randomPart}`;
}

function getEngineWithPluginHooks(userId) {
    const engine = getEngine(userId);
    if (!engine || !pluginContext?.hooks) return engine;
    if (typeof pluginContext.hooks.cityReplyStateSyncCallback === 'function' && typeof engine.setCityReplyStateSyncCallback === 'function') {
        engine.setCityReplyStateSyncCallback(pluginContext.hooks.cityReplyStateSyncCallback);
    }
    if (typeof pluginContext.hooks.cityReplyIntentCallback === 'function' && typeof engine.setCityReplyIntentCallback === 'function') {
        engine.setCityReplyIntentCallback(pluginContext.hooks.cityReplyIntentCallback);
    }
    if (typeof pluginContext.hooks.cityReplyActionCallback === 'function' && typeof engine.setCityReplyActionCallback === 'function') {
        engine.setCityReplyActionCallback(pluginContext.hooks.cityReplyActionCallback);
    }
    return engine;
}

function getDigestTailWindowSize(contextLimit, availableCount) {
    const safeLimit = Math.max(0, Number(contextLimit) || 0);
    const safeAvailable = Math.max(0, Number(availableCount) || 0);
    if (safeAvailable <= 0) return 0;
    return Math.min(safeAvailable, Math.max(3, Math.min(60, Math.ceil(safeLimit * 0.3))));
}

function extractMessagePlainText(content) {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
        return content.map(part => {
            if (typeof part === 'string') return part;
            if (part && typeof part === 'object') {
                return String(part.text || part.content || '');
            }
            return '';
        }).join('\n');
    }
    if (content && typeof content === 'object') {
        return String(content.text || content.content || '');
    }
    return '';
}

function buildClaudePromptCacheEstimateMessages(messages = []) {
    let markedCount = 0;
    return (messages || []).map((msg, index) => {
        if (!msg || typeof msg !== 'object') return msg;
        const clone = { ...msg };
        const shouldMark = markedCount < 2 && (
            clone.role === 'system' ||
            (index > 0 && typeof clone.content === 'string' && clone.content.length >= 512)
        );
        if (shouldMark && typeof clone.content === 'string') {
            clone.content = [{
                type: 'text',
                text: clone.content,
                cache_control: { type: 'ephemeral' }
            }];
            markedCount += 1;
        }
        return clone;
    });
}

function estimateJsonWrapperTokensForMessages(messages = []) {
    const safeMessages = Array.isArray(messages) ? messages : [];
    const plainTextTokens = safeMessages.reduce((sum, message) => {
        return sum + getTokenCount(extractMessagePlainText(message?.content || ''));
    }, 0);
    const messagesJsonTokens = getTokenCount(JSON.stringify(safeMessages));
    return {
        plainTextTokens,
        messagesJsonTokens,
        wrapperTokens: Math.max(0, messagesJsonTokens - plainTextTokens)
    };
}

function estimateRequestBodyTokens(body) {
    return getTokenCount(JSON.stringify(body || {}));
}
const multer = require('multer');
const { callLLM } = require('./llm');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const app = express();
// Enable security headers. We disable contentSecurityPolicy temporarily to prevent 
// accidentally blocking frontend scripts since it's an SPA.
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());
app.use(express.json({ limit: '50mb' })); // Parses incoming JSON requests
app.use(express.urlencoded({ limit: '50mb', extended: true })); // Parses URL-encoded data

function isLocalRequest(req) {
    const ip = req.ip || req.socket?.remoteAddress || '';
    return ip === '127.0.0.1'
        || ip === '::1'
        || ip === '::ffff:127.0.0.1'
        || ip === 'localhost';
}

// Define rate limiters
const authLimiter = rateLimit({
    windowMs: 5 * 60 * 1000, // 5 minutes
    max: 20, // limit each IP to 20 requests per windowMs for auth routes
    skip: (req) => isLocalRequest(req),
    message: { error: 'Too many authentication attempts. Please try again later.' }
});

const apiLimiter = rateLimit({
    windowMs: 1 * 60 * 1000, // 1 minute
    max: 120, // limit each IP to 120 api requests per minute
    skip: (req) => isLocalRequest(req),
    message: { error: 'API rate limit exceeded.' }
});

app.use('/api/', (req, res, next) => {
    if (req.path.startsWith('/auth/')) return next();
    return apiLimiter(req, res, next);
}); // Apply general API limiter to non-auth API routes


// Serve static uploaded files with CORP header to bypass browser COEP blocks
app.use('/uploads', (req, res, next) => {
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    next();
}, express.static(path.join(__dirname, 'public/uploads')));

// Configure Multer for local image uploads
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        const uploadDir = path.join(__dirname, 'public/uploads');
        if (!fs.existsSync(uploadDir)) {
            fs.mkdirSync(uploadDir, { recursive: true });
        }
        cb(null, uploadDir);
    },
    filename: function (req, file, cb) {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        const ext = path.extname(file.originalname);
        cb(null, file.fieldname + '-' + uniqueSuffix + ext);
    }
});

const fileFilter = (req, file, cb) => {
    // accept images or sqlite databases
    if (file.mimetype.startsWith('image/') || file.originalname.endsWith('.db') || file.mimetype === 'application/octet-stream' || file.mimetype === 'application/x-sqlite3') {
        cb(null, true);
    } else {
        cb(new Error('Invalid file type. Only images and .db backups are allowed.'), false);
    }
};

const upload = multer({
    storage: storage,
    limits: { fileSize: 50 * 1024 * 1024 }, // 50MB limit for db backups
    fileFilter: fileFilter
});

// Initialize the Database schemas


// Setup Server and WebSockets
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const userWsClients = new Map();

function getWsClients(userId) {
    if (!userWsClients.has(userId)) {
        userWsClients.set(userId, new Set());
    }
    return userWsClients.get(userId);
}

// Inject the global WS resolver into memory.js so it can broadcast without circular dependencies
setWsClientsResolver(getWsClients);

wss.on('connection', (ws) => {
    console.log('[WS] Frontend client connected.');

    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            if (data.type === 'auth') {
                const decoded = jwt.verify(data.token, JWT_SECRET);
                ws.userId = decoded.id;
                const clients = getWsClients(decoded.id);
                clients.add(ws);
                const engine = getEngineWithPluginHooks(decoded.id);
                engine.startEngine(clients);
                engine.startGroupProactiveTimers(clients);
                console.log(`[WS] Authenticated frontend socket for user: ${decoded.username}`);
            }
        } catch (e) {
            console.error('[WS] Auth or Engine Start Error:', e.message);
        }
    });

    ws.on('close', () => {
        console.log('[WS] Frontend client disconnected.');
        if (ws.userId) {
            getWsClients(ws.userId).delete(ws);
        }
    });
});



// 鈹€鈹€鈹€ AUTHENTICATION MIDDLEWARE 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
authDb.initAuthDb();

const authMiddleware = (req, res, next) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    const token = authHeader.split(' ')[1];
    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        const authUser = authDb.getUserById(decoded.id);
        if (!authUser) {
            return res.status(401).json({ error: 'Invalid token' });
        }
        if (authUser.status === 'banned') {
            return res.status(403).json({ error: 'Account banned' });
        }
        if (Number(decoded.tokenVersion ?? 0) !== Number(authUser.token_version ?? 0)) {
            return res.status(401).json({ error: 'Session expired' });
        }
        req.user = {
            id: authUser.id,
            username: authUser.username,
            role: authUser.role || decoded.role || 'user',
            status: authUser.status || 'active',
            tokenVersion: authUser.token_version || 0
        };
        authDb.updateLastActive(req.user.id);
        req.db = getUserDb(req.user.id);
        Object.defineProperty(req, 'engine', {
            configurable: true,
            enumerable: true,
            get() {
            const engine = getEngineWithPluginHooks(req.user.id);
                Object.defineProperty(req, 'engine', {
                    value: engine,
                    writable: false,
                    configurable: true,
                    enumerable: true
                });
                return engine;
            }
        });
        Object.defineProperty(req, 'memory', {
            configurable: true,
            enumerable: true,
            get() {
                const memory = getMemory(req.user.id);
                Object.defineProperty(req, 'memory', {
                    value: memory,
                    writable: false,
                    configurable: true,
                    enumerable: true
                });
                return memory;
            }
        });
        next();
    } catch (e) {
        return res.status(401).json({ error: 'Invalid token' });
    }
};

// 0. Upload a file (image or any file)
app.post('/api/upload', authMiddleware, (req, res) => {
    upload.any()(req, res, function (err) {
        if (err instanceof multer.MulterError) {
            // A Multer error occurred when uploading (e.g. file too large)
            return res.status(400).json({ error: err.message });
        } else if (err) {
            // An unknown error occurred (e.g. our custom fileFilter threw an error)
            return res.status(400).json({ error: err.message });
        }

        try {
            const file = req.files?.[0];
            if (!file) {
                return res.status(400).json({ error: 'No file uploaded' });
            }
            // Return relative path so frontend can construct absolute URL or use it directly
            const fileUrl = `/uploads/${file.filename}`;
            res.json({ success: true, url: fileUrl });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });
});

// 鈹€鈹€鈹€ AUTH ROUTES 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
app.post('/api/auth/register', authLimiter, (req, res) => {
    try {
        const { username, password, inviteCode } = req.body;
        if (!username || !password) return res.status(400).json({ error: 'Missing username or password' });
        const result = authDb.createUser(username, password, inviteCode);
        if (!result.success) return res.status(400).json({ error: result.error });
        const token = jwt.sign({ id: result.user.id, username: result.user.username, role: result.user.role, tokenVersion: result.user.tokenVersion || 0 }, JWT_SECRET, { expiresIn: '30d' });
        getUserDb(result.user.id);
        res.json({ success: true, token, user: result.user });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/auth/login', authLimiter, (req, res) => {
    try {
        const { username, password } = req.body;
        const result = authDb.verifyUser(username, password);
        if (!result.success) return res.status(401).json({ error: result.error });
        const token = jwt.sign({ id: result.user.id, username: result.user.username, role: result.user.role, tokenVersion: result.user.tokenVersion || 0 }, JWT_SECRET, { expiresIn: '30d' });
        getUserDb(result.user.id);
        res.json({ success: true, token, user: result.user });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/auth/me', authMiddleware, (req, res) => {
    res.json({ success: true, user: req.user });
});

app.put('/api/auth/account', authMiddleware, (req, res) => {
    try {
        const { username, currentPassword, newPassword } = req.body || {};
        const result = authDb.updateOwnAccount(req.user.id, {
            username,
            currentPassword,
            newPassword
        });
        if (!result.success) return res.status(400).json({ error: result.error });

        const token = jwt.sign({
            id: result.user.id,
            username: result.user.username,
            role: result.user.role,
            tokenVersion: result.user.tokenVersion || 0
        }, JWT_SECRET, { expiresIn: '30d' });

        res.json({ success: true, token, user: result.user });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// 鈹€鈹€鈹€ SYSTEM ROUTES 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
app.get('/api/system/announcement', authMiddleware, (req, res) => {
    try {
        const ann = authDb.getLatestAnnouncement();
        res.json({ success: true, announcement: ann });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});


// 鈹€鈹€鈹€ PLUGIN MANAGER 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
pluginContext = {
    wss,
    getWsClients,
    authDb,
    authMiddleware,
    getUserDb,
    getEngine: getEngineWithPluginHooks,
    getMemory,
    callLLM,
    JWT_SECRET,
    hooks: {}  // DLCs register late-binding callbacks here
};

const pluginsDir = path.join(__dirname, 'plugins');
if (fs.existsSync(pluginsDir)) {
    const plugins = fs.readdirSync(pluginsDir);
    for (const pluginName of plugins) {
        const pluginPath = path.join(pluginsDir, pluginName, 'index.js');
        if (fs.existsSync(pluginPath)) {
            try {
                const initPlugin = require(pluginPath);
                initPlugin(app, pluginContext);
                console.log(`[Plugin] Loaded DLC: ${pluginName}`);
            } catch (err) {
                console.error(`[Plugin] Failed to load DLC: ${pluginName}`, err);
            }
        }
    }
}

// REST API ROUTES
// 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

// 0.5 Get User Profile
app.get('/api/user', authMiddleware, (req, res) => {
    const db = req.db;
    try {
        const profile = typeof db.getUserProfile === 'function' ? db.getUserProfile() : null;
        res.json({ ...(profile || { name: req.user.username }), username: req.user.username, role: req.user.role || 'user' });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// 0.6 Save User Profile
app.post('/api/user', authMiddleware, (req, res) => {
    const db = req.db;
    try {
        if (typeof db.updateUserProfile === 'function') {
            db.updateUserProfile(req.body);
        }
        const updatedProfile = typeof db.getUserProfile === 'function' ? db.getUserProfile() : null;
        res.json({ success: true, profile: { ...(updatedProfile || { name: req.user.username }), username: req.user.username, role: req.user.role || 'user' } });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/user/memory-status', authMiddleware, async (req, res) => {
    const db = req.db;
    try {
        const config = qdrant.getQdrantConfig();
        const collectionName = qdrant.getCollectionName(req.user.id);
        const rawDb = typeof db.getRawDb === 'function' ? db.getRawDb() : null;
        const characters = typeof db.getCharacters === 'function' ? db.getCharacters() : [];

        const summaryRow = rawDb
            ? rawDb.prepare(`
                SELECT
                    COUNT(*) AS memories_count,
                    SUM(CASE WHEN embedding IS NOT NULL AND length(embedding) > 0 THEN 1 ELSE 0 END) AS embedded_count,
                    SUM(CASE WHEN COALESCE(is_archived, 0) = 1 THEN 1 ELSE 0 END) AS archived_count,
                    SUM(CASE WHEN COALESCE(summary, '') <> '' OR COALESCE(content, '') <> '' OR COALESCE(memory_type, '') <> '' THEN 1 ELSE 0 END) AS structured_count,
                    COUNT(DISTINCT character_id) AS characters_with_memories,
                    SUM(CASE WHEN COALESCE(last_retrieved_at, 0) > 0 OR COALESCE(retrieval_count, 0) > 0 THEN 1 ELSE 0 END) AS ever_retrieved_count,
                    COALESCE(SUM(COALESCE(retrieval_count, 0)), 0) AS total_retrievals,
                    MAX(COALESCE(updated_at, created_at, 0)) AS last_memory_at,
                    MAX(COALESCE(last_retrieved_at, 0)) AS last_retrieved_at
                FROM memories
            `).get()
            : null;

        const tokenRow = rawDb
            ? rawDb.prepare(`
                SELECT
                    COALESCE(SUM(prompt_tokens + completion_tokens), 0) AS token_total,
                    COUNT(*) AS request_count,
                    MAX(timestamp) AS last_token_at
                FROM token_usage
            `).get()
            : null;

        const cacheSummaryRow = rawDb
            ? rawDb.prepare(`
                SELECT
                    COUNT(*) AS entries_count,
                    COALESCE(SUM(hit_count), 0) AS hit_count,
                    COUNT(DISTINCT CASE WHEN COALESCE(character_id, '') <> '' THEN character_id END) AS cached_characters_count,
                    MAX(last_hit_at) AS last_cache_hit_at,
                    MAX(created_at) AS last_cache_write_at
                FROM llm_cache
                WHERE expires_at > ?
            `).get(Date.now())
            : null;

        const cacheStatsRow = typeof db.getLlmCacheStats === 'function'
            ? db.getLlmCacheStats('global')
            : null;

        const cacheByCharacterRows = rawDb
            ? rawDb.prepare(`
                SELECT
                    COALESCE(character_id, '') AS character_id,
                    COUNT(*) AS entries_count,
                    COALESCE(SUM(hit_count), 0) AS hit_count,
                    MAX(last_hit_at) AS last_hit_at,
                    MAX(created_at) AS last_write_at
                FROM llm_cache
                WHERE expires_at > ?
                  AND COALESCE(character_id, '') <> ''
                GROUP BY character_id
                ORDER BY entries_count DESC, hit_count DESC
                LIMIT 12
            `).all(Date.now())
            : [];

        const promptBlockSummaryRow = rawDb
            ? rawDb.prepare(`
                SELECT
                    COUNT(*) AS entries_count,
                    COALESCE(SUM(COALESCE(hit_count, 0)), 0) AS hit_count,
                    MAX(COALESCE(last_hit_at, 0)) AS last_hit_at,
                    MAX(COALESCE(updated_at, created_at, 0)) AS last_write_at
                FROM prompt_block_cache
            `).get()
            : null;

        const digestSummaryRow = rawDb
            ? rawDb.prepare(`
                SELECT
                    COALESCE(SUM(entries_count), 0) AS entries_count,
                    COALESCE(SUM(hit_count), 0) AS hit_count,
                    MAX(last_hit_at) AS last_hit_at,
                    MAX(last_write_at) AS last_write_at
                FROM (
                    SELECT
                        COUNT(*) AS entries_count,
                        COALESCE(SUM(COALESCE(hit_count, 0)), 0) AS hit_count,
                        MAX(COALESCE(last_hit_at, 0)) AS last_hit_at,
                        MAX(COALESCE(updated_at, created_at, 0)) AS last_write_at
                    FROM conversation_digest_cache
                    UNION ALL
                    SELECT
                        COUNT(*) AS entries_count,
                        COALESCE(SUM(COALESCE(hit_count, 0)), 0) AS hit_count,
                        MAX(COALESCE(last_hit_at, 0)) AS last_hit_at,
                        MAX(COALESCE(updated_at, created_at, 0)) AS last_write_at
                    FROM group_conversation_digest_cache
                )
            `).get()
            : null;

        const status = {
            enabled: !!config.enabled,
            reachable: false,
            url: config.url,
            mode: config.enabled
                ? (process.platform === 'win32' && fs.existsSync(path.join(__dirname, '..', 'tools', 'qdrant', 'current', 'qdrant.exe')) ? 'local' : (/127\.0\.0\.1|localhost/i.test(config.url) ? 'self-hosted' : 'external'))
                : 'disabled',
            backend: config.enabled ? 'qdrant-primary-with-vectra-fallback' : 'vectra-fallback-only',
            collectionName,
            collectionExists: false,
            indexedPoints: 0,
            indexingCoverage: 0,
            indexingSource: config.enabled ? 'qdrant' : 'vectra-fallback',
            charactersCount: characters.length,
            charactersWithMemories: Number(summaryRow?.characters_with_memories || 0),
            memoriesCount: Number(summaryRow?.memories_count || 0),
            embeddedMemoriesCount: Number(summaryRow?.embedded_count || 0),
            structuredMemoriesCount: Number(summaryRow?.structured_count || 0),
            archivedMemoriesCount: Number(summaryRow?.archived_count || 0),
            everRetrievedMemoriesCount: Number(summaryRow?.ever_retrieved_count || 0),
            totalRetrievals: Number(summaryRow?.total_retrievals || 0),
            healthyContextCacheEntriesCount: Number(promptBlockSummaryRow?.entries_count || 0) + Number(digestSummaryRow?.entries_count || 0),
            healthyContextCacheHitCount: Number(promptBlockSummaryRow?.hit_count || 0) + Number(digestSummaryRow?.hit_count || 0),
            promptBlockCacheEntriesCount: Number(promptBlockSummaryRow?.entries_count || 0),
            promptBlockCacheHitCount: Number(promptBlockSummaryRow?.hit_count || 0),
            digestCacheEntriesCount: Number(digestSummaryRow?.entries_count || 0),
            digestCacheHitCount: Number(digestSummaryRow?.hit_count || 0),
            healthyContextCacheLastHitAt: Math.max(Number(promptBlockSummaryRow?.last_hit_at || 0), Number(digestSummaryRow?.last_hit_at || 0)),
            healthyContextCacheLastWriteAt: Math.max(Number(promptBlockSummaryRow?.last_write_at || 0), Number(digestSummaryRow?.last_write_at || 0)),
            cacheEntriesCount: Number(cacheSummaryRow?.entries_count || 0),
            cacheHitCount: Number(cacheSummaryRow?.hit_count || 0),
            cacheLookupCount: Number(cacheStatsRow?.lookup_count || 0),
            cacheRequestHitCount: Number(cacheStatsRow?.hit_count || 0),
            cachedCharactersCount: Number(cacheSummaryRow?.cached_characters_count || 0),
            lastCacheHitAt: Number(cacheSummaryRow?.last_cache_hit_at || 0),
            lastCacheWriteAt: Number(cacheSummaryRow?.last_cache_write_at || 0),
            tokenTotal: Number(tokenRow?.token_total || 0),
            requestCount: Number(tokenRow?.request_count || 0),
            lastMemoryAt: Number(summaryRow?.last_memory_at || 0),
            lastRetrievedAt: Number(summaryRow?.last_retrieved_at || 0),
            lastTokenAt: Number(tokenRow?.last_token_at || 0),
            cacheByCharacter: Array.isArray(cacheByCharacterRows) ? cacheByCharacterRows.map(row => {
                const char = characters.find(item => String(item.id) === String(row.character_id));
                return {
                    character_id: row.character_id,
                    character_name: char?.name || row.character_id,
                    entries_count: Number(row.entries_count || 0),
                    hit_count: Number(row.hit_count || 0),
                    last_hit_at: Number(row.last_hit_at || 0),
                    last_write_at: Number(row.last_write_at || 0)
                };
            }) : [],
            statusNoteCode: '',
            statusNote: '',
            lastError: ''
        };

        const applyIndexedStats = (points, source) => {
            const numericPoints = Math.max(0, Number(points || 0));
            status.indexedPoints = numericPoints;
            status.indexingSource = source || status.indexingSource || 'unknown';
            status.indexingCoverage = status.memoriesCount > 0
                ? Math.min(100, Math.round((numericPoints / status.memoriesCount) * 100))
                : 0;
        };

        if (!config.enabled) {
            applyIndexedStats(status.embeddedMemoriesCount, 'vectra-fallback');
            return res.json({ success: true, status });
        }

        try {
            const info = await qdrant.getCollectionInfo(collectionName);
            status.reachable = true;
            status.collectionExists = true;
            const qdrantPoints = Number(
                info?.points_count ??
                info?.vectors_count ??
                info?.indexed_vectors_count ??
                0
            );
            applyIndexedStats(Math.max(qdrantPoints, status.embeddedMemoriesCount), qdrantPoints > 0 ? 'qdrant' : 'vectra-fallback');
            return res.json({ success: true, status });
        } catch (e) {
            const healthy = await qdrant.healthcheck();
            status.reachable = healthy;
            status.backend = healthy ? 'qdrant-online-collection-pending' : 'vectra-fallback-active';
            if (healthy && /doesn't exist|not found/i.test(String(e.message || ''))) {
                applyIndexedStats(status.embeddedMemoriesCount, status.embeddedMemoriesCount > 0 ? 'vectra-fallback' : 'qdrant');
                status.statusNoteCode = status.memoriesCount > 0
                    ? 'collection_pending_existing_memories'
                    : 'collection_pending_first_memory';
            } else {
                if (status.embeddedMemoriesCount > 0) {
                    applyIndexedStats(status.embeddedMemoriesCount, 'vectra-fallback');
                }
                status.lastError = e.message;
            }
            return res.json({ success: true, status });
        }
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// 1. Get all characters (Contacts list)
app.get('/api/system/embedding-status', authMiddleware, async (req, res) => {
    try {
        const status = getEmbeddingDebugStatus();
        res.json({
            success: true,
            embedding: status,
            now: Date.now()
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/system/background-queue', authMiddleware, (req, res) => {
    try {
        res.json({
            success: true,
            stats: getBackgroundQueueStats(),
            now: Date.now()
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/characters', authMiddleware, (req, res) => {
    const db = req.db;
    try {
        const characters = db.getCharacters();

        // Ensure city DB is attached for inventory queries
        if (!db.city) {
            try {
                const initCityDb = require('./plugins/city/cityDb');
                db.city = initCityDb(typeof db.getRawDb === 'function' ? db.getRawDb() : db);
            } catch (e) {
                // City DLC not found or failed to load
            }
        }

        // Attach unread_count so the frontend can initialise badges correctly on load/refresh
        const enriched = characters.map(c => {
            const emotion = deriveEmotion(c);
            return {
                ...c,
                unread_count: db.getUnreadCount(c.id),
                inventory: typeof db.city?.getInventory === 'function' ? db.city.getInventory(c.id) : [],
                emotion_state: emotion.state,
                emotion_label: emotion.label,
                emotion_emoji: emotion.emoji,
                emotion_color: emotion.color
            };
        });
        res.json(enriched);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// 2. Add or Update Character
app.post('/api/characters', authMiddleware, (req, res) => {
    const db = req.db;
    const engine = req.engine;
    const memory = req.memory;
    const wsClients = getWsClients(req.user.id);
    try {
        const data = req.body;
        if (!data.id || !data.name) return res.status(400).json({ error: 'Missing ID or Name' });
        const prevCharacter = typeof db.getCharacter === 'function' ? db.getCharacter(data.id) : null;

        db.updateCharacter(data.id, data);
        if (prevCharacter && Object.prototype.hasOwnProperty.call(data, 'context_msg_limit')) {
            const prevLimit = Number(prevCharacter.context_msg_limit || 60);
            const nextLimit = Number(data.context_msg_limit || prevLimit);
            if (prevLimit !== nextLimit) {
                db.clearConversationDigest?.(data.id);
                const rawDb = typeof db.getRawDb === 'function' ? db.getRawDb() : null;
                rawDb?.prepare('DELETE FROM history_window_cache WHERE character_id = ?').run(data.id);
                const nextCharacter = typeof db.getCharacter === 'function' ? db.getCharacter(data.id) : null;
                if (nextCharacter && typeof memory?.updateConversationDigest === 'function') {
                    memory.updateConversationDigest(nextCharacter).catch(err => {
                        console.warn(`[API] Failed to rebuild conversation digest for ${nextCharacter.name}: ${err.message}`);
                    });
                }
            }
        }
        // Reset proactive timer after settings change (do NOT call handleUserMessage 鈥?
        // that would echo the character's own last message back to the AI as user input)
        engine.stopTimer(data.id);

        res.json({ success: true, character: db.getCharacter(data.id) });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// 2.1 Update Character Fields (Partial)
app.put('/api/characters/:id', authMiddleware, (req, res) => {
    const db = req.db;
    const memory = req.memory;
    try {
        const id = req.params.id;
        const data = req.body;
        if (!id) return res.status(400).json({ error: 'Missing ID' });
        const prevCharacter = typeof db.getCharacter === 'function' ? db.getCharacter(id) : null;

        db.updateCharacter(id, data);
        if (prevCharacter && Object.prototype.hasOwnProperty.call(data, 'context_msg_limit')) {
            const prevLimit = Number(prevCharacter.context_msg_limit || 60);
            const nextLimit = Number(data.context_msg_limit || prevLimit);
            if (prevLimit !== nextLimit) {
                db.clearConversationDigest?.(id);
                const rawDb = typeof db.getRawDb === 'function' ? db.getRawDb() : null;
                rawDb?.prepare('DELETE FROM history_window_cache WHERE character_id = ?').run(id);
                const nextCharacter = typeof db.getCharacter === 'function' ? db.getCharacter(id) : null;
                if (nextCharacter && typeof memory?.updateConversationDigest === 'function') {
                    memory.updateConversationDigest(nextCharacter).catch(err => {
                        console.warn(`[API] Failed to rebuild conversation digest for ${nextCharacter.name}: ${err.message}`);
                    });
                }
            }
        }
        res.json({ success: true, character: db.getCharacter(id) });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/characters/:id/reset-physical-state', authMiddleware, (req, res) => {
    const db = req.db;
    try {
        const id = req.params.id;
        if (!id) return res.status(400).json({ error: 'Missing ID' });
        const character = typeof db.getCharacter === 'function' ? db.getCharacter(id) : null;
        if (!character) return res.status(404).json({ error: 'Character not found' });

        const patch = {
            energy: 100,
            sleep_debt: 0,
            sleep_pressure: 0,
            stress: 0,
            pressure_level: 0,
            work_distraction: 0,
            sleep_disruption: 0
        };

        db.updateCharacter(id, patch);
        res.json({ success: true, character: db.getCharacter(id) });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// 2.5 Fetch available models from a given API endpoint (proxy to avoid CORS + key exposure in browser)
app.get('/api/models', async (req, res) => {
    try {
        const { endpoint, key } = req.query;
        if (!endpoint || !key) return res.status(400).json({ error: 'Missing endpoint or key' });

        let baseUrl = endpoint.endsWith('/') ? endpoint.slice(0, -1) : endpoint;
        if (baseUrl.endsWith('/chat/completions')) baseUrl = baseUrl.slice(0, -'/chat/completions'.length);
        const modelsUrl = `${baseUrl}/models`;

        const response = await fetch(modelsUrl, {
            headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' }
        });
        if (!response.ok) {
            const text = await response.text();
            return res.status(response.status).json({ error: `API ${response.status}: ${text.slice(0, 200)}` });
        }
        const data = await response.json();
        const models = (data.data || data.models || []).map(m => m.id || m.name || m).filter(Boolean).sort();
        res.json({ models });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// 3. Get messages for a character (supports ?limit=N and ?before=msgId for pagination)
app.get('/api/messages/:characterId', authMiddleware, (req, res) => {
    const db = req.db;
    try {
        const charId = req.params.characterId;
        const limit = parseInt(req.query.limit) || 100;
        const before = req.query.before;  // message ID cursor for older messages

        let messages;
        if (before) {
            messages = db.getMessagesBefore(charId, before, limit);
        } else {
            messages = db.getMessages(charId, limit);
            // Do not let unread-badge bookkeeping block the main history response.
            try {
                db.markMessagesRead(charId);
            } catch (markErr) {
                console.warn(`[Messages] Failed to mark messages read for ${charId}: ${markErr.message}`);
            }
        }
        res.json(messages);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/characters/:characterId/emotion-logs', authMiddleware, (req, res) => {
    const db = req.db;
    try {
        const limit = Math.max(1, Math.min(100, parseInt(req.query.limit, 10) || 50));
        const logs = typeof db.getEmotionLogs === 'function'
            ? db.getEmotionLogs(req.params.characterId, limit)
            : [];
        res.json({ success: true, logs });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/characters/:characterId/llm-debug-logs', authMiddleware, (req, res) => {
    const db = req.db;
    try {
        const limit = Math.max(1, Math.min(200, parseInt(req.query.limit, 10) || 50));
        const logs = typeof db.getLlmDebugLogs === 'function'
            ? db.getLlmDebugLogs(req.params.characterId, limit)
            : [];
        res.json({ success: true, logs });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// 4. Send a message to a character (User initiates)
app.post('/api/messages', authMiddleware, async (req, res) => {
    const db = req.db;
    const engine = req.engine;
    const memory = req.memory;
    const wsClients = getWsClients(req.user.id);
    try {
        const { characterId, content } = req.body;
        if (!characterId || !content) return res.status(400).json({ error: 'Missing characterId or content' });
        const requestId = createRequestTraceId('msg');

        const charObj = db.getCharacter(characterId);

        // If character has blocked the user, save message but return blocked flag
        if (!charObj || charObj.is_blocked) {
            const { id: msgId, timestamp: msgTs } = db.addMessage(characterId, 'user', content);
            const savedMessage = { id: msgId, character_id: characterId, role: 'user', content, timestamp: msgTs, isBlocked: true };
            engine.broadcastNewMessage?.(wsClients, savedMessage);
            return res.json({ success: true, blocked: true, message: savedMessage });
        }

        if (pluginContext.hooks?.cityBusyChatImpactPatch) {
            const busyPatch = pluginContext.hooks.cityBusyChatImpactPatch(charObj, 'private');
            if (Object.keys(busyPatch).length > 0) {
                db.updateCharacter(characterId, busyPatch);
            }
        }

        // Add user message to DB
        const { id: msgId, timestamp: msgTs } = db.addMessage(characterId, 'user', content);
        db.updateCharacter(characterId, { last_user_msg_time: msgTs });
        const savedMessage = { id: msgId, character_id: characterId, role: 'user', content, timestamp: msgTs };

        // Mark previous character messages as read
        db.markMessagesRead(characterId);

        // Push user message to UI via WS (before triggering AI reply for correct ordering)
        engine.broadcastNewMessage?.(wsClients, savedMessage);

        // Tell the engine to handle the user message: it will trigger an immediate reply
        engine.handleUserMessage(characterId, wsClients, {
            triggerSource: 'api_messages',
            triggerRoute: 'POST /api/messages',
            requestId,
            triggerNote: 'primary user send'
        });

        // Check if other characters get jealous that user is talking to this character
        engine.triggerJealousyCheck(characterId, wsClients);

        // Asynchronously trigger memory extraction using the small AI
        // (Memory extraction is handled by engine.js AFTER the AI replies to ensure full context)
        const recentMessages = db.getMessages(characterId, 10);
        memory.extractHiddenState(charObj, recentMessages).catch(e => console.error('[Memory] Background hidden state error:', e));

        res.json({ success: true, message: savedMessage });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// 4.2 Retry a failed AI response (User initiates on an error bubble)
app.post('/api/messages/:characterId/retry', authMiddleware, (req, res) => {
    const db = req.db;
    const engine = req.engine;
    const memory = req.memory;
    const wsClients = getWsClients(req.user.id);
    try {
        const { characterId } = req.params;
        const { failedMessageId } = req.body;
        const requestId = createRequestTraceId('retry');

        // Delete the error message from the DB if provided
        if (failedMessageId) {
            db.deleteMessage(failedMessageId);
        }

        // Re-attempt generation, resuming from the last failed RAG node when available.
        engine.handleUserMessage(characterId, wsClients, {
            useRetryResume: true,
            triggerSource: 'api_retry',
            triggerRoute: 'POST /api/messages/:characterId/retry',
            requestId,
            triggerNote: failedMessageId ? `retry_failed_message_${failedMessageId}` : 'retry_without_failed_message_id'
        });

        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/debug/reply-dispatch/:characterId', authMiddleware, (req, res) => {
    const db = req.db;
    try {
        const { characterId } = req.params;
        const limit = Math.max(1, Math.min(200, Number(req.query.limit) || 50));
        if (typeof db.getReplyDispatchLogs !== 'function') {
            return res.status(501).json({ error: 'Reply dispatch debug is unavailable' });
        }
        res.json(db.getReplyDispatchLogs(characterId, limit));
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// 4.3 Batch delete messages
app.post('/api/messages/batch-delete', authMiddleware, (req, res) => {
    const db = req.db;
    try {
        const { messageIds } = req.body;
        if (!Array.isArray(messageIds) || messageIds.length === 0) {
            return res.status(400).json({ error: 'messageIds array required' });
        }
        const affectedCharacterIds = new Set();
        let deleted = 0;
        for (const id of messageIds) {
            const characterId = db.getMessageCharacterId?.(id);
            if (characterId) affectedCharacterIds.add(characterId);
            db.deleteMessage(id);
            deleted++;
        }
        for (const characterId of affectedCharacterIds) {
            db.clearCharacterMessageCaches?.(characterId);
        }
        console.log('[Messages] Batch deleted ' + deleted + ' messages.');
        res.json({ success: true, deleted });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// 4.5 Send a transfer to a character (Unblock mechanic)
app.post('/api/transfer', authMiddleware, (req, res) => {
    const db = req.db;
    const engine = req.engine;
    const memory = req.memory;
    const wsClients = getWsClients(req.user.id);
    try {
        const { characterId, amount, note } = req.body;
        if (!characterId) return res.status(400).json({ error: 'Missing characterId' });

        const char = db.getCharacter(characterId);
        if (!char) return res.status(404).json({ error: 'Character not found' });

        // Create traceable transfer record in DB (deducts user wallet)
        const transferNote = note || 'Transfer';
        let tid;
        try {
            tid = db.createTransfer({
                charId: characterId,
                senderId: 'user',
                recipientId: characterId,
                amount: parseFloat(amount) || 0.01,
                note: transferNote,
                messageId: null
            });
        } catch (e) {
            return res.status(400).json({ error: e.message });
        }

        // Add user transfer message to DB
        const transferText = `[TRANSFER]${tid}|${amount || 0.01}|${transferNote}`;
        const { id: msgId, timestamp: msgTs } = db.addMessage(characterId, 'user', transferText);
        const savedMessage = { id: msgId, character_id: characterId, role: 'user', content: transferText, timestamp: msgTs };

        // Broadcast wallet update for user
        engine.broadcastWalletSync(wsClients, characterId);

        // Unblock them and reset pressure
        db.updateCharacter(characterId, {
            is_blocked: 0,
            pressure_level: 0
        });

        // Tell the engine to process the unblock reaction
        engine.handleUserMessage(characterId, wsClients, {
            triggerSource: 'transfer_unblock',
            triggerRoute: 'POST /api/characters/:characterId/transfer',
            requestId: createRequestTraceId('unblock'),
            triggerNote: 'transfer unblocked character'
        });

        // Push user message to UI via WS
        engine.broadcastNewMessage?.(wsClients, savedMessage);

        res.json({ success: true, unblocked: true, message: savedMessage });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// 4.55 Generate Character via LLM
app.post('/api/characters/generate', authMiddleware, async (req, res) => {
    const db = req.db;
    const engine = req.engine;
    const memory = req.memory;
    const wsClients = getWsClients(req.user.id);
    try {
        const { query, api_endpoint, api_key, model_name } = req.body;
        if (!query || !api_endpoint || !api_key || !model_name) {
            return res.status(400).json({ error: 'Missing required API keys or query description.' });
        }

        const systemPrompt = `You are a professional RPG character generator. You must create a detailed character persona and world background based on the user's description. The character is intended for a realistic social messaging app simulation. Return ONLY a raw JSON object with no markdown formatting. Do not include \`\`\`json blocks.
CRITICAL JSON RULES:
1. Ensure all newlines within string values are escaped as \\n (Do not output literal newlines inside strings).
2. Do NOT include any comments (like // or /* */).
3. Do NOT output trailing commas.
4. Keep ALL text fields extremely concise (max 2-3 sentences per field) to prevent the generation from being cut off.

The JSON MUST have the EXACT following keys:
- "name" (string, the character's name)
- "persona" (string, extremely detailed, first-person psychological profile and speech habits)
- "world_info" (string, detailed background of the setting and their relationship to the user)
- "affinity" (number 0-100, initial relationship level, integer)
- "sys_pressure" (number 0 or 1, 1 if they are prone to anxiety/stress)
- "sys_jealousy" (number 0 or 1, 1 if they are possessive/jealous)
- "interval_min" (number, suggested minimum minutes between proactive messages, integer)
- "interval_max" (number, suggested max minutes, integer)
- "target_emoji" (string, a single emoji that best represents this character's vibe/personality)
`;

        const existingChars = db.getCharacters();
        const usedEmojis = Array.from(new Set(existingChars.map(c => c.emoji).filter(e => e && e !== '馃懁')));
        const excludeEmojiStr = usedEmojis.length > 0
            ? `\nCRITICAL EMOJI RULE: Do NOT use any of these emojis because they are already taken by other characters: ${usedEmojis.join(', ')}. You MUST pick a unique one.`
            : '';

        const finalSystemPrompt = systemPrompt + excludeEmojiStr;

        const generatedText = await callLLM({
            endpoint: api_endpoint,
            key: api_key,
            model: model_name,
            messages: [{ role: 'system', content: finalSystemPrompt }, { role: 'user', content: query }],
            maxTokens: 1500,
            temperature: 0.7
        });

        console.log(`[Generator Raw Output]`, generatedText);

        // Aggressively strip markdown formatting
        let cleanText = generatedText.replace(/```json/gi, '').replace(/```/g, '').trim();

        const startIdx = cleanText.indexOf('{');
        const endIdx = cleanText.lastIndexOf('}');
        if (startIdx !== -1 && endIdx !== -1) {
            const jsonText = cleanText.slice(startIdx, endIdx + 1);
            let parsed;
            try {
                parsed = JSON.parse(jsonText);
            } catch (err) {
                console.error('JSON.parse failed on this string:\n', jsonText);
                throw new Error('LLM JSON Syntax Error: ' + err.message);
            }

            // Set defaults and formatting
            parsed.avatar = `https://api.dicebear.com/7.x/shapes/svg?seed=${encodeURIComponent(parsed.name || 'AI')}&backgroundColor=f0f0f0`;
            parsed.api_endpoint = api_endpoint;
            parsed.api_key = api_key;
            parsed.model_name = model_name;
            parsed.sys_timer = 1;
            parsed.sys_proactive = 1;
            parsed.emoji = parsed.target_emoji || '馃懁';
            delete parsed.target_emoji;

            return res.json({ success: true, character: parsed });
        } else {
            console.error('Failed to find JSON brackets in cleanText:', cleanText);
            throw new Error('LLM did not return a valid JSON object. Check Server Logs.');
        }
    } catch (e) {
        console.error('Generation Error:', e.message);
        res.status(500).json({ error: e.message });
    }
});

// 4.6 Clear messages for a character (Legacy Soft Clear)
app.delete('/api/messages/:characterId', authMiddleware, (req, res) => {
    const db = req.db;
    const engine = req.engine;
    const memory = req.memory;
    const wsClients = getWsClients(req.user.id);
    try {
        const characterId = req.params.characterId;
        db.clearMessages(characterId);
        db.clearCharacterMessageCaches?.(characterId);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// 4.7 DEEP WIPE: Clear all messages, sql memories, moments, diaries, and vectors
app.delete('/api/data/:characterId', authMiddleware, async (req, res) => {
    const db = req.db;
    const engine = req.engine;
    const memory = req.memory;
    const wsClients = getWsClients(req.user.id);
    try {
        const id = req.params.characterId;

        // 鈿?Stop the engine timer FIRST to minimize race-condition window
        engine.stopTimer(id);

        // Clear all data
        db.clearMessages(id);
        db.clearCharacterMessageCaches?.(id);
        db.clearMemories(id);
        db.clearMoments(id);
        db.clearDiaries(id);
        db.clearFriends(id);
        db.clearCharRelationships(id); // Also wipe inter-char social bonds
        db.clearTransfers(id);         // Wipe all private transfers (sent & received)
        db.clearMomentInteractions(id); // Wipe likes & comments on/by this char
        if (db.city && typeof db.city.clearCharacterCityData === 'function') {
            db.city.clearCharacterCityData(id);
        }
        await memory.wipeIndex(id);

        // Reset core emotional stats, wallet, AND diary lock state
        const char = db.getCharacter(id);
        const resetAffinity = char?.initial_affinity ?? 50;

        db.updateCharacter(id, {
            affinity: resetAffinity,
            pressure_level: 0,
            is_blocked: 0,
            is_diary_unlocked: 0,
            wallet: 200,
            calories: 2000,
            city_status: 'idle',
            location: 'home',
            diary_password: null,
            hidden_state: '',
            jealousy_level: 0,
            jealousy_target: '',
            last_moment_at: 0
        });
        // Immediately assign a fresh diary password
        const newPw = String(Math.floor(1000 + Math.random() * 9000));
        db.setDiaryPassword(id, newPw);

        // Add wipe notice (engine's anti-wipe check looks for this message)
        db.addMessage(id, 'system', '[System] All chat history, long-term memories, extracted vectors, moments, and diary have been completely wiped. This character is now a blank slate.');

        // Restart the character's engine timer so they resume proactive messaging
        engine.handleUserMessage(id, wsClients, {
            triggerSource: 'deep_wipe_reset',
            triggerRoute: 'DELETE /api/characters/:id/deep-wipe',
            requestId: createRequestTraceId('wipe'),
            triggerNote: 'deep wipe follow-up'
        });

        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// 4.8 EXPORT: Export character data (settings, messages, memories, moments)
app.get('/api/data/:characterId/export', authMiddleware, (req, res) => {
    const db = req.db;
    const engine = req.engine;
    const memory = req.memory;
    const wsClients = getWsClients(req.user.id);
    try {
        const data = db.exportCharacterData(req.params.characterId);
        if (!data) return res.status(404).json({ error: 'Character not found' });

        // Return as a downloadable JSON file
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Content-Disposition', `attachment; filename="${req.params.characterId}_export.json"`);
        res.send(JSON.stringify(data, null, 2));
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// 5. Get Memories for Character
app.get('/api/memories/:characterId', authMiddleware, (req, res) => {
    const db = req.db;
    const engine = req.engine;
    const memory = req.memory;
    const wsClients = getWsClients(req.user.id);
    try {
        const includeArchived = String(req.query.include_archived || '').trim() === '1';
        const mems = db.getMemories(req.params.characterId)
            .filter(mem => includeArchived || Number(mem.is_archived || 0) === 0);
        res.json(mems);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// 5.5 Trigger Manual Memory Extraction
app.post('/api/memories/:characterId/extract', authMiddleware, async (req, res) => {
    const db = req.db;
    const engine = req.engine;
    const memory = req.memory;
    const wsClients = getWsClients(req.user.id);
    try {
        const charObj = db.getCharacter(req.params.characterId);
        if (!charObj) return res.status(404).json({ error: 'Character not found' });

        if (!charObj.memory_api_endpoint || !charObj.memory_api_key || !charObj.memory_model_name) {
            return res.status(400).json({ error: 'Memory AI (Small Model) credentials are not configured for this character. Please configure them in Settings.' });
        }

        const recentMessages = db.getMessages(req.params.characterId, 15);
        if (recentMessages.length === 0) {
            return res.status(400).json({ error: 'No recent messages to extract memory from.' });
        }

        const extracted = await memory.extractMemoryFromContext(charObj, recentMessages);

        if (extracted) {
            res.json({ success: true, message: 'Memory successfully extracted!', data: extracted });
        } else {
            res.json({ success: true, message: 'AI analyzed the chat but found no new significant memories to extract.' });
        }
    } catch (e) {
        console.error('Manual extraction failed:', e);
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/memories/:characterId/sweep', authMiddleware, async (req, res) => {
    const db = req.db;
    const memory = req.memory;
    try {
        const charObj = db.getCharacter(req.params.characterId);
        if (!charObj) return res.status(404).json({ error: 'Character not found' });

        if (!charObj.memory_api_endpoint || !charObj.memory_api_key || !charObj.memory_model_name) {
            return res.status(400).json({ error: 'Memory AI (Small Model) is not fully configured for this character.' });
        }

        const sweepResult = await memory.sweepOverflowMemories(charObj);
        const refreshed = db.getCharacter(req.params.characterId);
        const lastError = refreshed?.sweep_last_error || '';
        const savedCount = Number(sweepResult?.savedCount || 0);

        if (sweepResult?.status === 'running') {
            return res.status(409).json({
                success: false,
                error: sweepResult.error || lastError || 'Another long-term memory sweep is already running.',
                savedCount
            });
        }

        if (sweepResult?.status === 'cooldown') {
            return res.status(429).json({
                success: false,
                error: sweepResult.error || lastError || 'Memory sweep cooldown active.',
                savedCount,
                remainingSeconds: Number(sweepResult.remainingSeconds || 0)
            });
        }

        if (savedCount > 0) {
            return res.json({
                success: true,
                savedCount,
                warning: lastError || '',
                message: `Long-term memory sweep completed. Saved ${savedCount} memories.`
            });
        }

        if (lastError) {
            return res.status(400).json({
                success: false,
                error: lastError,
                savedCount
            });
        }

        res.json({
            success: true,
            savedCount,
            message: savedCount > 0 ? 'Long-term memory sweep completed.' : 'No new long-term memories were extracted.'
        });
    } catch (e) {
        console.error('Manual sweep failed:', e);
        res.status(500).json({ error: e.message });
    }
});

// 6. Delete a Memory manually
app.delete('/api/memories/:id', authMiddleware, (req, res) => {
    const db = req.db;
    const engine = req.engine;
    const memory = req.memory;
    const wsClients = getWsClients(req.user.id);
    try {
        const mem = db.getMemory(req.params.id);
        if (!mem) return res.status(404).json({ error: 'Memory not found' });
        db.deleteMemory(req.params.id);
        if (memory?.rebuildIndex) {
            memory.rebuildIndex(mem.character_id).catch(err => {
                console.error('[Memory] Rebuild after delete failed:', err.message);
            });
        }
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// 7. Get All Moments
app.get('/api/moments', authMiddleware, (req, res) => {
    const db = req.db;
    const engine = req.engine;
    const memory = req.memory;
    const wsClients = getWsClients(req.user.id);
    try {
        const allMoments = db.getMoments();
        const characters = db.getCharacters();
        const blockedCharIds = characters.filter(c => c.is_blocked).map(c => c.id);
        // Allow user-posted moments (character_id = 'user')
        const visibleMoments = allMoments.filter(m => m.character_id === 'user' || !blockedCharIds.includes(m.character_id));

        // Enrich each moment with likes and comments
        const enriched = visibleMoments.map(m => ({
            ...m,
            likers: db.getLikesForMoment(m.id).map(l => l.liker_id),
            comments: db.getComments(m.id)
        }));
        res.json(enriched);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// User posts a Moment
app.post('/api/moments', authMiddleware, (req, res) => {
    const db = req.db;
    const engine = req.engine;
    const memory = req.memory;
    const wsClients = getWsClients(req.user.id);
    try {
        const { content, image_url } = req.body;
        if (!content) return res.status(400).json({ error: 'content required' });
        const id = db.addMoment('user', content, image_url || null);
        res.json({ success: true, id });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// 7.5 Delete a Moment (user only)
app.delete('/api/moments/:id', authMiddleware, (req, res) => {
    const db = req.db;
    const engine = req.engine;
    const memory = req.memory;
    const wsClients = getWsClients(req.user.id);
    try {
        db.deleteMoment(req.params.id);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// 8. Get Moments for a specific character
app.get('/api/moments/:characterId', authMiddleware, (req, res) => {
    const db = req.db;
    const engine = req.engine;
    const memory = req.memory;
    const wsClients = getWsClients(req.user.id);
    try {
        const char = db.getCharacter(req.params.characterId);
        if (char && char.is_blocked) return res.json([]);
        const moments = db.getCharacterMoments(req.params.characterId);
        res.json(moments);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// 8.5 Toggle Like on a Moment
app.post('/api/moments/:id/like', authMiddleware, (req, res) => {
    const db = req.db;
    const engine = req.engine;
    const memory = req.memory;
    const wsClients = getWsClients(req.user.id);
    try {
        const { liker_id } = req.body;  // 'user' or character id
        const liked = db.toggleLike(req.params.id, liker_id || 'user');
        const likers = db.getLikesForMoment(req.params.id).map(l => l.liker_id);

        // If the user liked it, potentially trigger a reaction from the AI
        if (liked && (liker_id === 'user' || !liker_id)) {
            const allMoments = db.getMoments();
            const moment = allMoments.find(m => m.id.toString() === req.params.id);
            if (moment && moment.character_id !== 'user') {
                const userProfile = db.getUserProfile();
                const reactionRate = userProfile?.moments_reaction_rate ?? 30; // 30% default
                if (Math.random() * 100 < reactionRate) {
                    // Send an invisible context message directly to the engine
                    const char = db.getCharacter(moment.character_id);
                    if (char && !char.is_blocked) {
                        const userName = userProfile?.name || 'User';
                        const contextContent = '[System] ' + userName + ' 刚刚赞了你的朋友圈动态：“' + moment.content.substring(0, 50) + '”。你可以在私聊中提及这件事。';
                        db.addMessage(char.id, 'system', contextContent);
                        console.log(`[Moments] User liked ${char.name}'s moment. Triggering reaction (Rate: ${reactionRate}%).`);
                        setTimeout(() => {
                            try {
                                engine.handleUserMessage(char.id, wsClients, {
                                    triggerSource: 'moment_like_reaction',
                                    triggerRoute: 'POST /api/moments/:momentId/like',
                                    requestId: createRequestTraceId('moment-like'),
                                    triggerNote: `moment_like_${moment.id}`
                                });
                            } catch (err) {
                                console.error('[Moments] Error triggering reaction for like:', err.message);
                            }
                        }, 2000); // 2-second delay to feel natural
                    }
                }
            }
        }

        res.json({ success: true, liked, likers });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// 8.6 Add a Comment on a Moment
app.post('/api/moments/:id/comment', authMiddleware, (req, res) => {
    const db = req.db;
    const engine = req.engine;
    const memory = req.memory;
    const wsClients = getWsClients(req.user.id);
    try {
        const { author_id, content } = req.body;
        if (!content) return res.status(400).json({ error: 'content required' });
        const commentId = db.addComment(req.params.id, author_id || 'user', content);

        // If the user commented, potentially trigger a reaction
        if (author_id === 'user' || !author_id) {
            const allMoments = db.getMoments();
            const moment = allMoments.find(m => m.id.toString() === req.params.id);
            if (moment && moment.character_id !== 'user') {
                const userProfile = db.getUserProfile();
                const reactionRate = userProfile?.moments_reaction_rate ?? 30;
                if (Math.random() * 100 < reactionRate) {
                    const char = db.getCharacter(moment.character_id);
                    if (char && !char.is_blocked) {
                        const userName = userProfile?.name || 'User';
                        const contextContent = '[System] ' + userName + ' 刚刚评论了你的朋友圈动态：“' + moment.content.substring(0, 50) + '”，评论说：“' + content + '”。你可以在私聊中回应。';
                        db.addMessage(char.id, 'system', contextContent);
                        console.log(`[Moments] User commented on ${char.name}'s moment. Triggering reaction (Rate: ${reactionRate}%).`);
                        setTimeout(() => {
                            try {
                                engine.handleUserMessage(char.id, wsClients, {
                                    triggerSource: 'moment_comment_reaction',
                                    triggerRoute: 'POST /api/moments/:momentId/comment',
                                    requestId: createRequestTraceId('moment-comment'),
                                    triggerNote: `moment_comment_${moment.id}`
                                });
                            } catch (err) {
                                console.error('[Moments] Error triggering reaction for comment:', err.message);
                            }
                        }, 2000);
                    }
                }
            }
        }

        res.json({ success: true, id: commentId });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// 9. Get Diaries for a Character
app.get('/api/diaries/:characterId', authMiddleware, (req, res) => {
    const db = req.db;
    const engine = req.engine;
    const memory = req.memory;
    const wsClients = getWsClients(req.user.id);
    try {
        const char = db.getCharacter(req.params.characterId);
        const diaries = db.getDiaries(req.params.characterId);
        res.json({
            isUnlocked: char ? char.is_diary_unlocked === 1 : false,
            entries: diaries
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// 9.5 Delete a Diary Entry
app.delete('/api/diaries/:id', authMiddleware, (req, res) => {
    const db = req.db;
    try {
        if (typeof db.deleteDiary !== 'function') {
            return res.status(501).json({ error: 'Not implemented' });
        }
        db.deleteDiary(req.params.id);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// 10. Unlock Diaries for a Character (Password-lock mechanic)
app.post('/api/diaries/:characterId/unlock', authMiddleware, (req, res) => {
    const db = req.db;
    const engine = req.engine;
    const memory = req.memory;
    const wsClients = getWsClients(req.user.id);
    try {
        const { password } = req.body;
        if (!password) return res.status(400).json({ success: false, reason: 'No password provided.' });
        const result = db.verifyAndUnlockDiary(req.params.characterId, password);
        if (result.success) {
            res.json({ success: true });
        } else {
            res.status(403).json({ success: false, reason: result.reason });
        }
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});


// 11. User Profile (GET handler is already registered above at route 0.5)

app.put('/api/user', authMiddleware, (req, res) => {
    const db = req.db;
    const engine = req.engine;
    const memory = req.memory;
    const wsClients = getWsClients(req.user.id);
    try {
        db.updateUserProfile(req.body);
        // If group proactive settings changed, restart all group timers immediately
        const proactiveKeys = ['group_proactive_enabled', 'group_interval_min', 'group_interval_max'];
        if (proactiveKeys.some(k => k in req.body)) {
            engine.startGroupProactiveTimers(wsClients);
        }
        res.json({ success: true, profile: { ...(db.getUserProfile() || {}), username: req.user.username, role: req.user.role || 'user' } });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// 11.5 Theme Generation Helper & 11.6 AI Theme Generation
// 鈹€鈹€ MOVED TO DLC: server/plugins/theme/index.js 鈹€鈹€

// 11.8 Context Token Stats
app.get('/api/characters/:id/context-stats', authMiddleware, async (req, res) => {
    const db = req.db;
    try {
        const charId = req.params.id;
        const character = db.getCharacter(charId);
        if (!character) return res.status(404).json({ error: 'Character not found' });

        const { getUserDb } = require('./db');
        const { getMemory } = require('./memory');
        const memory = getMemory(req.user.id);
        const engineContextWrapper = { getUserDb, getMemory, userId: req.user.id };

        // relationships exist in the DLC, so fallback to just friends or a raw DB query if method doesn't exist
        const isDlcActive = typeof db.getCharRelationships === 'function';
        const relationships = isDlcActive ? db.getCharRelationships(charId) : db.getCharacters().filter(c => c.id !== charId);
        const activeTargets = relationships.map(r => isDlcActive ? db.getCharacter(r.target_id || r.targetId) : r).filter(Boolean).slice(0, 5);

        // Initialize City DLC if not already attached to this request's db instance
        if (!db.city) {
            try {
                const initCityDb = require('./plugins/city/cityDb');
                db.city = initCityDb(typeof db.getRawDb === 'function' ? db.getRawDb() : db);
            } catch (e) { }
        }

        const { buildUniversalContext } = require('./contextBuilder');
        const { getDefaultGuidelines } = require('./engine');
        const universalResult = await buildUniversalContext(engineContextWrapper, character, '', false, activeTargets);
        const breakdown = { ...(universalResult.breakdown || {}) };

        const conversationDigest = typeof db.getConversationDigest === 'function'
            ? db.getConversationDigest(charId, { trackHit: false })
            : null;

        // Calculate X (Recent Chat History - based on context_msg_limit)
        const contextLimit = character.context_msg_limit || 60;
        const recentMsgs = db.getVisibleMessages(charId, contextLimit);
        const liveHistoryWindowSize = conversationDigest?.digest_text
            ? getDigestTailWindowSize(contextLimit, recentMsgs.length)
            : recentMsgs.length;
        const liveMsgs = conversationDigest?.digest_text
            ? recentMsgs.slice(-liveHistoryWindowSize)
            : recentMsgs;
        const x_chat_text = liveMsgs.map(m => m.content || '').join('\n');
        breakdown.x_chat = getTokenCount(x_chat_text);

        const systemPromptPreamble = `You are playing the role of ${character.name}.\nPersona:\n${character.persona || 'No specific persona given.'}\n\nWorld Info:\n${character.world_info || 'No specific world info.'}\n\nContext:\n${universalResult.preamble}`;
        let finalSystemPrompt = systemPromptPreamble;

        try {
            const unclaimed = typeof db.getUnclaimedTransfersFrom === 'function'
                ? db.getUnclaimedTransfersFrom(character.id, character.id)
                : [];
            if (unclaimed && unclaimed.length > 0) {
                const recent = unclaimed.filter(t => (Date.now() - t.created_at) < (24 * 60 * 60 * 1000));
                if (recent.length > 0) {
                    const total = recent.reduce((s, t) => s + t.amount, 0).toFixed(2);
                    const minutesAgo = Math.round((Date.now() - recent[0].created_at) / 60000);
                    const unclaimedNote = recent[0].note ? `（留言：“${recent[0].note}”）` : '';
                    finalSystemPrompt += `\n[系统提示] 你在 ${minutesAgo} 分钟前给 ${db.getUserProfile()?.name || '用户'} 转了一笔账，共 ¥${total}${unclaimedNote}，但对方还没有领取。你可以按自己的性格顺手提一句，也可以不提。\n`;
                }
            }
        } catch (e) { /* ignore */ }

        finalSystemPrompt += `\n${getDefaultGuidelines()}`;
        const supplementalCharacterPrompt = String(character.system_prompt || '').trim();
        if (supplementalCharacterPrompt) {
            finalSystemPrompt += `\n\n[Character-Specific Supplemental Rules]\n${supplementalCharacterPrompt}`;
        }
        let digestBlock = '';
        if (conversationDigest?.digest_text && typeof memory.formatConversationDigestForPrompt === 'function') {
            digestBlock = memory.formatConversationDigestForPrompt(conversationDigest);
            if (digestBlock) {
                finalSystemPrompt += `\n\n${digestBlock}`;
            }
        }

        const ownRecentMsgs = recentMsgs
            .filter(m => m.role === 'character')
            .slice(-6)
            .map(m => `"${String(m.content || '').substring(0, 200)}"`)
            .join(', ');
        let antiRepeat = '';
        if (ownRecentMsgs) {
            antiRepeat = `\n\n[Anti-Repeat]: Your recent messages were: ${ownRecentMsgs}. Do NOT repeat, reuse, or closely paraphrase any of these. Your next message must be distinctly different in both TOPIC and WORDING.`;
            if ((character.pressure_level || 0) >= 2) {
                antiRepeat += ` Since you are feeling anxious, try a COMPLETELY NEW approach: talk about what you're doing right now, share a random thought, ask a question about something unrelated, express your feelings from a different angle, or bring up a memory. DO NOT just rephrase "why aren't you replying" again.`;
            }
            finalSystemPrompt += antiRepeat;
        }

        const transformedHistory = liveMsgs.map(m => ({
            role: m.role === 'character' ? 'assistant' : 'user',
            content: String(m.content || '')
        }));
        const transformedFullHistory = recentMsgs.map(m => ({
            role: m.role === 'character' ? 'assistant' : 'user',
            content: String(m.content || '')
        }));
        const estimatedWithCacheMessagesRaw = [
            { role: 'system', content: finalSystemPrompt },
            ...transformedHistory
        ];
        const estimatedWithoutCacheMessagesRaw = [
            {
                role: 'system',
                content: `${systemPromptPreamble}\n${getDefaultGuidelines()}${supplementalCharacterPrompt ? `\n\n[Character-Specific Supplemental Rules]\n${supplementalCharacterPrompt}` : ''}${antiRepeat}`
            },
            ...transformedFullHistory
        ];
        const useClaudePromptCacheShape = String(character.model_name || '').toLowerCase().includes('claude');
        const estimatedWithCacheMessages = useClaudePromptCacheShape
            ? buildClaudePromptCacheEstimateMessages(estimatedWithCacheMessagesRaw)
            : estimatedWithCacheMessagesRaw;
        const estimatedWithoutCacheMessages = useClaudePromptCacheShape
            ? buildClaudePromptCacheEstimateMessages(estimatedWithoutCacheMessagesRaw)
            : estimatedWithoutCacheMessagesRaw;
        const estimatedWithCacheMessageStats = estimateJsonWrapperTokensForMessages(estimatedWithCacheMessages);
        const estimatedWithoutCacheMessageStats = estimateJsonWrapperTokensForMessages(estimatedWithoutCacheMessages);
        const estimatedHistoryTokens = transformedHistory.reduce((sum, msg) => sum + getTokenCount(msg.content) + 6, 0);
        const estimatedFullHistoryTokens = transformedFullHistory.reduce((sum, msg) => sum + getTokenCount(msg.content) + 6, 0);
        const estimatedSystemPromptTokens = getTokenCount(finalSystemPrompt);
        const estimatedSystemPromptWithoutDigestTokens = getTokenCount(`${systemPromptPreamble}\n${getDefaultGuidelines()}${supplementalCharacterPrompt ? `\n\n[Character-Specific Supplemental Rules]\n${supplementalCharacterPrompt}` : ''}${antiRepeat}`);
        const estimatedMessageEnvelopeTokens = 8 + transformedHistory.length * 2;
        const estimatedFullMessageEnvelopeTokens = 8 + transformedFullHistory.length * 2;
        const estimatedWithCacheRequestBody = {
            model: character.model_name,
            messages: estimatedWithCacheMessages,
            max_tokens: Number(character.max_tokens || 2000),
            presence_penalty: Number(character.presence_penalty || 0),
            frequency_penalty: Number(character.frequency_penalty || 0),
        };
        const estimatedWithoutCacheRequestBody = {
            model: character.model_name,
            messages: estimatedWithoutCacheMessages,
            max_tokens: Number(character.max_tokens || 2000),
            presence_penalty: Number(character.presence_penalty || 0),
            frequency_penalty: Number(character.frequency_penalty || 0),
        };
        const estimatedWithoutCacheTokens = estimateRequestBodyTokens(estimatedWithoutCacheRequestBody);
        const estimatedWithCacheTokens = estimateRequestBodyTokens(estimatedWithCacheRequestBody);
        const finalPromptEstimate = estimatedWithCacheTokens;

        const estimatedDigestTokens = conversationDigest?.digest_text
            ? getTokenCount(memory.formatConversationDigestForPrompt(conversationDigest) || '')
            : 0;
        const estimatedTailTokens = getTokenCount(x_chat_text);
        const estimatedWithoutCacheXTokens = estimatedFullHistoryTokens;
        const estimatedWithCacheXTokens = Math.max(0, estimatedHistoryTokens - estimatedTailTokens);
        const estimatedComparableBaseTokens = Math.max(
            0,
            estimatedSystemPromptWithoutDigestTokens
            - Number(breakdown.city_x_y || 0)
            - Number(breakdown.z_memory || 0)
            - Number(breakdown.moments || 0)
            - Number(breakdown.q_impression || 0)
        );
        const estimatedWithoutCacheOtherTokens = Math.max(
            0,
            estimatedWithoutCacheTokens
            - estimatedComparableBaseTokens
            - estimatedWithoutCacheXTokens
            - Number(breakdown.city_x_y || 0)
            - Number(breakdown.z_memory || 0)
            - Number(breakdown.moments || 0)
            - Number(breakdown.q_impression || 0)
        );
        const estimatedWithCacheOtherTokens = Math.max(
            0,
            estimatedWithCacheTokens
            - estimatedComparableBaseTokens
            - estimatedDigestTokens
            - estimatedWithCacheXTokens
            - estimatedTailTokens
            - Number(breakdown.city_x_y || 0)
            - Number(breakdown.z_memory || 0)
            - Number(breakdown.moments || 0)
            - Number(breakdown.q_impression || 0)
        );
        const estimatedWithoutCacheBaseTokens = Math.max(
            0,
            estimatedComparableBaseTokens
        );
        const estimatedWithCacheBaseTokens = Math.max(
            0,
            estimatedComparableBaseTokens
        );
        const estimatedRagInjectedTokens = Math.max(
            0,
            Number(breakdown.city_x_y || 0)
            + Number(breakdown.z_memory || 0)
            + Number(breakdown.moments || 0)
            + Number(breakdown.q_impression || 0)
        );
        breakdown.system_full = estimatedSystemPromptTokens;
        breakdown.history_full = estimatedHistoryTokens;
        breakdown.message_envelope = estimatedMessageEnvelopeTokens;

        let unsummarizedCount = 0;
        if (!character.sweep_initialized && typeof db.initializeSweepBaseline === 'function' && typeof db.getGroups === 'function') {
            const groups = db.getGroups().filter(g => g.members.some(m => m.member_id === character.id));
            const groupWindows = groups.map(g => ({ groupId: g.id, windowLimit: g.inject_limit ?? 5 }));
            db.initializeSweepBaseline(charId, contextLimit, groupWindows);
        } else if (character.sweep_initialized) {
            const privateWindow = character.context_msg_limit || 60;
            unsummarizedCount = typeof db.countOverflowMessages === 'function'
                ? db.countOverflowMessages(charId, privateWindow)
                : 0;

            if (typeof db.countOverflowGroupMessages === 'function' && typeof db.getGroups === 'function') {
                const groups = db.getGroups().filter(g => g.members.some(m => m.member_id === character.id));
                for (const g of groups) {
                    const groupWindow = g.inject_limit ?? 5;
                    unsummarizedCount += db.countOverflowGroupMessages(g.id, groupWindow);
                }
            }
        }

        // Calculate total tokens
        let total = 0;
        if (breakdown) {
            total = Object.values(breakdown).reduce((sum, val) => sum + (typeof val === 'number' ? val : 0), 0);
        }

        const rawDb = typeof db.getRawDb === 'function' ? db.getRawDb() : null;
        const actualUsage = typeof db.getTokenUsageSummary === 'function'
            ? db.getTokenUsageSummary(charId)
            : { request_count: 0, prompt_tokens: 0, completion_tokens: 0, by_context: [] };
        const mainUsageRow = rawDb
            ? rawDb.prepare(`
                SELECT
                    COUNT(*) AS request_count,
                    COALESCE(SUM(prompt_tokens), 0) AS prompt_tokens,
                    COALESCE(SUM(completion_tokens), 0) AS completion_tokens
                FROM token_usage
                WHERE character_id = ?
                  AND context_type NOT LIKE 'memory_%'
                  AND context_type NOT IN ('chat_intent', 'conversation_digest_update')
            `).get(charId)
            : null;
        const auxiliaryUsageRow = rawDb
            ? rawDb.prepare(`
                SELECT
                    COUNT(*) AS request_count,
                    COALESCE(SUM(prompt_tokens), 0) AS prompt_tokens,
                    COALESCE(SUM(completion_tokens), 0) AS completion_tokens
                FROM token_usage
                WHERE character_id = ?
                  AND (
                    context_type LIKE 'memory_%'
                    OR context_type IN ('chat_intent', 'conversation_digest_update')
                  )
            `).get(charId)
            : null;
        const latestUsageRow = rawDb
            ? rawDb.prepare('SELECT context_type, prompt_tokens, completion_tokens, timestamp FROM token_usage WHERE character_id = ? ORDER BY id DESC LIMIT 1').get(charId)
            : null;
        const latestConversationUsageRow = rawDb
            ? rawDb.prepare(`
                SELECT context_type, prompt_tokens, completion_tokens, timestamp
                FROM token_usage
                WHERE character_id = ?
                  AND context_type = 'chat'
                ORDER BY id DESC
                LIMIT 1
            `).get(charId)
            : null;
        const cacheUsageRow = rawDb
            ? rawDb.prepare(`
                SELECT
                    COUNT(*) AS entries_count,
                    COALESCE(SUM(hit_count), 0) AS hit_count,
                    COALESCE(SUM(prompt_tokens * hit_count), 0) AS saved_prompt_tokens,
                    COALESCE(SUM(completion_tokens * hit_count), 0) AS saved_completion_tokens,
                    MAX(last_hit_at) AS last_cache_hit_at
                FROM llm_cache
                WHERE character_id = ?
                  AND expires_at > ?
            `).get(charId, Date.now())
            : null;
        const promptBlockUsageRow = rawDb
            ? rawDb.prepare(`
                SELECT
                    COUNT(*) AS entries_count,
                    COALESCE(SUM(hit_count), 0) AS hit_count,
                    MAX(last_hit_at) AS last_hit_at,
                    MAX(updated_at) AS last_write_at
                FROM prompt_block_cache
                WHERE character_id = ?
            `).get(charId)
            : null;
        const historyWindowUsageRow = rawDb
            ? rawDb.prepare(`
                SELECT
                    COUNT(*) AS entries_count,
                    COALESCE(SUM(hit_count), 0) AS hit_count,
                    MAX(last_hit_at) AS last_hit_at,
                    MAX(updated_at) AS last_write_at
                FROM history_window_cache
                WHERE character_id = ?
            `).get(charId)
            : null;
        const conversationDigestRow = rawDb
            ? rawDb.prepare(`
                SELECT
                    COUNT(*) AS entries_count,
                    COALESCE(SUM(hit_count), 0) AS hit_count,
                    MAX(last_hit_at) AS last_hit_at,
                    MAX(updated_at) AS last_write_at,
                    MAX(last_message_id) AS last_message_id
                FROM conversation_digest_cache
                WHERE character_id = ?
            `).get(charId)
            : null;
        const latestConversationSnapshotRow = rawDb
            ? rawDb.prepare(`
                SELECT meta, timestamp
                FROM llm_debug_logs
                WHERE character_id = ?
                  AND direction = 'input'
                  AND context_type = 'private_reply'
                ORDER BY id DESC
                LIMIT 1
            `).get(charId)
            : null;
        const latestConversationAttemptRow = rawDb
            ? rawDb.prepare(`
                SELECT meta, timestamp
                FROM llm_debug_logs
                WHERE character_id = ?
                  AND direction = 'attempt_result'
                  AND context_type = 'private_reply'
                ORDER BY id DESC
                LIMIT 1
            `).get(charId)
            : null;
        let latestConversationSnapshot = null;
        try {
            latestConversationSnapshot = latestConversationSnapshotRow?.meta
                ? JSON.parse(latestConversationSnapshotRow.meta)?.context_snapshot || null
                : null;
        } catch (_) {
            latestConversationSnapshot = null;
        }
        let latestConversationAttemptMeta = null;
        try {
            latestConversationAttemptMeta = latestConversationAttemptRow?.meta
                ? JSON.parse(latestConversationAttemptRow.meta)
                : null;
        } catch (_) {
            latestConversationAttemptMeta = null;
        }

        const lastConversationPromptTokens = Number(latestConversationUsageRow?.prompt_tokens || 0);
        let loggedCachedRequestBodyTokens = Number(latestConversationAttemptMeta?.requestBodyTokens || 0);
        let loggedUncachedRequestBodyTokens = Number(latestConversationAttemptMeta?.uncachedRequestBodyTokens || 0);
        try {
            if (!loggedCachedRequestBodyTokens && latestConversationAttemptMeta?.requestBodyPreview) {
                loggedCachedRequestBodyTokens = getTokenCount(latestConversationAttemptMeta.requestBodyPreview);
                const parsedCachedRequestBody = JSON.parse(latestConversationAttemptMeta.requestBodyPreview);
                loggedCachedRequestBodyTokens = getTokenCount(JSON.stringify(parsedCachedRequestBody));
            }
            if (!loggedUncachedRequestBodyTokens && latestConversationAttemptMeta?.uncachedRequestBodyPreview) {
                const parsedUncachedRequestBody = JSON.parse(latestConversationAttemptMeta.uncachedRequestBodyPreview);
                loggedUncachedRequestBodyTokens = getTokenCount(JSON.stringify(parsedUncachedRequestBody));
            }
        } catch (e) {
            console.warn('[API] Failed to derive logged cached/uncached request body tokens:', e.message);
        }
        const validLoggedUncachedRequestBodyTokens = loggedUncachedRequestBodyTokens > loggedCachedRequestBodyTokens
            ? loggedUncachedRequestBodyTokens
            : 0;
        const snapshotWithoutCacheTokens = Number(
            validLoggedUncachedRequestBodyTokens
            || latestConversationSnapshot?.estimated_without_cache_tokens
            || estimatedWithoutCacheTokens
            || 0
        );
        const snapshotWithCacheTokens = Number(
            loggedCachedRequestBodyTokens
            || latestConversationSnapshot?.estimated_with_cache_tokens
            || estimatedWithCacheTokens
            || 0
        );
        const snapshotRagInjectedTokens = Math.max(
            0,
            Number(
                latestConversationSnapshot?.estimated_rag_injected_tokens
                || latestConversationSnapshot?.breakdown?.z_memory
                || estimatedRagInjectedTokens
                || 0
            )
        );
        let lastConversationRequestBodyTokens = 0;
        let lastConversationMessagesJsonTokens = 0;
        let lastConversationPlainMessageTokens = 0;
        let lastConversationJsonWrapperTokens = 0;
        let lastConversationOtherTokens = 0;
        try {
            if (latestConversationAttemptMeta?.requestBodyPreview) {
                const requestBody = JSON.parse(latestConversationAttemptMeta.requestBodyPreview);
                const requestMessages = Array.isArray(requestBody?.messages) ? requestBody.messages : [];
                lastConversationRequestBodyTokens = getTokenCount(JSON.stringify(requestBody));
                lastConversationMessagesJsonTokens = getTokenCount(JSON.stringify(requestMessages));
                lastConversationPlainMessageTokens = requestMessages.reduce((sum, message) => {
                    return sum + getTokenCount(extractMessagePlainText(message?.content || ''));
                }, 0);
                lastConversationJsonWrapperTokens = Math.max(
                    0,
                    lastConversationMessagesJsonTokens - lastConversationPlainMessageTokens
                );
                lastConversationOtherTokens = Math.max(
                    0,
                    lastConversationRequestBodyTokens - (
                        getTokenCount(extractMessagePlainText(requestMessages?.[0]?.content || ''))
                        + requestMessages.slice(1).reduce((sum, message) => {
                            return sum + getTokenCount(extractMessagePlainText(message?.content || ''));
                        }, 0)
                    )
                );
            }
        } catch (e) {
            console.warn('[API] Failed to derive JSON wrapper token stats:', e.message);
        }
        const cacheOnlyWithoutRagBaselineTokens = Math.max(0, snapshotWithoutCacheTokens - snapshotRagInjectedTokens);
        const cacheOnlyActualInputTokens = Math.max(0, lastConversationPromptTokens - snapshotRagInjectedTokens);
        const cacheOnlySavedTokens = Math.max(0, cacheOnlyWithoutRagBaselineTokens - cacheOnlyActualInputTokens);
        const cacheOnlyHitRatePercent = cacheOnlyWithoutRagBaselineTokens > 0
            ? Math.round((cacheOnlySavedTokens / cacheOnlyWithoutRagBaselineTokens) * 100)
            : 0;
        const totalSavedIncludingRagTokens = Math.max(0, snapshotWithoutCacheTokens - lastConversationPromptTokens);
        const totalSavedIncludingRagRatePercent = snapshotWithoutCacheTokens > 0
            ? Math.round((totalSavedIncludingRagTokens / snapshotWithoutCacheTokens) * 100)
            : 0;
        const lastConversationModuleRoutes = latestConversationSnapshot?.module_routes || {};
        const lastConversationRoutedToCity = !!(
            lastConversationModuleRoutes.city_detail
            || lastConversationModuleRoutes.city
            || lastConversationModuleRoutes.city_x_y
            || lastConversationModuleRoutes.city_social
        );
        const lastConversationUsedRag = snapshotRagInjectedTokens > 0;
        const lastConversationTopicSwitch = latestConversationSnapshot?.topic_switch || null;

        res.json({
            success: true,
            stats: {
                ...breakdown,
                total: finalPromptEstimate || total,
                total_breakdown_only: total,
                w_unsummarized_count: unsummarizedCount,
                w_sweep_limit: character.sweep_limit || 30,
                w_last_error: character.sweep_last_error || '',
                w_last_run_at: character.sweep_last_run_at || 0,
                w_last_success_at: character.sweep_last_success_at || 0,
                w_last_saved_count: character.sweep_last_saved_count || 0,
                estimated_system_prompt_tokens: estimatedSystemPromptTokens,
                estimated_history_tokens: estimatedHistoryTokens,
                estimated_message_envelope_tokens: estimatedMessageEnvelopeTokens,
                estimated_digest_tokens: estimatedDigestTokens,
                estimated_without_cache_tokens: estimatedWithoutCacheTokens,
                estimated_with_cache_tokens: estimatedWithCacheTokens,
                estimated_tail_tokens: estimatedTailTokens,
                estimated_without_cache_x_tokens: estimatedWithoutCacheXTokens,
                estimated_with_cache_x_tokens: estimatedWithCacheXTokens,
                estimated_full_history_tokens: estimatedFullHistoryTokens,
                estimated_full_message_envelope_tokens: estimatedFullMessageEnvelopeTokens,
                estimated_without_cache_base_tokens: estimatedWithoutCacheBaseTokens,
                estimated_with_cache_base_tokens: estimatedWithCacheBaseTokens,
                estimated_without_cache_other_tokens: estimatedWithoutCacheOtherTokens,
                estimated_with_cache_other_tokens: estimatedWithCacheOtherTokens,
                estimated_rag_injected_tokens: snapshotRagInjectedTokens,
                actual_prompt_tokens_total: mainUsageRow?.prompt_tokens || 0,
                actual_completion_tokens_total: mainUsageRow?.completion_tokens || 0,
                actual_request_count: mainUsageRow?.request_count || 0,
                actual_total_tokens: (mainUsageRow?.prompt_tokens || 0) + (mainUsageRow?.completion_tokens || 0),
                auxiliary_prompt_tokens_total: auxiliaryUsageRow?.prompt_tokens || 0,
                auxiliary_completion_tokens_total: auxiliaryUsageRow?.completion_tokens || 0,
                auxiliary_request_count: auxiliaryUsageRow?.request_count || 0,
                auxiliary_total_tokens: (auxiliaryUsageRow?.prompt_tokens || 0) + (auxiliaryUsageRow?.completion_tokens || 0),
                raw_all_prompt_tokens_total: actualUsage?.prompt_tokens || 0,
                raw_all_completion_tokens_total: actualUsage?.completion_tokens || 0,
                raw_all_request_count: actualUsage?.request_count || 0,
                raw_all_total_tokens: (actualUsage?.prompt_tokens || 0) + (actualUsage?.completion_tokens || 0),
                actual_by_context: actualUsage?.by_context || [],
                cache_entries_count: cacheUsageRow?.entries_count || 0,
                cache_hit_count: cacheUsageRow?.hit_count || 0,
                cache_saved_prompt_tokens: cacheUsageRow?.saved_prompt_tokens || 0,
                cache_saved_completion_tokens: cacheUsageRow?.saved_completion_tokens || 0,
                cache_saved_total_tokens: (cacheUsageRow?.saved_prompt_tokens || 0) + (cacheUsageRow?.saved_completion_tokens || 0),
                cache_last_hit_at: cacheUsageRow?.last_cache_hit_at || 0,
                block_cache_entries_count: promptBlockUsageRow?.entries_count || 0,
                block_cache_hit_count: promptBlockUsageRow?.hit_count || 0,
                block_cache_last_hit_at: promptBlockUsageRow?.last_hit_at || 0,
                block_cache_last_write_at: promptBlockUsageRow?.last_write_at || 0,
                history_cache_entries_count: historyWindowUsageRow?.entries_count || 0,
                history_cache_hit_count: historyWindowUsageRow?.hit_count || 0,
                history_cache_last_hit_at: historyWindowUsageRow?.last_hit_at || 0,
                history_cache_last_write_at: historyWindowUsageRow?.last_write_at || 0,
                digest_cache_entries_count: conversationDigestRow?.entries_count || 0,
                digest_cache_hit_count: conversationDigestRow?.hit_count || 0,
                digest_cache_last_hit_at: conversationDigestRow?.last_hit_at || 0,
                digest_cache_last_write_at: conversationDigestRow?.last_write_at || 0,
                digest_cache_last_message_id: conversationDigestRow?.last_message_id || 0,
                digest_active: !!conversationDigest?.digest_text,
                digest_live_history_window_size: liveHistoryWindowSize,
                last_actual_prompt_tokens: latestUsageRow?.prompt_tokens || 0,
                last_actual_completion_tokens: latestUsageRow?.completion_tokens || 0,
                last_actual_context_type: latestUsageRow?.context_type || '',
                last_actual_timestamp: latestUsageRow?.timestamp || 0,
                last_conversation_prompt_tokens: lastConversationPromptTokens,
                last_conversation_completion_tokens: latestConversationUsageRow?.completion_tokens || 0,
                last_conversation_context_type: latestConversationUsageRow?.context_type || '',
                last_conversation_timestamp: latestConversationUsageRow?.timestamp || 0,
                last_conversation_snapshot_timestamp: Number(latestConversationSnapshot?.timestamp || latestConversationSnapshotRow?.timestamp || 0),
                last_conversation_estimated_without_cache_tokens: snapshotWithoutCacheTokens,
                last_conversation_estimated_with_cache_tokens: snapshotWithCacheTokens,
                last_conversation_request_body_tokens: lastConversationRequestBodyTokens,
                last_conversation_messages_json_tokens: lastConversationMessagesJsonTokens,
                last_conversation_plain_message_tokens: lastConversationPlainMessageTokens,
                last_conversation_json_wrapper_tokens: lastConversationJsonWrapperTokens,
                last_conversation_other_tokens: lastConversationOtherTokens,
                last_conversation_routed_to_city: lastConversationRoutedToCity,
                last_conversation_used_rag: lastConversationUsedRag,
                last_conversation_topic_switch_decision: String(lastConversationTopicSwitch?.decision || '').trim(),
                last_conversation_topic_switch_reason: String(lastConversationTopicSwitch?.reason || '').trim(),
                last_conversation_topic_switch_fallback: !!lastConversationTopicSwitch?.fallback,
                cache_only_without_rag_baseline_tokens: cacheOnlyWithoutRagBaselineTokens,
                cache_only_actual_input_tokens: cacheOnlyActualInputTokens,
                cache_only_saved_tokens: cacheOnlySavedTokens,
                cache_only_hit_rate_percent: cacheOnlyHitRatePercent,
                total_saved_including_rag_tokens: totalSavedIncludingRagTokens,
                total_saved_including_rag_rate_percent: totalSavedIncludingRagRatePercent
            }
        });
    } catch (e) {
        console.error('[API] Context Stats error:', e.message);
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/characters/:id/cache-stats', authMiddleware, (req, res) => {
    const db = req.db;
    try {
        const charId = req.params.id;
        const character = typeof db.getCharacter === 'function' ? db.getCharacter(charId) : null;
        if (!character) return res.status(404).json({ error: 'Character not found' });

        const rawDb = typeof db.getRawDb === 'function' ? db.getRawDb() : null;
        const statsRow = rawDb
            ? rawDb.prepare(`
                SELECT
                    COUNT(*) AS entries_count,
                    COALESCE(SUM(hit_count), 0) AS hit_count,
                    MAX(last_hit_at) AS last_hit_at,
                    MAX(created_at) AS last_write_at,
                    MAX(expires_at) AS last_expires_at
                FROM llm_cache
                WHERE character_id = ?
                  AND expires_at > ?
            `).get(charId, Date.now())
            : null;
        const typeRows = rawDb
            ? rawDb.prepare(`
                SELECT
                    cache_type,
                    COUNT(*) AS entries_count,
                    COALESCE(SUM(hit_count), 0) AS hit_count
                FROM llm_cache
                WHERE character_id = ?
                  AND expires_at > ?
                GROUP BY cache_type
                ORDER BY entries_count DESC, hit_count DESC
            `).all(charId, Date.now())
            : [];
        const promptBlockRows = rawDb
            ? rawDb.prepare(`
                SELECT
                    block_type,
                    COUNT(*) AS entries_count,
                    COALESCE(SUM(hit_count), 0) AS hit_count,
                    MAX(last_hit_at) AS last_hit_at,
                    MAX(updated_at) AS last_write_at
                FROM prompt_block_cache
                WHERE character_id = ?
                GROUP BY block_type
                ORDER BY entries_count DESC, hit_count DESC
            `).all(charId)
            : [];
        const historyWindowRows = rawDb
            ? rawDb.prepare(`
                SELECT
                    window_type,
                    COUNT(*) AS entries_count,
                    COALESCE(SUM(hit_count), 0) AS hit_count,
                    MAX(last_hit_at) AS last_hit_at,
                    MAX(updated_at) AS last_write_at
                FROM history_window_cache
                WHERE character_id = ?
                GROUP BY window_type
                ORDER BY entries_count DESC, hit_count DESC
            `).all(charId)
            : [];
        const promptBlockSummary = rawDb
            ? rawDb.prepare(`
                SELECT
                    COUNT(*) AS entries_count,
                    COALESCE(SUM(hit_count), 0) AS hit_count,
                    MAX(last_hit_at) AS last_hit_at,
                    MAX(updated_at) AS last_write_at
                FROM prompt_block_cache
                WHERE character_id = ?
            `).get(charId)
            : null;
        const historyWindowSummary = rawDb
            ? rawDb.prepare(`
                SELECT
                    COUNT(*) AS entries_count,
                    COALESCE(SUM(hit_count), 0) AS hit_count,
                    MAX(last_hit_at) AS last_hit_at,
                    MAX(updated_at) AS last_write_at
                FROM history_window_cache
                WHERE character_id = ?
            `).get(charId)
            : null;
        const conversationDigestSummary = rawDb
            ? rawDb.prepare(`
                SELECT
                    COUNT(*) AS entries_count,
                    COALESCE(SUM(hit_count), 0) AS hit_count,
                    MAX(last_hit_at) AS last_hit_at,
                    MAX(updated_at) AS last_write_at,
                    MAX(last_message_id) AS last_message_id
                FROM conversation_digest_cache
                WHERE character_id = ?
            `).get(charId)
            : null;

        res.json({
            success: true,
            stats: {
                character_id: charId,
                character_name: character.name || charId,
                entries_count: Number(statsRow?.entries_count || 0),
                hit_count: Number(statsRow?.hit_count || 0),
                last_hit_at: Number(statsRow?.last_hit_at || 0),
                last_write_at: Number(statsRow?.last_write_at || 0),
                last_expires_at: Number(statsRow?.last_expires_at || 0),
                prompt_block_entries_count: Number(promptBlockSummary?.entries_count || 0),
                prompt_block_hit_count: Number(promptBlockSummary?.hit_count || 0),
                prompt_block_last_hit_at: Number(promptBlockSummary?.last_hit_at || 0),
                prompt_block_last_write_at: Number(promptBlockSummary?.last_write_at || 0),
                history_window_entries_count: Number(historyWindowSummary?.entries_count || 0),
                history_window_hit_count: Number(historyWindowSummary?.hit_count || 0),
                history_window_last_hit_at: Number(historyWindowSummary?.last_hit_at || 0),
                history_window_last_write_at: Number(historyWindowSummary?.last_write_at || 0),
                digest_entries_count: Number(conversationDigestSummary?.entries_count || 0),
                digest_hit_count: Number(conversationDigestSummary?.hit_count || 0),
                digest_last_hit_at: Number(conversationDigestSummary?.last_hit_at || 0),
                digest_last_write_at: Number(conversationDigestSummary?.last_write_at || 0),
                digest_last_message_id: Number(conversationDigestSummary?.last_message_id || 0),
                by_type: Array.isArray(typeRows) ? typeRows.map(row => ({
                    cache_type: row.cache_type,
                    entries_count: Number(row.entries_count || 0),
                    hit_count: Number(row.hit_count || 0)
                })) : [],
                prompt_blocks: Array.isArray(promptBlockRows) ? promptBlockRows.map(row => ({
                    block_type: row.block_type,
                    entries_count: Number(row.entries_count || 0),
                    hit_count: Number(row.hit_count || 0),
                    last_hit_at: Number(row.last_hit_at || 0),
                    last_write_at: Number(row.last_write_at || 0)
                })) : [],
                history_windows: Array.isArray(historyWindowRows) ? historyWindowRows.map(row => ({
                    window_type: row.window_type,
                    entries_count: Number(row.entries_count || 0),
                    hit_count: Number(row.hit_count || 0),
                    last_hit_at: Number(row.last_hit_at || 0),
                    last_write_at: Number(row.last_write_at || 0)
                })) : []
            }
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// 12. Delete Character
app.delete('/api/characters/:id', authMiddleware, async (req, res) => {
    const db = req.db;
    const engine = req.engine;
    const memory = req.memory;
    const wsClients = getWsClients(req.user.id);
    try {
        const charId = req.params.id;
        const charToDelete = db.getCharacter(charId);
        const charName = charToDelete?.name || '';

        // 1. Stop any running engine timers for this character
        engine.stopTimer(charId);

        // 2. Wipe vector memory index for this character
        try {
            await memory.wipeIndex(charId);
        } catch (e) {
            console.error(`[Delete] Failed to wipe vector index for char ${charId}:`, e.message);
        }

        // 3. Clean up other characters' memories that mention the deleted char
        if (charName) {
            const allChars = db.getCharacters();
            for (const otherChar of allChars) {
                if (String(otherChar.id) === String(charId)) continue;
                // Remove memories where the deleted char's name appears in the 'people' field
                const otherMemories = db.getMemories(otherChar.id);
                for (const mem of otherMemories) {
                    if (mem.people && mem.people.includes(charName)) {
                        db.deleteMemory(mem.id);
                    }
                }
            }
        }

        // 4. Delete the character (handles messages, moments, groups, relationships, etc.)
        db.deleteCharacter(charId);

        // 5. Notify frontend
        engine.broadcastEvent?.(wsClients, { type: 'character_deleted', characterId: charId });
        res.json({ success: true });
    } catch (e) {
        console.error('[Delete] Error deleting character:', e.message);
        res.status(500).json({ error: e.message });
    }
});

// 13. Friendships & Relationships
// 鈹€鈹€ MOVED TO DLC: server/plugins/relationships/index.js 鈹€鈹€

// 鈹€鈹€鈹€ Economy System (Transfers, Wallet, Red Packets) 鈹€鈹€ MOVED TO DLC 鈹€鈹€鈹€鈹€鈹€
// See: server/plugins/economy/index.js


// 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
// Serve React Frontend (Production)
// 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
const clientDistPath = path.join(__dirname, '..', 'client', 'dist');
app.use(express.static(clientDistPath));

// Catch-all route to serve the React app for any unhandled paths (client-side routing)
app.use((req, res, next) => {
    // Exclude API and upload paths from SPA fallback
    if (req.path.startsWith('/api/') || req.path.startsWith('/uploads/')) {
        return next();
    }
    if (req.method === 'GET') {
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');
        res.sendFile(path.join(clientDistPath, 'index.html'));
    } else {
        next();
    }
});


// 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
// Start listening
console.log('[Express] Attempting to listen on port 8000...');
const PORT = process.env.PORT || 8000;
server.listen(PORT, () => {
    console.log(`[Express] ChatPulse Server running on http://localhost:${PORT}`);
});

// Private background engines are now dynamically started via WS Auth

