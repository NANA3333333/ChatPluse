const fs = require('fs');

let idx = fs.readFileSync('index.js', 'utf8');

// 1. Inject auth requires if missing
if (!idx.includes("const authDb = require('./authDb');")) {
    idx = idx.replace("const { getUserDb } = require('./db');", "const { getUserDb } = require('./db');\nconst authDb = require('./authDb');\nconst jwt = require('jsonwebtoken');\nconst JWT_SECRET = process.env.JWT_SECRET || 'chatpulse_super_secret_key';");
}

// 2. Inject Auth Middleware and Routes exactly before REST API ROUTES
const authCode = `// ─── AUTHENTICATION MIDDLEWARE ──────────────────────────────────────────
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
        req.db = getUserDb(req.user.id);
        req.engine = getEngine(req.user.id);
        req.memory = getMemory(req.user.id);
        next();
    } catch (e) {
        return res.status(401).json({ error: 'Invalid token' });
    }
};

// ─── AUTH ROUTES ────────────────────────────────────────────────────────
app.post('/api/auth/register', (req, res) => {
    try {
        const { username, password } = req.body;
        if (!username || !password) return res.status(400).json({ error: 'Missing username or password' });
        const result = authDb.createUser(username, password);
        if (!result.success) return res.status(400).json({ error: result.error });
        const token = jwt.sign({ id: result.user.id, username: result.user.username }, JWT_SECRET, { expiresIn: '30d' });
        getUserDb(result.user.id);
        res.json({ success: true, token, user: result.user });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/auth/login', (req, res) => {
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

// REST API ROUTES`;

if (!idx.includes('authMiddleware = (req, res, next) => {')) {
    idx = idx.replace('// REST API ROUTES', authCode);
}

// 3. Inject Group Interruption Logic (groupInterrupt)
if (!idx.includes('const groupInterrupt = {};')) {
    idx = idx.replace('const groupReplyLock = {};', 'const groupReplyLock = {};\nconst groupInterrupt = {};');
}

// Ensure the loop in triggerGroupAIChain checks groupInterrupt
const oldLoopCheck = `for (const member of mentionedFirst) {
                const char = db.getCharacter(member.member_id);`;
const newLoopCheck = `for (const member of mentionedFirst) {
                if (pausedGroups.has(groupId) || groupInterrupt[groupId]) {
                    console.log(\`[Group] Chain interrupted manually or by a new @mention.\`);
                    break;
                }
                const char = db.getCharacter(member.member_id);`;
if (idx.includes(oldLoopCheck)) {
    idx = idx.replace(oldLoopCheck, newLoopCheck);
}

// Ensure finally block clears groupInterrupt
const oldFinally = `} finally {
            delete groupReplyLock[groupId];

            // Deduplicate`;
const newFinally = `} finally {
            delete groupReplyLock[groupId];
            if (groupInterrupt[groupId]) {
                delete groupInterrupt[groupId];
                return; // Let user new debounce take over
            }

            // Deduplicate`;
if (idx.includes(oldFinally)) {
    idx = idx.replace(oldFinally, newFinally);
}

// Apply interrupt to app.post('/api/groups/:id/messages'
const oldPostMessagesDelay = `if (groupDebounceTimers[groupId]) {
            clearTimeout(groupDebounceTimers[groupId]);
        }
        // Mentions are time-sensitive`;
const newPostMessagesDelay = `if (groupDebounceTimers[groupId]) {
            clearTimeout(groupDebounceTimers[groupId]);
        }
        if (groupReplyLock[groupId]) {
            if (mentionedIds.length > 0 || isAtAll) {
                groupInterrupt[groupId] = true;
            }
        }
        // Mentions are time-sensitive`;
if (idx.includes(oldPostMessagesDelay)) {
    idx = idx.replace(oldPostMessagesDelay, newPostMessagesDelay);
}

fs.writeFileSync('index.js', idx);
console.log('fix4.js applied successfully!');
