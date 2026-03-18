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
const jwt = require('jsonwebtoken');
const path = require('path');
const fs = require('fs');

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
const { getMemory, extractMemoryFromContext, setWsClientsResolver } = require('./memory');
const { getTokenCount } = require('./utils/tokenizer');
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

// Define rate limiters
const authLimiter = rateLimit({
    windowMs: 5 * 60 * 1000, // 5 minutes
    max: 20, // limit each IP to 20 requests per windowMs for auth routes
    message: { error: 'Too many authentication attempts. Please try again later.' }
});

const apiLimiter = rateLimit({
    windowMs: 1 * 60 * 1000, // 1 minute
    max: 120, // limit each IP to 120 api requests per minute
    skip: (req) => {
        const ip = req.ip || req.socket?.remoteAddress || '';
        return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
    },
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

                // Spin up user-specific engine on first connect
                const engine = getEngine(decoded.id);
                // DLC hook: if Group Chat DLC registered a chain callback, wire it
                if (pluginContext.hooks?.groupChainCallback) {
                    engine.setGroupChainCallback(pluginContext.hooks.groupChainCallback);
                }
                engine.startEngine(clients);
                if (typeof engine.startGroupProactiveTimers === 'function') {
                    engine.startGroupProactiveTimers(clients);
                }
                console.log(`[WS] Authenticated & Engine Started for user: ${decoded.username}`);
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



// ─── AUTHENTICATION MIDDLEWARE ──────────────────────────────────────────
authDb.initAuthDb();

const authMiddleware = (req, res, next) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    const token = authHeader.split(' ')[1];
    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        req.user = decoded;
        authDb.updateLastActive(req.user.id);
        req.db = getUserDb(req.user.id);
        req.engine = getEngine(req.user.id);
        req.memory = getMemory(req.user.id);
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

// ─── AUTH ROUTES ────────────────────────────────────────────────────────
app.post('/api/auth/register', authLimiter, (req, res) => {
    try {
        const { username, password, inviteCode } = req.body;
        if (!username || !password) return res.status(400).json({ error: 'Missing username or password' });
        const result = authDb.createUser(username, password, inviteCode);
        if (!result.success) return res.status(400).json({ error: result.error });
        const token = jwt.sign({ id: result.user.id, username: result.user.username }, JWT_SECRET, { expiresIn: '30d' });
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
        const token = jwt.sign({ id: result.user.id, username: result.user.username }, JWT_SECRET, { expiresIn: '30d' });
        getUserDb(result.user.id);
        res.json({ success: true, token, user: result.user });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/auth/me', authMiddleware, (req, res) => {
    res.json({ success: true, user: req.user });
});

// ─── SYSTEM ROUTES ────────────────────────────────────────────────────────
app.get('/api/system/announcement', authMiddleware, (req, res) => {
    try {
        const ann = authDb.getLatestAnnouncement();
        res.json({ success: true, announcement: ann });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});


// ─── PLUGIN MANAGER ────────────────────────────────────────────────────────
const pluginContext = {
    wss,
    getWsClients,
    authDb,
    authMiddleware,
    getUserDb,
    getEngine,
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
// ─────────────────────────────────────────────────────────────

// 0.5 Get User Profile
app.get('/api/user', authMiddleware, (req, res) => {
    const db = req.db;
    try {
        const profile = typeof db.getUserProfile === 'function' ? db.getUserProfile() : null;
        res.json({ ...(profile || { name: req.user.username }), username: req.user.username });
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
        res.json({ success: true, profile: { ...(updatedProfile || { name: req.user.username }), username: req.user.username } });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// 1. Get all characters (Contacts list)
app.get('/api/characters', authMiddleware, (req, res) => {
    const db = req.db;
    const engine = req.engine;
    const memory = req.memory;
    const wsClients = getWsClients(req.user.id);
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
        const enriched = characters.map(c => ({
            ...c,
            unread_count: db.getUnreadCount(c.id),
            inventory: typeof db.city?.getInventory === 'function' ? db.city.getInventory(c.id) : []
        }));
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

        db.updateCharacter(data.id, data);
        // Reset proactive timer after settings change (do NOT call handleUserMessage —
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
    try {
        const id = req.params.id;
        const data = req.body;
        if (!id) return res.status(400).json({ error: 'Missing ID' });

        db.updateCharacter(id, data);
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
    const engine = req.engine;
    const memory = req.memory;
    const wsClients = getWsClients(req.user.id);
    try {
        const charId = req.params.characterId;
        const limit = parseInt(req.query.limit) || 100;
        const before = req.query.before;  // message ID cursor for older messages

        let messages;
        if (before) {
            messages = db.getMessagesBefore(charId, before, limit);
        } else {
            messages = db.getMessages(charId, limit);
            // Mark messages as read when user opens this chat (not when paging back)
            db.markMessagesRead(charId);
        }
        res.json(messages);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// 4. Send a message to a character (User initiates)
app.post('/api/messages', authMiddleware, (req, res) => {
    const db = req.db;
    const engine = req.engine;
    const memory = req.memory;
    const wsClients = getWsClients(req.user.id);
    try {
        const { characterId, content } = req.body;
        if (!characterId || !content) return res.status(400).json({ error: 'Missing characterId or content' });

        const charObj = db.getCharacter(characterId);

        // If character has blocked the user, save message but return blocked flag
        if (!charObj || charObj.is_blocked) {
            const { id: msgId, timestamp: msgTs } = db.addMessage(characterId, 'user', content);
            const savedMessage = { id: msgId, character_id: characterId, role: 'user', content, timestamp: msgTs, isBlocked: true };
            engine.broadcastNewMessage?.(wsClients, savedMessage);
            return res.json({ success: true, blocked: true, message: savedMessage });
        }

        // Add user message to DB
        const { id: msgId, timestamp: msgTs } = db.addMessage(characterId, 'user', content);
        const savedMessage = { id: msgId, character_id: characterId, role: 'user', content, timestamp: msgTs };

        // Mark previous character messages as read
        db.markMessagesRead(characterId);

        // Push user message to UI via WS (before triggering AI reply for correct ordering)
        engine.broadcastNewMessage?.(wsClients, savedMessage);

        // Tell the engine to handle the user message: it will trigger an immediate reply
        engine.handleUserMessage(characterId, wsClients);

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

        // Delete the error message from the DB if provided
        if (failedMessageId) {
            db.deleteMessage(failedMessageId);
        }

        // Tell the engine to re-attempt generating a reply based on the existing chat history
        engine.handleUserMessage(characterId, wsClients);

        res.json({ success: true });
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
        let deleted = 0;
        for (const id of messageIds) {
            db.deleteMessage(id);
            deleted++;
        }
        console.log(`[Messages] Batch deleted ${deleted} messages.`);
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
        engine.handleUserMessage(characterId, wsClients);

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
        const usedEmojis = Array.from(new Set(existingChars.map(c => c.emoji).filter(e => e && e !== '👤')));
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
            parsed.emoji = parsed.target_emoji || '👤';
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
        db.clearMessages(req.params.characterId);
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

        // ⚡ Stop the engine timer FIRST to minimize race-condition window
        engine.stopTimer(id);

        // Clear all data
        db.clearMessages(id);
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
        engine.handleUserMessage(id, wsClients);

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
        const mems = db.getMemories(req.params.characterId);
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

        const savedCount = await memory.sweepOverflowMemories(charObj);
        const refreshed = db.getCharacter(req.params.characterId);
        const lastError = refreshed?.sweep_last_error || '';

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
                        const contextContent = `[System] ${userName} 刚刚赞了你的朋友圈动态："${moment.content.substring(0, 50)}"。你可以在私聊中提及这件事。`;
                        db.addMessage(char.id, 'system', contextContent);
                        console.log(`[Moments] User liked ${char.name}'s moment. Triggering reaction (Rate: ${reactionRate}%).`);
                        setTimeout(() => {
                            try {
                                engine.handleUserMessage(char.id, wsClients);
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
                        const contextContent = `[System] ${userName} 刚刚评论了你的朋友圈动态："${moment.content.substring(0, 50)}"，评论说："${content}"。你可以在私聊中回应。`;
                        db.addMessage(char.id, 'system', contextContent);
                        console.log(`[Moments] User commented on ${char.name}'s moment. Triggering reaction (Rate: ${reactionRate}%).`);
                        setTimeout(() => {
                            try {
                                engine.handleUserMessage(char.id, wsClients);
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
        res.json({ success: true, profile: db.getUserProfile() });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// 11.5 Theme Generation Helper & 11.6 AI Theme Generation
// ── MOVED TO DLC: server/plugins/theme/index.js ──

// 11.8 Context Token Stats
app.get('/api/characters/:id/context-stats', authMiddleware, async (req, res) => {
    const db = req.db;
    try {
        const charId = req.params.id;
        const character = db.getCharacter(charId);
        if (!character) return res.status(404).json({ error: 'Character not found' });

        const { getUserDb } = require('./db');
        const { getMemory } = require('./memory');
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
        const { breakdown } = await buildUniversalContext(engineContextWrapper, character, '', false, activeTargets);

        // Calculate X (Recent Chat History - based on context_msg_limit)
        const contextLimit = character.context_msg_limit || 60;
        const recentMsgs = db.getVisibleMessages(charId, contextLimit);
        const x_chat_text = recentMsgs.map(m => m.content || '').join('\n');
        breakdown.x_chat = getTokenCount(x_chat_text);

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

        const actualUsage = typeof db.getTokenUsageSummary === 'function'
            ? db.getTokenUsageSummary(charId)
            : { request_count: 0, prompt_tokens: 0, completion_tokens: 0, by_context: [] };

        res.json({
            success: true,
            stats: {
                ...breakdown,
                total,
                w_unsummarized_count: unsummarizedCount,
                w_sweep_limit: character.sweep_limit || 30,
                w_last_error: character.sweep_last_error || '',
                w_last_run_at: character.sweep_last_run_at || 0,
                w_last_success_at: character.sweep_last_success_at || 0,
                w_last_saved_count: character.sweep_last_saved_count || 0,
                actual_prompt_tokens_total: actualUsage?.prompt_tokens || 0,
                actual_completion_tokens_total: actualUsage?.completion_tokens || 0,
                actual_request_count: actualUsage?.request_count || 0,
                actual_total_tokens: (actualUsage?.prompt_tokens || 0) + (actualUsage?.completion_tokens || 0),
                actual_by_context: actualUsage?.by_context || []
            }
        });
    } catch (e) {
        console.error('[API] Context Stats error:', e.message);
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
// ── MOVED TO DLC: server/plugins/relationships/index.js ──

// ─── Economy System (Transfers, Wallet, Red Packets) ── MOVED TO DLC ─────
// See: server/plugins/economy/index.js


// ─────────────────────────────────────────────────────────────
// Serve React Frontend (Production)
// ─────────────────────────────────────────────────────────────
const clientDistPath = path.join(__dirname, 'public');
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


// ─────────────────────────────────────────────────────────────
// Start listening
console.log('[Express] Attempting to listen on port 8000...');
const PORT = process.env.PORT || 8000;
server.listen(PORT, () => {
    console.log(`[Express] ChatPulse Server running on http://localhost:${PORT}`);
});

// Private background engines are now dynamically started via WS Auth
