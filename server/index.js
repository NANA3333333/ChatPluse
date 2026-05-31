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
const { enqueueBackgroundTask, getBackgroundQueueStats } = require('./backgroundQueue');
const { synthesizeSpeech, getTencentVoiceList } = require('./tts');
const {
    normalizeMemoryId,
    normalizeMemoryIdList,
    normalizeMemoryMaintenanceAutoRunControls,
    normalizeMemoryMaintenanceBatchOptions,
    normalizeMemoryMaintenanceLibraryOptions,
    normalizeMemoryMaintenanceSettingsPatch,
    normalizeOptionalMemoryId
} = require('./memoryInputGuards');
const qdrant = require('./qdrant');
const crypto = require('crypto');

let pluginContext = null;

function createRequestTraceId(prefix = 'req') {
    const randomPart = typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID().slice(0, 8)
        : Math.random().toString(36).slice(2, 10);
    return `${prefix}-${Date.now().toString(36)}-${randomPart}`;
}

function yieldToServerLoop() {
    return new Promise(resolve => setImmediate(resolve));
}

function buildDefaultAvatarUrl(seed = 'User') {
    const safeSeed = encodeURIComponent(String(seed || 'User').trim() || 'User');
    return `https://api.dicebear.com/7.x/shapes/svg?seed=${safeSeed}&backgroundColor=e8f0ff,fff5d6,e9f7ef,f5eafa,f1f5f9`;
}

function normalizePositiveMoney(value) {
    const amount = Number(value);
    if (!Number.isFinite(amount) || amount <= 0) return null;
    const rounded = +amount.toFixed(2);
    return rounded > 0 ? rounded : null;
}

function normalizePaymentNote(value, fallback = '') {
    if (value === undefined || value === null) return fallback;
    if (typeof value !== 'string') return null;
    return value.trim().slice(0, 120);
}

function normalizeQueryLimit(value, fallback, max) {
    if (value === undefined || value === null || String(value).trim() === '') return fallback;
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed <= 0) return null;
    return Math.min(parsed, max);
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

function formatContextStatsTimestamp(timestamp) {
    const ts = Number(timestamp || 0);
    if (!Number.isFinite(ts) || ts <= 0) return '';
    try {
        return new Date(ts).toLocaleString('zh-CN', {
            hour12: false,
            year: 'numeric',
            month: 'numeric',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit'
        });
    } catch (_) {
        return '';
    }
}

function formatContextStatsHistoryMessage(db, character, message) {
    const role = String(message?.role || '').trim();
    if (role === 'character') return String(message?.content || '');
    const speaker = role === 'user'
        ? String(db.getUserProfile?.()?.name || 'User').trim()
        : (role === 'character' ? String(character?.name || 'Assistant').trim() : 'System/Event');
    const timestamp = formatContextStatsTimestamp(message?.timestamp);
    const prefix = timestamp ? `[${timestamp}] ${speaker}:` : `${speaker}:`;
    return `${prefix} ${String(message?.content || '')}`;
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

const allowedImageMimeTypes = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const allowedImageExtensions = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp']);

function isAllowedImageUploadMetadata(file) {
    const ext = path.extname(file.originalname || '').toLowerCase();
    const mime = String(file.mimetype || '').toLowerCase();
    return allowedImageExtensions.has(ext) && allowedImageMimeTypes.has(mime);
}

function isValidImageUploadContent(file) {
    const ext = path.extname(file.originalname || file.filename || '').toLowerCase();
    const header = fs.readFileSync(file.path).subarray(0, 16);

    if ((ext === '.jpg' || ext === '.jpeg') && header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff) {
        return true;
    }
    if (ext === '.png' && header.length >= 8 && header.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
        return true;
    }
    if (ext === '.gif' && header.length >= 6 && (header.subarray(0, 6).toString('ascii') === 'GIF87a' || header.subarray(0, 6).toString('ascii') === 'GIF89a')) {
        return true;
    }
    if (ext === '.webp' && header.length >= 12 && header.subarray(0, 4).toString('ascii') === 'RIFF' && header.subarray(8, 12).toString('ascii') === 'WEBP') {
        return true;
    }
    return false;
}

function cleanupUploadedFile(file) {
    try {
        if (file?.path && fs.existsSync(file.path)) fs.unlinkSync(file.path);
    } catch (e) { }
}

const ttsAudioRoot = path.resolve(__dirname, '..', 'data', 'tts');

function resolveTtsAudioPath(userId, audioPath) {
    if (!audioPath) return null;
    const userAudioRoot = path.resolve(ttsAudioRoot, String(userId || 'default'));
    const resolvedPath = path.resolve(String(audioPath));
    if (resolvedPath !== userAudioRoot && !resolvedPath.startsWith(userAudioRoot + path.sep)) {
        return null;
    }
    return resolvedPath;
}

function sanitizeTtsMimeType(value) {
    const mime = String(value || '').trim().toLowerCase();
    if (/^audio\/[a-z0-9.+-]+$/i.test(mime)) return mime;
    return 'audio/mpeg';
}

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
        const ext = path.extname(file.originalname).toLowerCase();
        cb(null, file.fieldname + '-' + uniqueSuffix + ext);
    }
});

const fileFilter = (req, file, cb) => {
    if (file.fieldname === 'image' && isAllowedImageUploadMetadata(file)) {
        cb(null, true);
    } else {
        cb(new Error('Invalid file type. Upload a PNG, JPEG, GIF, or WebP image.'), false);
    }
};

const upload = multer({
    storage: storage,
    limits: { fileSize: 10 * 1024 * 1024, files: 1 },
    fileFilter: fileFilter
});

const MEMORY_IMPORT_MAX_ITEMS = 500;
const memoryImportUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 128 * 1024 * 1024, files: 1 },
    fileFilter: (req, file, cb) => {
        const ext = path.extname(file.originalname || '').toLowerCase();
        const mime = String(file.mimetype || '').toLowerCase();
        const allowedExts = new Set(['.json', '.jsonl', '.ndjson', '.txt', '.md', '.markdown']);
        const allowedMimes = new Set([
            'application/json',
            'application/x-jsonlines',
            'application/x-ndjson',
            'text/plain',
            'text/markdown',
            'application/octet-stream'
        ]);
        if (allowedExts.has(ext) || allowedMimes.has(mime)) {
            cb(null, true);
            return;
        }
        cb(new Error('Invalid memory import file type. Use .json, .jsonl, .txt, or .md.'), false);
    }
});

function parseBooleanFlag(value) {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return value !== 0;
    if (typeof value !== 'string') return false;
    return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}

function stripBom(text) {
    return String(text || '').replace(/^\uFEFF/, '');
}

function firstImportString(...values) {
    for (const value of values) {
        if (value === undefined || value === null) continue;
        if (typeof value === 'string') {
            const trimmed = value.trim();
            if (trimmed) return trimmed;
            continue;
        }
        if (typeof value === 'number' || typeof value === 'boolean') {
            return String(value);
        }
    }
    return '';
}

function clampImportNumber(value, fallback, min, max) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.max(min, Math.min(max, parsed));
}

function makeImportedMemorySummary(text) {
    const compact = String(text || '').replace(/\s+/g, ' ').trim();
    if (!compact) return '';
    return compact.length > 120 ? `${compact.slice(0, 117)}...` : compact;
}

function inferMemoryImportFormat(filename = '', explicitFormat = '') {
    const explicit = String(explicitFormat || '').trim().toLowerCase();
    if (['json', 'jsonl', 'ndjson', 'txt', 'text', 'md', 'markdown'].includes(explicit)) {
        if (explicit === 'ndjson') return 'jsonl';
        if (explicit === 'text') return 'txt';
        if (explicit === 'markdown') return 'md';
        return explicit;
    }
    const ext = path.extname(filename || '').toLowerCase();
    if (ext === '.json') return 'json';
    if (ext === '.jsonl' || ext === '.ndjson') return 'jsonl';
    if (ext === '.md' || ext === '.markdown') return 'md';
    if (ext === '.txt') return 'txt';
    return '';
}

function hasImportMemoryContent(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    return ['summary', 'content', 'event', 'text', 'memory', 'note', 'value'].some(key => {
        const item = value[key];
        return item !== undefined && item !== null && String(item).trim();
    });
}

function splitPlainTextMemories(text) {
    return stripBom(text)
        .replace(/\r\n/g, '\n')
        .split(/\n\s*\n+/)
        .map(part => part.replace(/^\s*[-*]\s+/gm, '').trim())
        .filter(Boolean);
}

function tryParseJsonValue(text) {
    try {
        return { ok: true, value: JSON.parse(stripBom(text)) };
    } catch (e) {
        return { ok: false, error: e };
    }
}

function safeJsonParse(text, fallback) {
    const parsed = tryParseJsonValue(String(text || ''));
    return parsed.ok ? parsed.value : fallback;
}

function extractMemoryEntriesFromPayload(payload) {
    if (Array.isArray(payload)) return payload;
    if (typeof payload === 'string') {
        const trimmed = stripBom(payload).trim();
        if (!trimmed) return [];
        const parsed = tryParseJsonValue(trimmed);
        if (parsed.ok) return extractMemoryEntriesFromPayload(parsed.value);
        return splitPlainTextMemories(trimmed);
    }
    if (!payload || typeof payload !== 'object') return [];

    if (Array.isArray(payload.memories)) return payload.memories;
    if (Array.isArray(payload.data?.memories)) return payload.data.memories;
    if (Array.isArray(payload.data)) return payload.data;
    if (Array.isArray(payload.rows)) return payload.rows;
    if (Array.isArray(payload.results)) return payload.results;
    if (!hasImportMemoryContent(payload) && Array.isArray(payload.items)) return payload.items;
    if (typeof payload.memories === 'string') return extractMemoryEntriesFromPayload(payload.memories);
    if (typeof payload.payload === 'string') return extractMemoryEntriesFromPayload(payload.payload);
    if (hasImportMemoryContent(payload)) return [payload];
    return [];
}

function parseMemoryImportText(text, format = '') {
    const normalizedText = stripBom(text).trim();
    if (!normalizedText) return [];

    if (format === 'json') {
        const parsed = JSON.parse(normalizedText);
        return extractMemoryEntriesFromPayload(parsed);
    }
    if (format === 'jsonl') {
        return normalizedText
            .split(/\r?\n/)
            .map(line => line.trim())
            .filter(Boolean)
            .map((line, idx) => {
                try {
                    return JSON.parse(line);
                } catch (e) {
                    throw new Error(`Invalid JSONL on line ${idx + 1}: ${e.message}`);
                }
            });
    }
    if (format === 'txt' || format === 'md') {
        return splitPlainTextMemories(normalizedText);
    }

    if (/^[\[{]/.test(normalizedText)) {
        const parsed = tryParseJsonValue(normalizedText);
        if (parsed.ok) return extractMemoryEntriesFromPayload(parsed.value);
    }
    return splitPlainTextMemories(normalizedText);
}

function parseMemoryImportRequest(req) {
    const file = req.files?.[0];
    if (file) {
        const format = inferMemoryImportFormat(file.originalname, req.body?.format);
        return {
            source: {
                type: 'file',
                filename: file.originalname || 'memory-import',
                format: format || 'text'
            },
            entries: parseMemoryImportText(file.buffer.toString('utf8'), format)
        };
    }

    const body = req.body;
    return {
        source: { type: 'json', format: 'json' },
        entries: extractMemoryEntriesFromPayload(body)
    };
}

function normalizeImportedMemoryEntry(entry, index) {
    if (typeof entry === 'string') {
        const content = entry.trim();
        if (!content) return { error: 'Empty memory text.' };
        return {
            data: {
                memory_type: 'imported',
                summary: makeImportedMemorySummary(content),
                content,
                event: makeImportedMemorySummary(content),
                importance: 5,
                memory_tier: 'ambient',
                memory_focus: 'general'
            }
        };
    }

    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        return { error: 'Memory entry must be an object or string.' };
    }

    const content = firstImportString(entry.content, entry.text, entry.memory, entry.note, entry.value, entry.event, entry.summary);
    if (!content) {
        return { error: 'Memory entry is missing content, text, memory, note, event, or summary.' };
    }

    const summary = firstImportString(entry.summary, entry.title, entry.event, entry.memory, entry.text, entry.note, entry.value, makeImportedMemorySummary(content));
    const sourceStartedAt = clampImportNumber(entry.source_started_at ?? entry.created_at ?? entry.timestamp, 0, 0, Number.MAX_SAFE_INTEGER);
    const sourceEndedAt = clampImportNumber(entry.source_ended_at ?? entry.updated_at ?? sourceStartedAt, sourceStartedAt, 0, Number.MAX_SAFE_INTEGER);

    return {
        data: {
            memory_type: firstImportString(entry.memory_type, entry.type, 'imported'),
            summary: makeImportedMemorySummary(summary),
            content,
            event: firstImportString(entry.event, summary),
            time: firstImportString(entry.time),
            location: firstImportString(entry.location),
            people_json: entry.people_json ?? entry.people ?? [],
            items_json: entry.items_json ?? entry.items ?? [],
            relationship_json: entry.relationship_json ?? entry.relationships ?? [],
            emotion: firstImportString(entry.emotion),
            importance: clampImportNumber(entry.importance ?? entry.score, 5, 1, 10),
            source_message_ids_json: entry.source_message_ids_json ?? entry.source_message_ids ?? [],
            dedupe_key: firstImportString(entry.dedupe_key),
            is_archived: parseBooleanFlag(entry.is_archived) ? 1 : 0,
            source_started_at: sourceStartedAt,
            source_ended_at: sourceEndedAt,
            source_time_text: firstImportString(entry.source_time_text, entry.time_text),
            source_message_count: clampImportNumber(entry.source_message_count, 0, 0, Number.MAX_SAFE_INTEGER),
            memory_tier: firstImportString(entry.memory_tier, 'ambient'),
            memory_focus: firstImportString(entry.memory_focus, 'general'),
            group_id: firstImportString(entry.group_id)
        }
    };
}

const EXTERNAL_MEMORY_IMPORT_MAX_RAW_CHARS = 180000;
const EXTERNAL_MEMORY_IMPORT_PROMPT_CHARS = 70000;
const EXTERNAL_MEMORY_IMPORT_MAX_MESSAGES = 360;
const EXTERNAL_MEMORY_IMPORT_MAX_MEMORIES = 160;
const EXTERNAL_MEMORY_IMPORT_MAX_MESSAGE_CHARS = 50000;
const EXTERNAL_MEMORY_IMPORT_LLM_TIMEOUT_MS = Math.max(30000, Number(process.env.CP_EXTERNAL_IMPORT_LLM_TIMEOUT_MS || 180000) || 180000);

function normalizeExternalSourceApp(value = '') {
    const raw = String(value || '').trim().toLowerCase();
    if (/silly\s*tavern|sillytavern|tavern/.test(raw)) return 'sillytavern';
    if (/gemini|bard/.test(raw)) return 'gemini';
    if (/chatgpt|openai|\bgpt\b/.test(raw)) return 'gpt';
    return 'external_app';
}

function getExternalSourceAppLabel(sourceApp = '') {
    if (sourceApp === 'sillytavern') return 'SillyTavern';
    if (sourceApp === 'gemini') return 'Gemini';
    if (sourceApp === 'gpt') return 'GPT';
    return 'External App';
}

function getExternalSceneTag(sourceApp = '') {
    if (sourceApp === 'sillytavern') return 'external_sillytavern';
    if (sourceApp === 'gemini') return 'external_gemini';
    if (sourceApp === 'gpt') return 'external_gpt';
    return 'external_app';
}

function normalizeExternalImportMode(value = '', sourceApp = '') {
    const raw = String(value || '').trim().toLowerCase();
    if (raw === 'multi_role' || raw === 'multi' || raw === 'group') return 'multi_role';
    if (raw === 'one_to_one' || raw === 'single' || raw === 'private') return 'one_to_one';
    return sourceApp === 'sillytavern' ? 'multi_role' : 'one_to_one';
}

function detectExternalSourceApp(filename = '', rawText = '') {
    const name = String(filename || '').toLowerCase();
    const text = String(rawText || '').slice(0, 300000);
    if (/silly\s*tavern|sillytavern|tavern|imported\.jsonl/.test(name)) return 'sillytavern';
    if (/"chat_metadata"|"swipes"|"mes"|"send_date"|LWB_|<本轮用户输入>|<recall>/i.test(text)) return 'sillytavern';
    if (/gemini|bard/.test(name) || /"chunkedPrompt"|"model":"gemini/i.test(text)) return 'gemini';
    if (/chatgpt|openai|conversations\.json/.test(name) || /"mapping"|"conversation_id"|"author"/i.test(text)) return 'gpt';
    return '';
}

function cleanExternalSpeakerName(value = '') {
    return String(value || '')
        .replace(/^[#@]+/, '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 80);
}

function isLikelyUserSpeaker(name = '') {
    return /^(user|you|me|myself|human|nana|用户|我|自己)$/i.test(String(name || '').trim());
}

function extractExternalTextContent(value) {
    if (value === undefined || value === null) return '';
    if (typeof value === 'string') return value.trim();
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    if (Array.isArray(value)) {
        return value.map(extractExternalTextContent).filter(Boolean).join('\n').trim();
    }
    if (typeof value !== 'object') return '';
    if (Array.isArray(value.parts)) return extractExternalTextContent(value.parts);
    if (Array.isArray(value.texts)) return extractExternalTextContent(value.texts);
    if (typeof value.text === 'string') return value.text.trim();
    if (typeof value.content === 'string') return value.content.trim();
    if (typeof value.value === 'string') return value.value.trim();
    if (typeof value.string_value === 'string') return value.string_value.trim();
    if (value.content && typeof value.content === 'object') return extractExternalTextContent(value.content);
    return '';
}

function escapeImportRegex(value = '') {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function stripExternalNoiseBlocks(text = '') {
    let output = String(text || '');
    const blockTags = [
        'think', 'thinking', 'thought', 'thoughts', 'analysis', 'reasoning',
        'scratchpad', 'cot', 'chain_of_thought', 'inner_monologue', 'recall'
    ];
    for (const tag of blockTags) {
        output = output.replace(new RegExp(`<\\s*${tag}\\b[^>]*>[\\s\\S]*?<\\s*\\/\\s*${tag}\\s*>`, 'gi'), '\n');
    }
    output = output.replace(/^[\s\S]*?<\s*\/\s*(?:think|thinking|thought|thoughts|analysis|reasoning|scratchpad|cot|chain_of_thought|inner_monologue)\s*>/i, '\n');
    output = output.replace(/<\s*(?:本轮用户输入|当前用户输入|用户输入)[^>]*>[\s\S]*?<\s*\/\s*(?:本轮用户输入|当前用户输入|用户输入)\s*>/gi, '\n');
    const bracketLabels = [
        'think', 'thinking', 'analysis', 'reasoning', 'cot', 'chain of thought',
        '思维链', '推理', '分析', '内心', '心理活动'
    ];
    for (const label of bracketLabels) {
        const escaped = escapeImportRegex(label);
        output = output.replace(new RegExp(`\\[\\s*${escaped}\\s*\\][\\s\\S]*?\\[\\s*\\/\\s*${escaped}\\s*\\]`, 'gi'), '\n');
        output = output.replace(new RegExp(`【\\s*${escaped}\\s*】[\\s\\S]*?【\\s*\\/\\s*${escaped}\\s*】`, 'gi'), '\n');
    }
    output = output.replace(/```(?:think|thinking|analysis|reasoning|cot|chain[-_\s]*of[-_\s]*thought)[\s\S]*?```/gi, '\n');
    output = output.replace(/<\|im_(?:start|end)\|>/gi, '\n');
    output = output.replace(/<\/?s>/gi, '\n');
    return output;
}

function isExternalNoiseLine(line = '') {
    const text = String(line || '').trim();
    if (!text) return true;
    if (/^(?:---+|\*\*\*+|={3,})$/.test(text)) return true;
    if (/^\{\{[^}]{1,100}\}\}$/.test(text)) return true;
    if (/^<[^>]{1,100}>$/.test(text)) return true;
    if (/^(?:\[\/?(?:INST|SYS|SYSTEM|PROMPT|THINK|ANALYSIS|REASONING|COT)\]|<\/?(?:START|END)>)/i.test(text)) return true;
    if (/^###\s*(?:instruction|system|developer|prompt|input|response|assistant|user)\s*:?\s*$/i.test(text)) return true;
    if (/^(?:system|developer|instruction|prompt|jailbreak|persona|scenario|world\s*info|author'?s?\s*note|prefix|suffix|thinking|reasoning|analysis|chain\s*of\s*thought)\s*[:：]/i.test(text)) return true;
    if (/^(?:系统|开发者|指令|提示词?|系统提示|越狱|人格|角色设定|世界书|作者注|前缀|后缀|思维链|推理|分析|内心|心理活动)\s*[:：]/.test(text)) return true;
    if (/^\|?\s*(?:小猫之神|系统|system|developer)\s*\|?\s*/i.test(text)) return true;
    if (/^(?:以下|下面).{0,60}(?:输入|提示|记忆条目|索引编码|剧情相关|正文)/.test(text)) return true;
    return false;
}

function cleanExternalMessageText(text = '') {
    const original = String(text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const stripped = stripExternalNoiseBlocks(original);
    const removedStructuredNoise = stripped !== original;
    let cleaned = stripped
        .replace(/\{\{\s*char\s*\}\}/gi, '角色')
        .replace(/\{\{\s*user\s*\}\}/gi, '用户')
        .replace(/\[\s*(?:\/?INST|\/?SYS|\/?SYSTEM|\/?PROMPT)\s*\]/gi, '\n');
    const lines = cleaned
        .split('\n')
        .map(line => line.trim())
        .filter(line => !isExternalNoiseLine(line));
    cleaned = lines.join('\n')
        .replace(/[ \t]{2,}/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
    if (!cleaned && original.trim() && !removedStructuredNoise) {
        cleaned = original
            .split('\n')
            .map(line => line.trim())
            .filter(line => line && !isExternalNoiseLine(line))
            .join('\n')
            .trim();
    }
    return cleaned || '';
}

function cleanExternalMessagesForPrompt(messages = []) {
    let changed = 0;
    let dropped = 0;
    const cleanedMessages = [];
    for (const message of messages) {
        const rawText = String(message?.text || '');
        const cleanedText = cleanExternalMessageText(rawText);
        if (!cleanedText) {
            dropped += 1;
            continue;
        }
        if (cleanedText !== rawText.trim()) changed += 1;
        cleanedMessages.push({
            ...message,
            text: cleanedText.slice(0, 2200)
        });
    }
    return {
        messages: cleanedMessages,
        stats: {
            original_messages: messages.length,
            cleaned_messages: cleanedMessages.length,
            changed_messages: changed,
            dropped_messages: dropped
        }
    };
}

function normalizeExternalTimestamp(...values) {
    for (const value of values) {
        if (value === undefined || value === null || value === '') continue;
        if (typeof value === 'number') {
            if (!Number.isFinite(value) || value <= 0) continue;
            return value < 100000000000 ? Math.round(value * 1000) : Math.round(value);
        }
        const parsed = Date.parse(String(value));
        if (Number.isFinite(parsed)) return parsed;
        const numeric = Number(value);
        if (Number.isFinite(numeric) && numeric > 0) {
            return numeric < 100000000000 ? Math.round(numeric * 1000) : Math.round(numeric);
        }
    }
    return 0;
}

function collectExternalMessages(value, out = [], depth = 0, seen = new Set()) {
    if (out.length >= EXTERNAL_MEMORY_IMPORT_MAX_MESSAGES || depth > 10 || value === undefined || value === null) return out;
    if (Array.isArray(value)) {
        for (const item of value) collectExternalMessages(item, out, depth + 1, seen);
        return out;
    }
    if (typeof value !== 'object') return out;

    const role = firstImportString(value.role, value.author?.role, value.sender_role, value.type);
    const explicitName = firstImportString(value.name, value.sender, value.sender_name, value.author?.name, value.from, value.user);
    const speaker = cleanExternalSpeakerName(explicitName || role || (value.is_user === true ? 'User' : ''));
    const text = extractExternalTextContent(value.mes ?? value.message ?? value.text ?? value.content ?? value.parts ?? value.value);
    const hasMessageShape = !!text && (
        !!speaker
        || Object.prototype.hasOwnProperty.call(value, 'mes')
        || Object.prototype.hasOwnProperty.call(value, 'role')
        || Object.prototype.hasOwnProperty.call(value, 'author')
        || Object.prototype.hasOwnProperty.call(value, 'is_user')
    );
    if (hasMessageShape) {
        const timestamp = normalizeExternalTimestamp(value.timestamp, value.created_at, value.updated_at, value.create_time, value.send_date, value.date);
        const compactText = text.replace(/\s+/g, ' ').trim();
        const dedupeKey = `${speaker}|${timestamp}|${compactText.slice(0, 120)}`;
        if (compactText && !seen.has(dedupeKey)) {
            seen.add(dedupeKey);
            out.push({
                id: `m${out.length + 1}`,
                speaker: speaker || 'Unknown',
                role: role || (value.is_user === true ? 'user' : ''),
                timestamp,
                text: text.trim().slice(0, EXTERNAL_MEMORY_IMPORT_MAX_MESSAGE_CHARS)
            });
        }
        return out;
    }

    if (value.message && typeof value.message === 'object') {
        collectExternalMessages(value.message, out, depth + 1, seen);
    }

    const keys = ['messages', 'mapping', 'conversations', 'conversation', 'chat', 'history', 'data', 'items', 'rows', 'children'];
    for (const key of keys) {
        if (value[key] !== undefined) collectExternalMessages(value[key], out, depth + 1, seen);
    }
    if (value.mapping && typeof value.mapping === 'object') {
        for (const item of Object.values(value.mapping)) collectExternalMessages(item?.message || item, out, depth + 1, seen);
    }
    return out;
}

function splitExternalPlainTextMessages(text = '') {
    const rows = stripBom(text)
        .replace(/\r\n/g, '\n')
        .split(/\n+/)
        .map(line => line.trim())
        .filter(Boolean);
    const messages = [];
    for (const line of rows) {
        if (messages.length >= EXTERNAL_MEMORY_IMPORT_MAX_MESSAGES) break;
        const match = line.match(/^([^:：]{1,80})[:：]\s*(.+)$/);
        const speaker = cleanExternalSpeakerName(match ? match[1] : '');
        const body = (match ? match[2] : line).trim();
        if (!body) continue;
        messages.push({
            id: `m${messages.length + 1}`,
            speaker: speaker || 'Unknown',
            role: isLikelyUserSpeaker(speaker) ? 'user' : '',
            timestamp: 0,
            text: body.slice(0, 2200)
        });
    }
    if (messages.length > 0) return messages;
    return splitPlainTextMemories(text).slice(0, EXTERNAL_MEMORY_IMPORT_MAX_MESSAGES).map((part, idx) => ({
        id: `m${idx + 1}`,
        speaker: 'Unknown',
        role: '',
        timestamp: 0,
        text: part.slice(0, 2200)
    }));
}

function looksLikeExternalJsonl(filename = '', rawText = '') {
    if (/\.(?:jsonl|ndjson)$/i.test(String(filename || ''))) return true;
    const lines = String(rawText || '').split(/\r?\n/).map(line => line.trim()).filter(Boolean).slice(0, 8);
    if (lines.length < 2) return false;
    return lines.filter(line => /^[\[{]/.test(line)).length >= 2;
}

function collectExternalJsonlMessages(rawText = '') {
    const messages = [];
    const seen = new Set();
    const lines = String(rawText || '').split(/\r?\n/);
    let parsedLines = 0;
    let failedLines = 0;
    for (const line of lines) {
        if (messages.length >= EXTERNAL_MEMORY_IMPORT_MAX_MESSAGES) break;
        const trimmed = line.trim();
        if (!trimmed || !/^[\[{]/.test(trimmed)) continue;
        try {
            const parsed = JSON.parse(trimmed);
            parsedLines += 1;
            collectExternalMessages(parsed, messages, 0, seen);
        } catch (e) {
            failedLines += 1;
        }
    }
    return { messages, parsedLines, failedLines };
}

function parseExternalImportRequest(req) {
    const file = req.files?.[0] || null;
    const filename = file?.originalname || '';
    let rawText = '';
    if (file) {
        rawText = file.buffer.toString('utf8');
    } else {
        rawText = firstImportString(req.body?.text, req.body?.transcript, req.body?.raw_text, req.body?.content);
        if (!rawText && req.body && typeof req.body === 'object') {
            rawText = JSON.stringify(req.body);
        }
    }
    rawText = stripBom(rawText).trim();
    if (!rawText) {
        const error = new Error('No external conversation text or file was provided.');
        error.status = 400;
        throw error;
    }
    const fullRawText = rawText;
    const rawTextForStorage = fullRawText.slice(0, EXTERNAL_MEMORY_IMPORT_MAX_RAW_CHARS);
    let parsed = null;
    let jsonlStats = null;
    let messages = [];
    if (looksLikeExternalJsonl(filename, fullRawText)) {
        jsonlStats = collectExternalJsonlMessages(fullRawText);
        messages = jsonlStats.messages;
    }
    if (messages.length === 0 && /^[\[{]/.test(fullRawText)) {
        try { parsed = JSON.parse(fullRawText); } catch (e) { parsed = null; }
    }
    if (messages.length === 0 && parsed) messages = collectExternalMessages(parsed);
    if (messages.length === 0) messages = splitExternalPlainTextMessages(rawTextForStorage);
    const cleaned = cleanExternalMessagesForPrompt(messages);
    return {
        filename,
        rawText: rawTextForStorage,
        cleanedRawText: cleanExternalMessageText(rawTextForStorage).slice(0, EXTERNAL_MEMORY_IMPORT_MAX_RAW_CHARS),
        messages: cleaned.messages,
        detectedSourceApp: detectExternalSourceApp(filename, fullRawText),
        cleanStats: {
            ...cleaned.stats,
            jsonl_parsed_lines: jsonlStats?.parsedLines || 0,
            jsonl_failed_lines: jsonlStats?.failedLines || 0,
            raw_chars: fullRawText.length,
            stored_raw_chars: rawTextForStorage.length
        }
    };
}

function loadExternalImportRequestFromDb(rawDb, importId) {
    const id = Number(importId || 0);
    if (!id) {
        const error = new Error('Missing external import id for retry.');
        error.status = 400;
        throw error;
    }
    const row = rawDb.prepare('SELECT * FROM external_memory_imports WHERE id = ?').get(id);
    if (!row) {
        const error = new Error('External import record not found.');
        error.status = 404;
        throw error;
    }
    const messages = safeJsonParse(row.normalized_messages_json, []);
    if (!Array.isArray(messages) || messages.length === 0) {
        const error = new Error('This external import has no stored normalized messages to retry.');
        error.status = 422;
        throw error;
    }
    return {
        row,
        filename: row.filename || '',
        rawText: row.raw_text || '',
        cleanedRawText: cleanExternalMessageText(row.raw_text || '').slice(0, EXTERNAL_MEMORY_IMPORT_MAX_RAW_CHARS),
        messages,
        detectedSourceApp: normalizeExternalSourceApp(row.source_app || ''),
        storedSourceApp: normalizeExternalSourceApp(row.source_app || ''),
        storedImportMode: normalizeExternalImportMode(row.import_mode || '', row.source_app || ''),
        cleanStats: null
    };
}

function inferExternalImportContinueOffset(row = {}, limit = 10) {
    const summary = safeJsonParse(row.summary_json, {});
    const explicitOffset = Number(summary?.last_run?.processed || summary?.continue_from?.offset || 0);
    if (Number.isFinite(explicitOffset) && explicitOffset > 0) return explicitOffset;
    const safeLimit = Math.max(1, Number(limit || 10) || 10);
    const saved = normalizeExternalProcessingState(row.memory_ids_json);
    const maxBatch = saved.reduce((max, item) => {
        const match = /^b(\d+)_/i.exec(String(item?.candidate_id || ''));
        return match ? Math.max(max, Number(match[1] || 0)) : max;
    }, 0);
    return maxBatch > 0 ? maxBatch * safeLimit : 0;
}

function buildExternalImportPrompt({ sourceApp, importMode, targetCharacterName, messages, rawText, knownRoleTags = [], userName = '' }) {
    const appLabel = getExternalSourceAppLabel(sourceApp);
    const rows = (messages || []).slice(0, EXTERNAL_MEMORY_IMPORT_MAX_MESSAGES).map(message => ({
        id: message.id,
        speaker: message.speaker,
        role: message.role,
        time: message.timestamp ? new Date(message.timestamp).toISOString() : '',
        text: message.text
    }));
    const transcriptText = rows.length
        ? JSON.stringify(rows).slice(0, EXTERNAL_MEMORY_IMPORT_PROMPT_CHARS)
        : cleanExternalMessageText(rawText || '').slice(0, EXTERNAL_MEMORY_IMPORT_PROMPT_CHARS);
    const knownRoles = (Array.isArray(knownRoleTags) ? knownRoleTags : [])
        .map(tag => ({
            name: normalizeExternalCharacterName(tag?.name || tag),
            aliases: normalizeExternalRoleAliases(tag).slice(0, 8),
            persona: firstImportString(tag?.profile?.persona, tag?.persona).slice(0, 180)
        }))
        .filter(tag => tag.name)
        .slice(0, 80);
    const knownRolesText = knownRoles.length ? JSON.stringify(knownRoles) : '[]';
    const currentUserName = normalizeExternalCharacterName(userName);
    const targetRule = importMode === 'one_to_one'
        ? `这是 GPT/Gemini 一对一导出。目标角色名是 "${targetCharacterName || appLabel}"。所有有效记忆都绑定到这个角色；不要输出其他角色标签，除非原文明确另有同伴长期参与。`
        : `这是 SillyTavern 或多人聊天导出。每条记忆必须返回 character_names: 只包含原文中有明确姓名、且这条记忆确实涉及的非用户角色。没有明确姓名就 needs_review，不要编名字，不要把 User/Nana/用户${currentUserName ? `/${currentUserName}` : ''}放进 character_names。`;
    const systemPrompt = '你是 ChatPulse 外部聊天记录导入小模型。任务是把外部 App 的聊天记录整理成可进入新版 RAG 记忆库的中文剧情记忆，并标出涉及的角色名。只输出合法 JSON 对象，不要 Markdown，不要解释。';
    const userPrompt = `来源 App: ${appLabel}
导入模式: ${importMode}
${targetRule}
已捕获角色标签 JSON:
${knownRolesText}

请从输入里提取长期或阶段性有用的记忆。输入已经预清洗过：思维链、系统提示、前缀/后缀、模板噪声应视为无效来源；只相信聊天正文，不要把提示词或推理文本总结成记忆。

分类枚举:
- memory_focus: user_profile | relationship | user_current_arc | general
- memory_tier: core | active | ambient
- importance: 1-10

输出 JSON:
{
  "role_tags": [
    {"name":"明确角色名","aliases":["可选别名/简称/译名"],"confidence":0.0-1.0,"reason":"一句中文理由"}
  ],
  "character_profiles": [
    {"name":"角色名","persona":"可选，基于原文概括的简短角色设定"}
  ],
  "memories": [
    {
      "summary":"2-4 句中文正式记忆，概括剧情场景、起因、关键行动、结果或状态变化",
      "content":"更完整的剧情概况，保留角色关系、冲突、时间/地点线索和后续影响，但不要贴长段原文",
      "character_names":["明确角色名"],
      "memory_focus":"user_profile | relationship | user_current_arc | general",
      "memory_tier":"core | active | ambient",
      "importance":1-10,
      "consolidation_key":"english_snake_case_key",
      "source_refs":["m1","m2"],
      "source_time_text":"可选，原文有明确时间才写",
      "reason":"一句中文理由"
    }
  ],
  "needs_review": [
    {"source_refs":["m3"],"reason":"为什么不确定"}
  ]
}

约束:
- summary/content 必须是简体中文。
- summary 不是短标题，不能只写“某人做了某事”。每条 summary 通常 80-260 个中文字符，至少说明“在哪里/什么阶段、为什么发生、谁做了什么、造成了什么结果或关系变化”；只有极简单事实才可以更短。
- content 通常 150-600 个中文字符，用来保留剧情脉络：场景、动机、冲突、角色反应、状态变化、未解决线索。不要复制大段原文，不要输出露骨细节，但也不要压缩成一句话。
- 一条记忆只覆盖一个可召回事件、阶段状态或关系变化；不要把整段关系史糊成一条，也不要拆到失去剧情上下文。
- SillyTavern 记录往往是连续剧情日志，必须给出可读的剧情概况；优先总结“这一小段发生了什么、谁参与、对后续有什么意义”，不要只抽取孤立关键词。
- source_refs 必须来自输入消息 id。
- GPT/Gemini 一对一模式默认绑定到目标角色。
- SillyTavern 多人模式只返回明确姓名的角色标签；多人共同经历可以让多个角色共享同一条记忆。
- role_tags.name、character_profiles.name 和 character_names 是机器角色标签，不是中文自然语言字段：必须保留原文里明确出现的姓名写法和大小写，不要翻译、音译或改写角色名。例如原文写 Conrad/Dominic/Baron，就输出 Conrad/Dominic/Baron，不要改成康拉德/多米尼克/巴伦；原文只写中文名时才用中文名。
- 如果“已捕获角色标签 JSON”非空，character_names 必须优先使用其中的 name 原文作为标准名；简称、姓氏、中文译名、英文名、全名变体都要归并到已有标准名，禁止把同一个人重复输出成新角色。
- role_tags 只输出本批新出现、且不属于已捕获角色标签的新角色；已有角色不要重复输出。若只是补充别名，可以在同一个标准 name 下输出 aliases。
- 如果无法判断某个名字是不是已捕获角色的别名，且原文没有明确姓名证据，就放进 needs_review，不要创建新角色。
- 最多输出 ${EXTERNAL_MEMORY_IMPORT_MAX_MEMORIES} 条 memories。

输入消息 JSON:
${transcriptText}`;
    return { system_prompt: systemPrompt, user_prompt: userPrompt, row_count: rows.length };
}

function normalizeExternalCharacterName(name = '', fallback = '') {
    const cleaned = cleanExternalSpeakerName(name || fallback)
        .replace(/[<>\[\]{}"'`]+/g, '')
        .trim();
    if (!cleaned || isLikelyUserSpeaker(cleaned)) return '';
    return cleaned.slice(0, 60);
}

function getExternalNameCompareKey(name = '') {
    return String(name || '')
        .normalize('NFKC')
        .toLowerCase()
        .replace(/black wood/g, 'blackwood')
        .replace(/van croft/g, 'vancroft')
        .replace(/[·・•．.。_\-—–/\\|()[\]{}'"`“”‘’\s:：,，;；]+/g, '')
        .trim();
}

function isExternalImportUserName(name = '', userName = '') {
    const normalized = normalizeExternalCharacterName(name);
    if (!normalized) return true;
    if (isLikelyUserSpeaker(normalized)) return true;
    const userKey = getExternalNameCompareKey(userName);
    return !!userKey && getExternalNameCompareKey(normalized) === userKey;
}

function getExternalNameTokens(name = '') {
    return String(name || '')
        .normalize('NFKC')
        .toLowerCase()
        .replace(/[·・•．.。_\-—–/\\|()[\]{}'"`“”‘’:,，;；]+/g, ' ')
        .split(/\s+/)
        .map(token => token.trim())
        .filter(token => token.length >= 3);
}

function normalizeExternalRoleAliases(tag = {}) {
    const values = [];
    const add = (value) => {
        if (Array.isArray(value)) {
            for (const item of value) add(item);
            return;
        }
        const normalized = normalizeExternalCharacterName(value);
        if (normalized && !values.some(existing => getExternalNameCompareKey(existing) === getExternalNameCompareKey(normalized))) {
            values.push(normalized);
        }
    };
    add(tag?.aliases);
    add(tag?.alias);
    add(tag?.english_name);
    add(tag?.chinese_name);
    add(tag?.profile?.aliases);
    add(tag?.profile?.alias);
    add(tag?.profile?.english_name);
    add(tag?.profile?.chinese_name);
    return values;
}

function getExternalRoleCandidateNames(tag = {}) {
    const names = [];
    const add = (value) => {
        const normalized = normalizeExternalCharacterName(value);
        if (normalized && !names.some(existing => getExternalNameCompareKey(existing) === getExternalNameCompareKey(normalized))) {
            names.push(normalized);
        }
    };
    add(tag?.name || tag);
    for (const alias of normalizeExternalRoleAliases(tag)) add(alias);
    add(tag?.profile?.name);
    return names;
}

function resolveExternalKnownRoleName(name = '', knownRoleTags = []) {
    const normalized = normalizeExternalCharacterName(name);
    if (!normalized) return '';
    const targetKey = getExternalNameCompareKey(normalized);
    if (!targetKey) return '';
    const candidates = (Array.isArray(knownRoleTags) ? knownRoleTags : [])
        .map(tag => {
            const canonical = normalizeExternalCharacterName(tag?.name || tag);
            if (!canonical) return null;
            const names = getExternalRoleCandidateNames(tag);
            return { canonical, names };
        })
        .filter(Boolean);
    for (const candidate of candidates) {
        if (candidate.names.some(item => getExternalNameCompareKey(item) === targetKey)) {
            return candidate.canonical;
        }
    }
    const containmentMatches = candidates.filter(candidate => candidate.names.some(item => {
        const key = getExternalNameCompareKey(item);
        if (!key || key === targetKey) return false;
        const minLength = /[\u4e00-\u9fff]/.test(targetKey + key) ? 2 : 4;
        return targetKey.length >= minLength && key.length >= minLength && (key.includes(targetKey) || targetKey.includes(key));
    }));
    if (containmentMatches.length === 1) {
        return containmentMatches[0].canonical;
    }
    const targetTokens = getExternalNameTokens(normalized);
    if (targetTokens.length > 0) {
        const tokenMatches = candidates.filter(candidate => {
            const candidateTokens = new Set(candidate.names.flatMap(getExternalNameTokens));
            if (candidateTokens.size === 0) return false;
            return targetTokens.some(token => candidateTokens.has(token));
        });
        if (tokenMatches.length === 1) return tokenMatches[0].canonical;
    }
    return normalized;
}

function normalizeExternalImportResult(parsed = {}, context = {}) {
    const sourceApp = context.sourceApp || 'external_app';
    const importMode = context.importMode || 'one_to_one';
    const targetName = normalizeExternalCharacterName(context.targetCharacterName, getExternalSourceAppLabel(sourceApp));
    const userName = normalizeExternalCharacterName(context.userName || '');
    const knownRoleTags = Array.isArray(context.knownRoleTags) ? context.knownRoleTags : [];
    const messageById = new Map((context.messages || []).map(message => [String(message.id), message]));
    const roleMap = new Map();
    const profileMap = new Map();
    const addRole = (name, patch = {}) => {
        const rawNormalized = normalizeExternalCharacterName(name, importMode === 'one_to_one' ? targetName : '');
        if (!rawNormalized || (importMode === 'multi_role' && isExternalImportUserName(rawNormalized, userName))) return '';
        const normalized = importMode === 'multi_role'
            ? resolveExternalKnownRoleName(rawNormalized, knownRoleTags)
            : rawNormalized;
        if (!normalized || (importMode === 'multi_role' && isExternalImportUserName(normalized, userName))) return '';
        const existing = roleMap.get(normalized.toLowerCase()) || { name: normalized, confidence: 0.8, reason: '' };
        roleMap.set(normalized.toLowerCase(), {
            ...existing,
            ...patch,
            name: existing.name || normalized,
            confidence: Math.max(Number(existing.confidence || 0), Number(patch.confidence || 0)),
            aliases: Array.from(new Set([
                ...(Array.isArray(existing.aliases) ? existing.aliases : []),
                ...normalizeExternalRoleAliases(patch),
                ...(normalized !== rawNormalized ? [rawNormalized] : [])
            ].map(alias => normalizeExternalCharacterName(alias)).filter(Boolean)))
        });
        return existing.name || normalized;
    };
    for (const tag of knownRoleTags) {
        addRole(tag?.name || tag, {
            ...tag,
            confidence: clampImportNumber(tag?.confidence, 0.9, 0, 1),
            reason: firstImportString(tag?.reason, '已捕获角色标签。')
        });
    }
    if (importMode === 'one_to_one') addRole(targetName || getExternalSourceAppLabel(sourceApp), { confidence: 1, reason: '一对一导入目标角色。' });
    for (const tag of Array.isArray(parsed.role_tags) ? parsed.role_tags : []) {
        addRole(tag?.name, {
            confidence: clampImportNumber(tag?.confidence, 0.8, 0, 1),
            reason: firstImportString(tag?.reason)
        });
    }
    for (const profile of Array.isArray(parsed.character_profiles) ? parsed.character_profiles : []) {
        const name = addRole(profile?.name, { confidence: 0.85, reason: '小模型从导入记录中识别。' });
        if (name) profileMap.set(name.toLowerCase(), {
            name,
            persona: firstImportString(profile?.persona, profile?.description).slice(0, 1500)
        });
    }

    const candidates = [];
    const rawMemories = (Array.isArray(parsed.memories) ? parsed.memories : []).slice(0, EXTERNAL_MEMORY_IMPORT_MAX_MEMORIES);
    for (let idx = 0; idx < rawMemories.length; idx++) {
        const item = rawMemories[idx] || {};
        const summary = firstImportString(item.summary, item.content, item.memory, item.text).slice(0, 1200);
        const content = firstImportString(item.content, item.summary, item.memory, item.text).slice(0, 3000);
        if (!summary || !hasCjkText(summary)) continue;
        let names = Array.isArray(item.character_names) ? item.character_names : (Array.isArray(item.characters) ? item.characters : []);
        if (importMode === 'one_to_one' && names.length === 0) names = [targetName || getExternalSourceAppLabel(sourceApp)];
        names = Array.from(new Set(names
            .map(name => addRole(name, { confidence: importMode === 'one_to_one' ? 1 : 0.8 }))
            .filter(Boolean)));
        if (importMode === 'multi_role' && names.length === 0) continue;
        const sourceRefs = Array.from(new Set((Array.isArray(item.source_refs) ? item.source_refs : [])
            .map(ref => String(ref || '').trim())
            .filter(ref => messageById.has(ref))))
            .slice(0, 20);
        const sourceMessages = sourceRefs.map(ref => messageById.get(ref)).filter(Boolean);
        const timestamps = sourceMessages.map(message => Number(message.timestamp || 0)).filter(ts => ts > 0).sort((a, b) => a - b);
        const sourceStartedAt = timestamps[0] || 0;
        const sourceEndedAt = timestamps[timestamps.length - 1] || sourceStartedAt || 0;
        const focus = MEMORY_MAINTENANCE_FOCUS.has(String(item.memory_focus || '').trim()) ? String(item.memory_focus).trim() : 'general';
        const tier = MEMORY_MAINTENANCE_TIERS.has(String(item.memory_tier || '').trim()) ? String(item.memory_tier).trim() : 'ambient';
        const keySeed = firstImportString(item.consolidation_key, item.key, summary)
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '_')
            .replace(/^_+|_+$/g, '')
            .slice(0, 90) || `external_memory_${idx + 1}`;
        candidates.push({
            id: `c${idx + 1}`,
            summary,
            content: content || summary,
            character_names: names,
            memory_focus: focus,
            memory_tier: tier,
            importance: Math.round(clampImportNumber(item.importance, 5, 1, 10)),
            consolidation_key: keySeed,
            source_refs: sourceRefs,
            source_started_at: sourceStartedAt,
            source_ended_at: sourceEndedAt,
            source_time_text: firstImportString(item.source_time_text) || (sourceStartedAt ? (sourceStartedAt === sourceEndedAt ? new Date(sourceStartedAt).toLocaleString('zh-CN') : `${new Date(sourceStartedAt).toLocaleString('zh-CN')} - ${new Date(sourceEndedAt).toLocaleString('zh-CN')}`) : ''),
            source_message_count: sourceRefs.length || sourceMessages.length || 0,
            reason: firstImportString(item.reason).slice(0, 500)
        });
    }
    const roleTags = Array.from(roleMap.values())
        .filter(tag => candidates.some(candidate => candidate.character_names.includes(tag.name)) || importMode === 'one_to_one')
        .map(tag => ({
            ...tag,
            profile: profileMap.get(tag.name.toLowerCase()) || { name: tag.name, persona: '' }
        }));
    return {
        source_app: sourceApp,
        import_mode: importMode,
        role_tags: roleTags,
        candidates,
        needs_review: Array.isArray(parsed.needs_review) ? parsed.needs_review.slice(0, 30) : []
    };
}

function chunkExternalImportMessages(messages = [], limit = 10, maxBatches = null) {
    const safeLimit = normalizeMemoryMaintenanceBatchOptions({ limit }, { limitFallback: 10 }).limit;
    const chunks = [];
    for (let start = 0; start < messages.length; start += safeLimit) {
        if (maxBatches !== null && chunks.length >= maxBatches) break;
        chunks.push(messages.slice(start, start + safeLimit));
    }
    return chunks;
}

function mergeExternalImportRoleTags(existing = [], incoming = []) {
    const map = new Map();
    const seedTags = Array.isArray(existing) ? existing : [];
    const allTags = [...seedTags, ...(Array.isArray(incoming) ? incoming : [])];
    for (const tag of allTags) {
        const rawName = normalizeExternalCharacterName(tag?.name || tag);
        const name = seedTags.length && !seedTags.some(seed => getExternalNameCompareKey(seed?.name || seed) === getExternalNameCompareKey(rawName))
            ? resolveExternalKnownRoleName(rawName, seedTags)
            : rawName;
        if (!name) continue;
        const key = name.toLowerCase();
        const prev = map.get(key) || { name, confidence: 0, reason: '', profile: { name, persona: '' } };
        const aliases = Array.from(new Set([
            ...(Array.isArray(prev.aliases) ? prev.aliases : []),
            ...normalizeExternalRoleAliases(tag),
            ...(rawName && rawName !== name ? [rawName] : [])
        ].map(alias => normalizeExternalCharacterName(alias)).filter(Boolean)));
        map.set(key, {
            ...prev,
            ...tag,
            name: prev.name || name,
            confidence: Math.max(Number(prev.confidence || 0), Number(tag?.confidence || 0)),
            reason: firstImportString(prev.reason, tag?.reason),
            aliases,
            profile: {
                ...(prev.profile || {}),
                ...(tag?.profile || {}),
                name
            }
        });
    }
    return Array.from(map.values());
}

function buildExternalImportDirectDedupeKey({ importId, sourceApp, characterId, candidate }) {
    const refs = Array.isArray(candidate?.source_refs) ? candidate.source_refs.join('_') : '';
    const seed = firstImportString(candidate?.consolidation_key, candidate?.id, candidate?.summary, refs)
        .toLowerCase()
        .replace(/[^a-z0-9\u4e00-\u9fff]+/gi, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 100) || 'memory';
    return `external-import-direct:${sourceApp}:${characterId}:${importId}:${seed}`.slice(0, 240);
}

function getExternalImportSharedLibraryId(sourceApp = '') {
    const app = String(sourceApp || 'external_app')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '') || 'external-app';
    return `external-shared-${app}`;
}

function shouldUseSharedExternalImportLibrary(sourceApp = '', importMode = '') {
    return sourceApp === 'sillytavern' || importMode === 'multi_role';
}

function ensureExternalSharedImportCharacter(db, id, name) {
    if (!db || !id) return;
    if (typeof db.getCharacter === 'function' && db.getCharacter(id)) return;
    if (typeof db.updateCharacter === 'function') {
        db.updateCharacter(id, {
            id,
            name: name || '外部共享导入库',
            persona: '外部多人聊天导入的共享记忆库。它不作为聊天角色显示，只承载被多个角色标签绑定的导入记忆。',
            is_blocked: 1,
            status: 'shared_library',
            llm_debug_capture: 0,
            sweep_initialized: 1
        });
    }
}

async function saveExternalImportCandidatesDirect({ db, memory, settings, importId, sourceApp, importMode = '', normalized, dryRun = false }) {
    const sceneTag = getExternalSceneTag(sourceApp);
    const useSharedLibrary = shouldUseSharedExternalImportLibrary(sourceApp, importMode || normalized?.import_mode);
    const sharedLibraryId = getExternalImportSharedLibraryId(sourceApp);
    const sharedLibraryName = `${getExternalSourceAppLabel(sourceApp)} 共享导入库`;
    const roleProfiles = new Map((normalized.role_tags || []).map(tag => [
        normalizeExternalCharacterName(tag.name).toLowerCase(),
        tag.profile || tag
    ]));
    const characterByName = new Map();
    const characters = [];
    const saved = [];
    const skipped = [];
    const errors = [];

    const ensureCharacter = (name) => {
        const normalizedName = normalizeExternalCharacterName(name);
        if (!normalizedName) return null;
        const key = normalizedName.toLowerCase();
        if (characterByName.has(key)) return characterByName.get(key);
        if (dryRun) {
            const existing = findCharacterByName(db, normalizedName);
            const character = existing || { id: makeCharacterIdFromName(db, normalizedName), name: normalizedName };
            characterByName.set(key, character);
            characters.push({
                id: character.id,
                name: character.name,
                created: !existing,
                dry_run: true
            });
            return character;
        }
        const result = ensureImportedCharacter(db, normalizedName, roleProfiles.get(key) || {}, settings);
        if (result.character) {
            characterByName.set(key, result.character);
            characters.push({
                id: result.character.id,
                name: result.character.name,
                created: result.created
            });
        }
        return result.character || null;
    };

    for (const tag of normalized.role_tags || []) {
        ensureCharacter(tag.name);
    }

    for (const candidate of normalized.candidates || []) {
        const names = Array.from(new Set((Array.isArray(candidate.character_names) ? candidate.character_names : [])
            .map(name => normalizeExternalCharacterName(name))
            .filter(Boolean)));
        if (!names.length) {
            skipped.push({ candidate_id: candidate.id, reason: 'missing_character_names' });
            continue;
        }
        const boundCharacters = [];
        for (const name of names) {
            const character = ensureCharacter(name);
            if (character) {
                boundCharacters.push(character);
            } else {
                skipped.push({ candidate_id: candidate.id, name, reason: 'character_not_created' });
            }
        }
        if (!boundCharacters.length) continue;
        await yieldToServerLoop();

        const storageCharacter = useSharedLibrary
            ? { id: sharedLibraryId, name: sharedLibraryName }
            : boundCharacters[0];
        if (useSharedLibrary && !dryRun) {
            ensureExternalSharedImportCharacter(db, storageCharacter.id, storageCharacter.name);
        }
        const dedupeKey = buildExternalImportDirectDedupeKey({
            importId,
            sourceApp,
            characterId: storageCharacter.id,
            candidate
        });
        const sourceRefs = Array.from(new Set((Array.isArray(candidate.source_refs) ? candidate.source_refs : [])
            .map(ref => String(ref || '').trim())
            .filter(Boolean)));
        const sourceMessageIds = sourceRefs.length
            ? sourceRefs.map(ref => `external-import:${importId}:${ref}`)
            : [`external-import:${importId}:${candidate.id || dedupeKey}`];
        const summary = firstImportString(candidate.summary, candidate.content).slice(0, 1200);
        const content = firstImportString(candidate.content, candidate.summary).slice(0, 3000);
        if (!summary || !hasCjkText(summary)) {
            skipped.push({ candidate_id: candidate.id, names, reason: 'empty_or_non_chinese_summary' });
            continue;
        }
        const existing = db.getMemoryByDedupeKey?.(storageCharacter.id, dedupeKey);
        const boundCharacterRefs = boundCharacters.map(item => ({ id: item.id, name: item.name }));
        const boundCharacterNames = boundCharacters.map(item => item.name);
        if (dryRun) {
            saved.push({
                dry_run: true,
                candidate_id: candidate.id,
                character_id: storageCharacter.id,
                character_name: storageCharacter.name,
                shared_library: useSharedLibrary,
                bound_characters: boundCharacterRefs,
                character_names: boundCharacterNames,
                action: existing ? 'would_update' : 'would_create',
                summary
            });
            continue;
        }
        try {
            const memoryId = await memory.saveExtractedMemory(storageCharacter.id, {
                memory_type: 'event',
                summary,
                content: content || summary,
                event: summary,
                importance: Math.round(clampImportNumber(candidate.importance, 5, 1, 10)),
                memory_tier: MEMORY_MAINTENANCE_TIERS.has(candidate.memory_tier) ? candidate.memory_tier : 'ambient',
                memory_focus: MEMORY_MAINTENANCE_FOCUS.has(candidate.memory_focus) ? candidate.memory_focus : 'general',
                maintenance_status: 'classified',
                classification_source: useSharedLibrary ? 'external-import-shared' : 'external-import-direct',
                classified_at: Date.now(),
                retention_score: 1,
                retention_action: 'keep',
                retention_reason: useSharedLibrary ? 'external_import_shared' : 'external_import_direct',
                retention_checked_at: Date.now(),
                consolidation_key: candidate.consolidation_key || dedupeKey,
                consolidation_summary: summary,
                dedupe_key: dedupeKey,
                source_context: 'external_app',
                scene_tag: sceneTag,
                source_app: sourceApp,
                people_json: boundCharacterNames,
                source_message_ids_json: sourceMessageIds,
                source_started_at: Number(candidate.source_started_at || 0),
                source_ended_at: Number(candidate.source_ended_at || candidate.source_started_at || 0),
                source_time_text: candidate.source_time_text || '',
                source_message_count: Number(candidate.source_message_count || sourceRefs.length || 0)
            }, null, { allowUnindexed: true, throwOnError: true, allowRoutineCity: true });
            if (useSharedLibrary && memoryId && typeof db.bindExternalMemoryToCharacters === 'function') {
                db.bindExternalMemoryToCharacters(importId, memoryId, boundCharacters);
                for (const boundCharacter of boundCharacters) {
                    if (typeof memory.refreshMemoryIndexEntries === 'function') {
                        try {
                            await memory.refreshMemoryIndexEntries(boundCharacter.id, [memoryId]);
                        } catch (e) {
                            console.warn(`[External Import] Shared memory index refresh failed for ${boundCharacter.id}:`, e.message);
                        }
                    }
                }
            }
            saved.push({
                candidate_id: candidate.id,
                character_id: storageCharacter.id,
                character_name: storageCharacter.name,
                shared_library: useSharedLibrary,
                bound_characters: boundCharacterRefs,
                character_names: boundCharacterNames,
                memory_id: memoryId,
                action: existing ? 'updated' : 'created',
                summary
            });
            await yieldToServerLoop();
        } catch (e) {
            errors.push({
                candidate_id: candidate.id,
                character_id: storageCharacter.id,
                character_name: storageCharacter.name,
                shared_library: useSharedLibrary,
                bound_characters: boundCharacterRefs,
                error: e.message || 'save failed'
            });
        }
    }

    return {
        characters,
        saved,
        skipped,
        errors,
        saved_count: saved.length,
        error_count: errors.length
    };
}

function groupExternalImportSavedItems(saved = []) {
    const map = new Map();
    for (const item of Array.isArray(saved) ? saved : []) {
        const summary = String(item?.summary || '').trim();
        if (!summary) continue;
        const key = String(item?.candidate_id || summary).trim() || summary;
        const current = map.get(key) || {
            summary,
            candidate_id: item?.candidate_id || '',
            character_names: [],
            memory_ids: []
        };
        const names = Array.isArray(item?.character_names) && item.character_names.length
            ? item.character_names
            : (Array.isArray(item?.bound_characters) ? item.bound_characters.map(character => character?.name) : [item?.character_name]);
        for (const name of names) {
            const characterName = String(name || '').trim();
            if (characterName && !current.character_names.includes(characterName)) {
                current.character_names.push(characterName);
            }
        }
        if (item?.memory_id) current.memory_ids.push(item.memory_id);
        map.set(key, current);
    }
    return Array.from(map.values());
}

function countUniqueExternalImportSavedItems(saved = []) {
    return groupExternalImportSavedItems(saved).length;
}

function formatExternalImportSavedSamples(saved = [], limit = 5) {
    return groupExternalImportSavedItems(saved)
        .slice(0, Math.max(0, Number(limit || 0) || 0))
        .map(item => {
            const names = item.character_names.slice(0, 4).join(' / ');
            const suffix = names ? `（绑定：${names}${item.character_names.length > 4 ? ' 等' : ''}）` : '';
            return `${item.summary}${suffix}`;
        });
}

function countExternalImportSavedBindings(saved = []) {
    return (Array.isArray(saved) ? saved : []).reduce((sum, item) => {
        const names = Array.isArray(item?.character_names) && item.character_names.length
            ? item.character_names
            : (Array.isArray(item?.bound_characters) ? item.bound_characters : []);
        return sum + Math.max(1, names.length || 0);
    }, 0);
}

function getExternalImportSavedCharacterIds(saved = []) {
    const ids = new Set();
    for (const item of Array.isArray(saved) ? saved : []) {
        if (Array.isArray(item?.bound_characters)) {
            for (const character of item.bound_characters) {
                const id = String(character?.id || '').trim();
                if (id) ids.add(id);
            }
        }
        if (!item?.shared_library) {
            const id = String(item?.character_id || '').trim();
            if (id) ids.add(id);
        }
    }
    return Array.from(ids);
}

function findCharacterByName(db, name = '') {
    const target = String(name || '').trim().toLowerCase();
    if (!target || typeof db.getCharacters !== 'function') return null;
    const characters = db.getCharacters() || [];
    const exact = characters.find(character => String(character.name || '').trim().toLowerCase() === target);
    if (exact) return exact;
    const targetKey = getExternalNameCompareKey(name);
    if (!targetKey) return null;
    const candidates = characters
        .map(character => ({ character, key: getExternalNameCompareKey(character.name || '') }))
        .filter(item => item.key);
    const containmentMatches = candidates.filter(item => {
        const minLength = /[\u4e00-\u9fff]/.test(targetKey + item.key) ? 2 : 4;
        return targetKey.length >= minLength && item.key.length >= minLength && (item.key.includes(targetKey) || targetKey.includes(item.key));
    });
    if (containmentMatches.length === 1) return containmentMatches[0].character;
    const targetTokens = getExternalNameTokens(name);
    if (targetTokens.length > 0) {
        const tokenMatches = candidates.filter(item => {
            const tokens = new Set(getExternalNameTokens(item.character.name || ''));
            return targetTokens.some(token => tokens.has(token));
        });
        if (tokenMatches.length === 1) return tokenMatches[0].character;
    }
    return null;
}

function makeCharacterIdFromName(db, name = '') {
    const base = String(name || 'imported-character')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9\u4e00-\u9fff]+/gi, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 36) || 'imported-character';
    let candidate = base;
    let suffix = 1;
    while (db.getCharacter?.(candidate)) {
        suffix += 1;
        candidate = `${base}-${suffix}`;
    }
    return candidate;
}

function ensureImportedCharacter(db, name, profile = {}, settings = {}) {
    const existing = findCharacterByName(db, name);
    if (existing) return { character: existing, created: false };
    const id = makeCharacterIdFromName(db, name);
    db.updateCharacter(id, {
        id,
        name,
        avatar: buildDefaultAvatarUrl(name),
        persona: firstImportString(profile?.persona, `${name} 是从外部聊天记录导入的角色，后续可以在角色设置里补全人格。`),
        affinity: 50,
        wallet: 200,
        memory_api_endpoint: settings.api_endpoint || '',
        memory_api_key: settings.api_key || '',
        memory_model_name: settings.model_name || ''
    });
    return { character: db.getCharacter(id), created: true };
}

function sanitizeDownloadName(value, fallback = 'character') {
    const clean = (input) => String(input || '')
        .trim()
        .replace(/[\\/:*?"<>|]+/g, '_')
        .replace(/\s+/g, '_')
        .replace(/[^A-Za-z0-9_.-]+/g, '_')
        .slice(0, 80);
    return clean(value) || clean(fallback) || 'character';
}

function normalizeCharacterArchivePayload(payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        throw new Error('Character archive must be a JSON object.');
    }
    if (payload.data?.character) return payload.data;
    if (payload.character) return payload;
    throw new Error('Character archive is missing a character object.');
}

function parseCharacterArchiveRequest(req) {
    const file = req.files?.[0];
    if (file) {
        const format = inferMemoryImportFormat(file.originalname, req.body?.format);
        if (format && format !== 'json') {
            throw new Error('Character archives must be .json files.');
        }
        return normalizeCharacterArchivePayload(JSON.parse(stripBom(file.buffer.toString('utf8'))));
    }
    return normalizeCharacterArchivePayload(req.body);
}

function getTableColumnSet(rawDb, tableName) {
    try {
        return new Set(rawDb.prepare(`PRAGMA table_info(${tableName})`).all().map(col => col.name));
    } catch (e) {
        return new Set();
    }
}

function stringifyArchiveJson(value, fallback = null) {
    if (value == null || value === '') return fallback;
    if (typeof value === 'string') return value;
    try {
        return JSON.stringify(value);
    } catch (e) {
        return fallback;
    }
}

function toArchiveNumber(value, fallback = 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
}

function makeInsertStatement(rawDb, tableName, columns) {
    const placeholders = columns.map(() => '?').join(', ');
    return rawDb.prepare(`INSERT INTO ${tableName} (${columns.join(', ')}) VALUES (${placeholders})`);
}

function runArchiveCleanup(rawDb, sql, ...params) {
    try {
        rawDb.prepare(sql).run(...params);
    } catch (e) { }
}

function clearCharacterArchiveData(rawDb, characterId) {
    runArchiveCleanup(rawDb, 'DELETE FROM message_tts WHERE character_id = ?', characterId);
    runArchiveCleanup(rawDb, 'DELETE FROM message_tts WHERE message_id IN (SELECT id FROM messages WHERE character_id = ?)', characterId);
    runArchiveCleanup(rawDb, 'DELETE FROM messages WHERE character_id = ?', characterId);
    runArchiveCleanup(rawDb, 'DELETE FROM memories WHERE character_id = ?', characterId);
    const momentIds = rawDb.prepare('SELECT id FROM moments WHERE character_id = ?').all(characterId).map(row => row.id);
    if (momentIds.length > 0) {
        const placeholders = momentIds.map(() => '?').join(', ');
        runArchiveCleanup(rawDb, `DELETE FROM moment_likes WHERE moment_id IN (${placeholders})`, ...momentIds);
        runArchiveCleanup(rawDb, `DELETE FROM moment_comments WHERE moment_id IN (${placeholders})`, ...momentIds);
    }
    runArchiveCleanup(rawDb, 'DELETE FROM moment_likes WHERE liker_id = ?', characterId);
    runArchiveCleanup(rawDb, 'DELETE FROM moment_comments WHERE author_id = ?', characterId);
    runArchiveCleanup(rawDb, 'DELETE FROM moments WHERE character_id = ?', characterId);
    runArchiveCleanup(rawDb, 'DELETE FROM diaries WHERE character_id = ?', characterId);
    runArchiveCleanup(rawDb, 'DELETE FROM history_window_cache WHERE character_id = ?', characterId);
    runArchiveCleanup(rawDb, 'DELETE FROM prompt_block_cache WHERE character_id = ?', characterId);
    runArchiveCleanup(rawDb, 'DELETE FROM conversation_digest_cache WHERE character_id = ?', characterId);
    runArchiveCleanup(rawDb, 'DELETE FROM llm_cache WHERE character_id = ? OR cache_scope = ?', characterId, `character:${characterId}`);
}

function importArchiveMessages(rawDb, characterId, rows = []) {
    const columns = getTableColumnSet(rawDb, 'messages');
    const insertColumns = ['character_id', 'role', 'content', 'timestamp', 'read', 'hidden', 'is_summarized', 'metadata']
        .filter(col => columns.has(col));
    if (insertColumns.length === 0) return 0;
    const stmt = makeInsertStatement(rawDb, 'messages', insertColumns);
    let count = 0;
    for (const row of Array.isArray(rows) ? rows : []) {
        const content = firstImportString(row?.content);
        if (!content) continue;
        const valuesByColumn = {
            character_id: characterId,
            role: firstImportString(row?.role, 'system'),
            content,
            timestamp: toArchiveNumber(row?.timestamp, Date.now()),
            read: toArchiveNumber(row?.read, 0),
            hidden: toArchiveNumber(row?.hidden, 0),
            is_summarized: toArchiveNumber(row?.is_summarized, 0),
            metadata: stringifyArchiveJson(row?.metadata, null)
        };
        stmt.run(...insertColumns.map(col => valuesByColumn[col]));
        count += 1;
    }
    return count;
}

function importArchiveMemories(rawDb, characterId, rows = []) {
    const columns = getTableColumnSet(rawDb, 'memories');
    const insertColumns = [
        'character_id', 'time', 'location', 'people', 'event', 'relationships', 'items',
        'importance', 'embedding', 'created_at', 'last_retrieved_at', 'retrieval_count',
        'group_id', 'memory_type', 'summary', 'content', 'people_json', 'items_json',
        'relationship_json', 'emotion', 'source_message_ids_json', 'dedupe_key', 'updated_at',
        'is_archived', 'source_started_at', 'source_ended_at', 'source_time_text',
        'source_message_count', 'memory_tier', 'memory_focus',
        'source_context', 'scene_tag', 'source_app',
        'maintenance_status', 'classification_source', 'classified_at',
        'retention_score', 'retention_action', 'retention_reason', 'retention_checked_at',
        'consolidation_key', 'consolidation_summary', 'consolidated_into_memory_id', 'archive_reason',
        'forgetting_grace_started_at', 'forgetting_grace_expires_at',
        'temporal_label', 'temporal_scope', 'temporal_anchor', 'temporal_confidence', 'temporal_reason', 'temporal_checked_at'
    ].filter(col => columns.has(col));
    if (insertColumns.length === 0) return 0;
    const stmt = makeInsertStatement(rawDb, 'memories', insertColumns);
    let count = 0;
    for (const row of Array.isArray(rows) ? rows : []) {
        const summary = firstImportString(row?.summary, row?.event, row?.content);
        const content = firstImportString(row?.content, row?.event, summary);
        const event = firstImportString(row?.event, summary, content, '(empty memory)');
        if (!event && !content && !summary) continue;
        const createdAt = toArchiveNumber(row?.created_at, Date.now());
        const valuesByColumn = {
            character_id: characterId,
            time: firstImportString(row?.time),
            location: firstImportString(row?.location),
            people: firstImportString(row?.people),
            event,
            relationships: firstImportString(row?.relationships),
            items: firstImportString(row?.items),
            importance: clampImportNumber(row?.importance, 5, 1, 10),
            embedding: null,
            created_at: createdAt,
            last_retrieved_at: toArchiveNumber(row?.last_retrieved_at, 0),
            retrieval_count: toArchiveNumber(row?.retrieval_count, 0),
            group_id: firstImportString(row?.group_id),
            memory_type: firstImportString(row?.memory_type, 'event'),
            summary: summary || event || content,
            content: content || event || summary,
            people_json: stringifyArchiveJson(row?.people_json ?? row?.people ?? [], '[]'),
            items_json: stringifyArchiveJson(row?.items_json ?? row?.items ?? [], '[]'),
            relationship_json: stringifyArchiveJson(row?.relationship_json ?? row?.relationships ?? [], '[]'),
            emotion: firstImportString(row?.emotion),
            source_message_ids_json: stringifyArchiveJson(row?.source_message_ids_json ?? row?.source_message_ids ?? [], '[]'),
            dedupe_key: firstImportString(row?.dedupe_key),
            updated_at: toArchiveNumber(row?.updated_at, createdAt),
            is_archived: toArchiveNumber(row?.is_archived, 0),
            source_started_at: toArchiveNumber(row?.source_started_at, 0),
            source_ended_at: toArchiveNumber(row?.source_ended_at, 0),
            source_time_text: firstImportString(row?.source_time_text),
            source_message_count: toArchiveNumber(row?.source_message_count, 0),
            memory_tier: firstImportString(row?.memory_tier, 'ambient'),
            memory_focus: firstImportString(row?.memory_focus, 'general'),
            source_context: firstImportString(row?.source_context),
            scene_tag: firstImportString(row?.scene_tag),
            source_app: firstImportString(row?.source_app),
            maintenance_status: firstImportString(row?.maintenance_status, 'pending'),
            classification_source: firstImportString(row?.classification_source),
            classified_at: toArchiveNumber(row?.classified_at, 0),
            retention_score: Number.isFinite(Number(row?.retention_score)) ? Number(row.retention_score) : 1,
            retention_action: firstImportString(row?.retention_action),
            retention_reason: firstImportString(row?.retention_reason),
            retention_checked_at: toArchiveNumber(row?.retention_checked_at, 0),
            consolidation_key: firstImportString(row?.consolidation_key),
            consolidation_summary: firstImportString(row?.consolidation_summary),
            consolidated_into_memory_id: toArchiveNumber(row?.consolidated_into_memory_id, 0),
            archive_reason: firstImportString(row?.archive_reason),
            forgetting_grace_started_at: toArchiveNumber(row?.forgetting_grace_started_at, 0),
            forgetting_grace_expires_at: toArchiveNumber(row?.forgetting_grace_expires_at, 0),
            temporal_label: firstImportString(row?.temporal_label),
            temporal_scope: firstImportString(row?.temporal_scope),
            temporal_anchor: firstImportString(row?.temporal_anchor),
            temporal_confidence: Number.isFinite(Number(row?.temporal_confidence)) ? Number(row.temporal_confidence) : 0,
            temporal_reason: firstImportString(row?.temporal_reason),
            temporal_checked_at: toArchiveNumber(row?.temporal_checked_at, 0)
        };
        stmt.run(...insertColumns.map(col => valuesByColumn[col]));
        count += 1;
    }
    return count;
}

function importArchiveMoments(rawDb, characterId, rows = []) {
    const columns = getTableColumnSet(rawDb, 'moments');
    const insertColumns = ['character_id', 'content', 'image_url', 'visibility', 'timestamp', 'likes']
        .filter(col => columns.has(col));
    if (insertColumns.length === 0) return { count: 0, idMap: new Map() };
    const stmt = makeInsertStatement(rawDb, 'moments', insertColumns);
    let count = 0;
    const idMap = new Map();
    for (const row of Array.isArray(rows) ? rows : []) {
        const content = firstImportString(row?.content);
        if (!content) continue;
        const valuesByColumn = {
            character_id: characterId,
            content,
            image_url: firstImportString(row?.image_url),
            visibility: firstImportString(row?.visibility, 'all'),
            timestamp: toArchiveNumber(row?.timestamp, Date.now()),
            likes: toArchiveNumber(row?.likes, 0)
        };
        const info = stmt.run(...insertColumns.map(col => valuesByColumn[col]));
        const oldId = Number(row?.id || 0);
        const newId = Number(info.lastInsertRowid || 0);
        if (oldId > 0 && newId > 0) idMap.set(oldId, newId);
        count += 1;
    }
    return { count, idMap };
}

function importArchiveDiaries(rawDb, characterId, rows = []) {
    const columns = getTableColumnSet(rawDb, 'diaries');
    const insertColumns = ['character_id', 'content', 'emotion', 'is_unlocked', 'timestamp']
        .filter(col => columns.has(col));
    if (insertColumns.length === 0) return 0;
    const stmt = makeInsertStatement(rawDb, 'diaries', insertColumns);
    let count = 0;
    for (const row of Array.isArray(rows) ? rows : []) {
        const content = firstImportString(row?.content);
        if (!content) continue;
        const valuesByColumn = {
            character_id: characterId,
            content,
            emotion: firstImportString(row?.emotion),
            is_unlocked: toArchiveNumber(row?.is_unlocked, 0),
            timestamp: toArchiveNumber(row?.timestamp, Date.now())
        };
        stmt.run(...insertColumns.map(col => valuesByColumn[col]));
        count += 1;
    }
    return count;
}

function importArchiveMomentLikes(rawDb, characterId, rows = [], momentIdMap = new Map(), sourceCharacterId = '') {
    const columns = getTableColumnSet(rawDb, 'moment_likes');
    const insertColumns = ['moment_id', 'liker_id', 'timestamp']
        .filter(col => columns.has(col));
    if (insertColumns.length === 0) return 0;
    const placeholders = insertColumns.map(() => '?').join(', ');
    const stmt = rawDb.prepare(`INSERT OR IGNORE INTO moment_likes (${insertColumns.join(', ')}) VALUES (${placeholders})`);
    let count = 0;
    for (const row of Array.isArray(rows) ? rows : []) {
        const oldMomentId = Number(row?.moment_id || 0);
        const newMomentId = momentIdMap.get(oldMomentId);
        if (!newMomentId) continue;
        const likerId = firstImportString(row?.liker_id) === sourceCharacterId ? characterId : firstImportString(row?.liker_id, 'user');
        const valuesByColumn = {
            moment_id: newMomentId,
            liker_id: likerId,
            timestamp: toArchiveNumber(row?.timestamp, Date.now())
        };
        const info = stmt.run(...insertColumns.map(col => valuesByColumn[col]));
        count += Number(info.changes || 0);
    }
    return count;
}

function importArchiveMomentComments(rawDb, characterId, rows = [], momentIdMap = new Map(), sourceCharacterId = '') {
    const columns = getTableColumnSet(rawDb, 'moment_comments');
    const insertColumns = ['moment_id', 'author_id', 'content', 'timestamp']
        .filter(col => columns.has(col));
    if (insertColumns.length === 0) return 0;
    const stmt = makeInsertStatement(rawDb, 'moment_comments', insertColumns);
    let count = 0;
    for (const row of Array.isArray(rows) ? rows : []) {
        const oldMomentId = Number(row?.moment_id || 0);
        const newMomentId = momentIdMap.get(oldMomentId);
        const content = firstImportString(row?.content);
        if (!newMomentId || !content) continue;
        const authorId = firstImportString(row?.author_id) === sourceCharacterId ? characterId : firstImportString(row?.author_id, 'user');
        const valuesByColumn = {
            moment_id: newMomentId,
            author_id: authorId,
            content,
            timestamp: toArchiveNumber(row?.timestamp, Date.now())
        };
        stmt.run(...insertColumns.map(col => valuesByColumn[col]));
        count += 1;
    }
    return count;
}

function importCharacterArchiveRows(rawDb, characterId, payload) {
    const sourceCharacterId = firstImportString(payload?.character?.id, payload?.character_id);
    const momentsResult = importArchiveMoments(rawDb, characterId, payload.moments);
    return {
        messages: importArchiveMessages(rawDb, characterId, payload.messages),
        memories: importArchiveMemories(rawDb, characterId, payload.memories),
        moments: momentsResult.count,
        moment_likes: importArchiveMomentLikes(rawDb, characterId, payload.moment_likes, momentsResult.idMap, sourceCharacterId),
        moment_comments: importArchiveMomentComments(rawDb, characterId, payload.moment_comments, momentsResult.idMap, sourceCharacterId),
        diaries: importArchiveDiaries(rawDb, characterId, payload.diaries)
    };
}

const MEMORY_MAINTENANCE_FOCUS = new Set(['user_profile', 'user_current_arc', 'relationship', 'general']);
const MEMORY_MAINTENANCE_TIERS = new Set(['core', 'active', 'ambient']);
const MEMORY_MAINTENANCE_STATUS = new Set(['pending', 'classified', 'needs_review', 'consolidated', 'ignored']);
const MEMORY_MAINTENANCE_ACTIONS = new Set(['keep', 'downgrade', 'archive_candidate', 'merge_candidate', 'superseded', 'needs_review']);
const MEMORY_SOURCE_CONTEXTS = new Set(['private_chat', 'group_chat', 'commercial_street', 'external_app', 'unknown']);
const MEMORY_SCENE_TAGS = new Set(['none', 'private_chat', 'group_chat', 'commercial_street', 'external_gpt', 'external_gemini', 'external_sillytavern', 'external_app', 'other']);
const MEMORY_SOURCE_CONTEXT_DEFINITIONS = [
    {
        key: 'private_chat',
        label: '私聊来源',
        description: '来自用户与当前对象的一对一对话。它是来源场景，不等于 user_profile/relationship 等语义分类。'
    },
    {
        key: 'group_chat',
        label: '群聊来源',
        description: '来自群聊消息。群聊只作为来源场景显示，具体内容仍会归入用户画像、关系、当前阶段或普通事件。'
    },
    {
        key: 'commercial_street',
        label: '商业街来源',
        description: '来自商业街/city 行动、工厂、餐厅、便利店、公园、回家、日结等生活日志。默认是当前对象自己的行动。'
    },
    {
        key: 'external_app',
        label: '外部 App 来源',
        description: '来自 GPT、Gemini、SillyTavern 等外部 App 导入记忆。'
    },
    {
        key: 'unknown',
        label: '来源未明',
        description: '暂时无法判断来源场景的正式记忆，后续可用补充 prompt 再打标签。'
    }
];
const MEMORY_FORGETTING_GRACE_MS = 24 * 60 * 60 * 1000;
const MEMORY_TEMPORAL_BINDING_LABELS = new Set([
    'temporary_body_state',
    'temporary_emotion',
    'deadline_or_plan',
    'temporary_location',
    'recent_phase',
    'single_event_state',
    'cyclic_state',
    'other'
]);
const MEMORY_TEMPORAL_BINDING_SCOPES = new Set([
    'single_day',
    'recent_period',
    'until_event_end',
    'cyclic',
    'unknown'
]);
const MEMORY_TEMPORAL_SIGNAL_TERMS = [
    '今天', '昨天', '明天', '今晚', '今早', '刚刚', '刚才', '现在', '此刻', '当下',
    '近期', '最近', '这周', '本周', '这几天', '这段时间', '短期', '临时', '当天',
    '痛经', '月经', '经期', '来姨妈', '来例假', '生理期', '不舒服', '发烧', '感冒',
    '胃痛', '头痛', '失眠', '困', '疲惫', '焦虑', '崩溃', '心情', '压力',
    'today', 'yesterday', 'tomorrow', 'tonight', 'recent', 'now', 'temporary'
];
const MEMORY_TIMELINE_CONFIDENCE_THRESHOLD = 0.5;
const MEMORY_TIMELINE_FILTERS = new Set(['strong_time_bound', 'temporal_signal', 'all']);

function clampNumber(value, fallback, min, max) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.max(min, Math.min(max, parsed));
}

function daysBetween(now, timestamp) {
    const safeTs = Number(timestamp || 0);
    if (!safeTs) return 0;
    return Math.max(0, (Number(now || Date.now()) - safeTs) / 86400000);
}

function getMemoryLastUsefulAt(row = {}) {
    return Number(row.last_retrieved_at || row.updated_at || row.source_ended_at || row.created_at || 0);
}

function detectRoutineCityMemory(row = {}) {
    const type = String(row.memory_type || '').toLowerCase();
    const location = String(row.location || '').toLowerCase();
    const text = [row.summary, row.content, row.event, row.location].filter(Boolean).join(' ').toLowerCase();
    if (type.startsWith('city')) return true;
    if (/^(park|restaurant|home|factory|convenience_store|school|street|mall|cafe|office|hospital)$/.test(location)) return true;
    return /(商业街|公园|餐厅|便利店|街上|散步|发呆|吃饭|回到家|在家|长椅|路灯|晚风|city activity)/i.test(text);
}

function hasProtectedMemorySignal(row = {}) {
    const focus = String(row.memory_focus || '').trim();
    const tier = String(row.memory_tier || '').trim();
    const importance = Number(row.importance || 0);
    const retrievalCount = Number(row.retrieval_count || 0);
    const text = [row.summary, row.content, row.event, row.relationships, row.people].filter(Boolean).join(' ');
    if (tier === 'core') return true;
    if (retrievalCount >= 3) return true;
    if (importance >= 8) return true;
    if (focus === 'relationship' && importance >= 6) return true;
    if (focus === 'user_profile' && importance >= 5) return true;
    return /(你要记住|不许忘|记住|承诺|约定|告白|表白|喜欢你|爱你|和好|分手|边界|秘密|密码|身份|学校|专业|家庭|长期目标)/i.test(text);
}

function computeMemoryRetention(row = {}, now = Date.now()) {
    const tier = String(row.memory_tier || 'ambient').trim();
    const focus = String(row.memory_focus || 'general').trim();
    const routineCity = detectRoutineCityMemory(row);
    const protectedMemory = hasProtectedMemorySignal(row);
    const lastUsefulAt = getMemoryLastUsefulAt(row);
    const idleDays = daysBetween(now, lastUsefulAt);
    const ageDays = daysBetween(now, Number(row.source_ended_at || row.created_at || 0));
    if (protectedMemory) {
        return {
            retention_score: 1,
            suggested_action: 'keep',
            half_life_days: null,
            idle_days: Number(idleDays.toFixed(2)),
            age_days: Number(ageDays.toFixed(2)),
            protected: true,
            routine_city: routineCity,
            reason: 'protected_by_core_relationship_profile_importance_or_retrieval'
        };
    }

    const baseHalfLife = routineCity ? 7 : ({ core: 3650, active: 60, ambient: 21 }[tier] || 21);
    const focusFactor = routineCity ? 0.4 : ({
        relationship: 2.5,
        user_profile: 2,
        user_current_arc: 0.7,
        general: 1
    }[focus] || 1);
    const importance = clampNumber(row.importance, 5, 1, 10);
    const retrievalCount = Math.max(0, Number(row.retrieval_count || 0));
    const importanceFactor = 0.6 + (importance / 10);
    const retrievalFactor = 1 + Math.min(0.8, Math.log1p(retrievalCount) / 4);
    const halfLife = Math.max(1, baseHalfLife * focusFactor * importanceFactor * retrievalFactor);
    const retention = Math.max(0, Math.min(1, Math.pow(0.5, idleDays / halfLife)));
    let suggestedAction = 'keep';
    if (retention < 0.12 && (routineCity || tier === 'ambient')) {
        suggestedAction = 'archive_candidate';
    } else if (retention < 0.25 && tier === 'ambient') {
        suggestedAction = 'archive_candidate';
    } else if (retention < 0.25 && tier === 'active') {
        suggestedAction = 'downgrade';
    } else if (retention < 0.45) {
        suggestedAction = 'needs_review';
    }
    if (focus === 'user_current_arc' && ageDays >= 60 && suggestedAction === 'keep') {
        suggestedAction = 'downgrade';
    }
    return {
        retention_score: Number(retention.toFixed(4)),
        suggested_action: suggestedAction,
        half_life_days: Number(halfLife.toFixed(2)),
        idle_days: Number(idleDays.toFixed(2)),
        age_days: Number(ageDays.toFixed(2)),
        protected: false,
        routine_city: routineCity,
        reason: `tier=${tier};focus=${focus};importance=${importance};retrieval_count=${retrievalCount}`
    };
}

function getMemoryRetentionThreshold(row = {}, retention = null) {
    const tier = String(row.memory_tier || 'ambient').trim();
    const routineCity = retention ? !!retention.routine_city : detectRoutineCityMemory(row);
    if (routineCity || tier === 'ambient') return 0.25;
    if (tier === 'active') return 0.25;
    return 0.12;
}

function computeDaysUntilRetentionThreshold(row = {}, retention = null) {
    const result = retention || computeMemoryRetention(row, Date.now());
    if (result.protected || !Number.isFinite(Number(result.half_life_days))) return null;
    const threshold = getMemoryRetentionThreshold(row, result);
    const score = Number(result.retention_score);
    const idleDays = Number(result.idle_days || 0);
    const halfLife = Number(result.half_life_days || 0);
    if (!Number.isFinite(score) || !Number.isFinite(halfLife) || halfLife <= 0) return null;
    if (score <= threshold) return 0;
    const targetIdleDays = halfLife * (Math.log(threshold) / Math.log(0.5));
    return Math.max(0, Number((targetIdleDays - idleDays).toFixed(2)));
}

function computeMemoryForgettingWindow(row = {}, retention = null, now = Date.now()) {
    const result = retention || computeMemoryRetention(row, now);
    if (result.protected || !Number.isFinite(Number(result.half_life_days))) {
        return {
            stage: 'protected',
            threshold_at: null,
            grace_started_at: null,
            grace_expires_at: null,
            days_until_threshold: null,
            days_until_grace_expires: null,
            grace_hours: 24
        };
    }
    const threshold = getMemoryRetentionThreshold(row, result);
    const halfLife = Number(result.half_life_days || 0);
    if (!Number.isFinite(halfLife) || halfLife <= 0) {
        return {
            stage: 'none',
            threshold_at: null,
            grace_started_at: null,
            grace_expires_at: null,
            days_until_threshold: null,
            days_until_grace_expires: null,
            grace_hours: 24
        };
    }
    const lastUsefulAt = getMemoryLastUsefulAt(row);
    const targetIdleDays = halfLife * (Math.log(threshold) / Math.log(0.5));
    const thresholdAt = lastUsefulAt
        ? Math.round(lastUsefulAt + targetIdleDays * 86400000)
        : Math.round(now + computeDaysUntilRetentionThreshold(row, result) * 86400000);
    const msUntilThreshold = thresholdAt - now;
    let graceStartedAt = null;
    let graceExpiresAt = thresholdAt + MEMORY_FORGETTING_GRACE_MS;
    if (msUntilThreshold <= 0) {
        const storedStartedAt = Number(row.forgetting_grace_started_at || 0);
        const storedExpiresAt = Number(row.forgetting_grace_expires_at || 0);
        graceStartedAt = storedStartedAt > 0 ? storedStartedAt : now;
        graceExpiresAt = storedExpiresAt > graceStartedAt
            ? storedExpiresAt
            : graceStartedAt + MEMORY_FORGETTING_GRACE_MS;
    }
    const msUntilGraceExpires = graceExpiresAt - now;
    const stage = msUntilThreshold > 0 ? 'approaching' : (msUntilGraceExpires > 0 ? 'grace' : 'expired');
    return {
        stage,
        threshold_at: thresholdAt,
        grace_started_at: graceStartedAt,
        grace_expires_at: graceExpiresAt,
        days_until_threshold: Math.max(0, Number((msUntilThreshold / 86400000).toFixed(2))),
        days_until_grace_expires: Number((msUntilGraceExpires / 86400000).toFixed(2)),
        grace_hours: 24
    };
}

function ensureForgettingGraceWindows(rawDb, rows = [], now = Date.now()) {
    if (!rawDb || !Array.isArray(rows) || rows.length === 0) return { started: 0, cleared: 0 };
    const columns = getTableColumnSet(rawDb, 'memories');
    if (!columns.has('forgetting_grace_started_at') || !columns.has('forgetting_grace_expires_at')) {
        return { started: 0, cleared: 0 };
    }
    const startStmt = rawDb.prepare(`
        UPDATE memories
        SET forgetting_grace_started_at = ?,
            forgetting_grace_expires_at = ?
        WHERE id = ?
          AND COALESCE(forgetting_grace_started_at, 0) = 0
    `);
    const fillExpiresStmt = rawDb.prepare(`
        UPDATE memories
        SET forgetting_grace_expires_at = ?
        WHERE id = ?
          AND COALESCE(forgetting_grace_started_at, 0) > 0
          AND COALESCE(forgetting_grace_expires_at, 0) = 0
    `);
    const clearStmt = rawDb.prepare(`
        UPDATE memories
        SET forgetting_grace_started_at = 0,
            forgetting_grace_expires_at = 0
        WHERE id = ?
          AND (COALESCE(forgetting_grace_started_at, 0) > 0 OR COALESCE(forgetting_grace_expires_at, 0) > 0)
    `);
    let started = 0;
    let cleared = 0;
    const tx = rawDb.transaction((items) => {
        for (const row of items) {
            const retention = computeMemoryRetention(row, now);
            const daysUntilThreshold = computeDaysUntilRetentionThreshold(row, retention);
            const shouldBeInGrace = !retention.protected && daysUntilThreshold !== null && Number(daysUntilThreshold) <= 0;
            const existingStartedAt = Number(row.forgetting_grace_started_at || 0);
            const existingExpiresAt = Number(row.forgetting_grace_expires_at || 0);
            if (shouldBeInGrace && existingStartedAt <= 0) {
                const expiresAt = now + MEMORY_FORGETTING_GRACE_MS;
                const info = startStmt.run(now, expiresAt, row.id);
                if (Number(info.changes || 0) > 0) {
                    row.forgetting_grace_started_at = now;
                    row.forgetting_grace_expires_at = expiresAt;
                    started += 1;
                }
            } else if (shouldBeInGrace && existingStartedAt > 0 && existingExpiresAt <= 0) {
                const expiresAt = existingStartedAt + MEMORY_FORGETTING_GRACE_MS;
                const info = fillExpiresStmt.run(expiresAt, row.id);
                if (Number(info.changes || 0) > 0) {
                    row.forgetting_grace_expires_at = expiresAt;
                }
            } else if (!shouldBeInGrace && (existingStartedAt > 0 || existingExpiresAt > 0)) {
                const info = clearStmt.run(row.id);
                if (Number(info.changes || 0) > 0) {
                    row.forgetting_grace_started_at = 0;
                    row.forgetting_grace_expires_at = 0;
                    cleared += 1;
                }
            }
        }
    });
    tx(rows);
    return { started, cleared };
}

function buildMemoryMaintenancePayload(row, now = Date.now()) {
    const retention = computeMemoryRetention(row, now);
    const daysUntilThreshold = computeDaysUntilRetentionThreshold(row, retention);
    const forgettingWindow = computeMemoryForgettingWindow(row, retention, now);
    const sourceContext = inferMemorySourceContext(row);
    const sceneTag = inferMemorySceneTag(row, sourceContext);
    return {
        id: row.id,
        character_id: row.character_id,
        summary: row.summary || row.event || '',
        content: row.content || row.event || '',
        event: row.event || row.summary || '',
        current: {
            memory_type: row.memory_type || 'event',
            memory_focus: row.memory_focus || 'general',
            memory_tier: row.memory_tier || 'ambient',
            importance: Number(row.importance || 5),
            maintenance_status: row.maintenance_status || 'pending',
            retention_action: row.retention_action || '',
            retention_score: Number(row.retention_score ?? 1),
            consolidation_key: row.consolidation_key || '',
            consolidation_summary: row.consolidation_summary || '',
            source_context: sourceContext,
            scene_tag: sceneTag,
            source_app: row.source_app || '',
            temporal_label: row.temporal_label || '',
            temporal_scope: row.temporal_scope || '',
            temporal_anchor: row.temporal_anchor || ''
        },
        signals: {
            retrieval_count: Number(row.retrieval_count || 0),
            last_retrieved_at: Number(row.last_retrieved_at || 0),
            created_at: Number(row.created_at || 0),
            updated_at: Number(row.updated_at || 0),
            source_started_at: Number(row.source_started_at || 0),
            source_ended_at: Number(row.source_ended_at || 0),
            source_time_text: row.source_time_text || '',
            source_message_count: Number(row.source_message_count || 0)
        },
        retention: {
            ...retention,
            threshold: getMemoryRetentionThreshold(row, retention),
            days_until_threshold: daysUntilThreshold,
            forgetting_window: forgettingWindow
        }
    };
}

function getMemoryMaintenanceBatch(rawDb, characterId, options = {}) {
    const batchOptions = normalizeMemoryMaintenanceBatchOptions(options, { limitFallback: 30 });
    const limit = batchOptions.limit;
    const afterId = batchOptions.after_id;
    const offset = batchOptions.offset;
    const includeArchived = !!options.include_archived;
    const status = String(options.status || 'pending').trim().toLowerCase();
    const where = ['character_id = ?'];
    const params = [characterId];
    if (!includeArchived) where.push('COALESCE(is_archived, 0) = 0');
    if (afterId > 0) {
        where.push('id > ?');
        params.push(afterId);
    }
    if (status !== 'all') {
        if (status === 'pending') {
            where.push("(COALESCE(maintenance_status, '') = '' OR maintenance_status = 'pending')");
        } else if (MEMORY_MAINTENANCE_STATUS.has(status)) {
            where.push('maintenance_status = ?');
            params.push(status);
        }
    }
    const totalMatching = rawDb.prepare(`
        SELECT COUNT(*) AS count
        FROM memories
        WHERE ${where.join(' AND ')}
    `).get(...params)?.count || 0;
    const rows = rawDb.prepare(`
        SELECT *
        FROM memories
        WHERE ${where.join(' AND ')}
        ORDER BY id ASC
        LIMIT ? OFFSET ?
    `).all(...params, limit, offset);
    const remainingPending = rawDb.prepare(`
        SELECT COUNT(*) AS count
        FROM memories
        WHERE character_id = ?
          AND COALESCE(is_archived, 0) = 0
          AND (COALESCE(maintenance_status, '') = '' OR maintenance_status = 'pending')
    `).get(characterId)?.count || 0;
    const externalPendingCount = status === 'pending' ? getExternalImportPendingCountForCharacter(rawDb, characterId) : 0;
    if (status === 'pending' && rows.length === 0) {
        const externalOffset = Math.max(0, offset - Number(totalMatching || 0));
        const externalBatch = getExternalImportMaintenanceBatch(rawDb, characterId, { limit, offset: externalOffset });
        if (externalBatch.items.length > 0) {
            return {
                ...externalBatch,
                remaining_pending: Number(remainingPending || 0) + externalPendingCount,
                total_matching: Number(totalMatching || 0) + externalPendingCount,
                total_batches: Math.max(0, Math.ceil((Number(totalMatching || 0) + externalPendingCount) / limit))
            };
        }
    }
    const now = Date.now();
    return {
        source_kind: 'legacy_memory',
        items: rows.map(row => buildMemoryMaintenancePayload(row, now)),
        next_after_id: rows.length > 0 ? rows[rows.length - 1].id : afterId,
        remaining_pending: Number(remainingPending || 0) + externalPendingCount,
        offset,
        batch_index: Math.floor(offset / limit) + 1,
        total_matching: Number(totalMatching || 0) + externalPendingCount,
        total_batches: Math.max(0, Math.ceil((Number(totalMatching || 0) + externalPendingCount) / limit))
    };
}

function normalizeExternalProcessingState(value) {
    const raw = safeJsonParse(value, []);
    if (!Array.isArray(raw)) return [];
    return raw.map(item => {
        if (item && typeof item === 'object' && !Array.isArray(item)) return item;
        const numericId = Number(item || 0);
        return numericId > 0 ? { memory_id: numericId } : null;
    }).filter(Boolean);
}

function makeExternalProcessingKey(importId, candidateId, characterId) {
    return `${Number(importId || 0)}:${String(candidateId || '')}:${String(characterId || '')}`;
}

function getExternalImportRows(rawDb) {
    // External app imports are now summarized directly into the new library.
    // Keep historical rows for source traceability, but do not feed them into
    // the legacy maintenance scanner again.
    return [];
}

function getExternalCharacterName(rawDb, characterId) {
    try {
        const row = rawDb.prepare('SELECT name FROM characters WHERE id = ?').get(characterId);
        return row?.name || '';
    } catch (e) {
        return '';
    }
}

function buildExternalImportPendingItems(rawDb, characterId) {
    const characterName = normalizeExternalCharacterName(getExternalCharacterName(rawDb, characterId)).toLowerCase();
    if (!characterName) return [];
    const items = [];
    for (const row of getExternalImportRows(rawDb)) {
        const selectedIds = safeJsonParse(row.selected_character_ids_json, [])
            .map(id => String(id || ''))
            .filter(Boolean);
        if (!selectedIds.includes(String(characterId))) continue;
        const state = normalizeExternalProcessingState(row.memory_ids_json);
        const processedKeys = new Set(state
            .filter(item => String(item.character_id || '') === String(characterId) && item.candidate_id)
            .map(item => item.key || makeExternalProcessingKey(row.id, item.candidate_id, characterId)));
        const summary = safeJsonParse(row.summary_json, {});
        const candidates = Array.isArray(summary.candidates) ? summary.candidates : [];
        const sourceApp = row.source_app || summary.source_app || 'external_app';
        const appLabel = getExternalSourceAppLabel(sourceApp);
        const sceneTag = getExternalSceneTag(sourceApp);
        for (const candidate of candidates) {
            const candidateNames = (Array.isArray(candidate.character_names) ? candidate.character_names : [])
                .map(name => normalizeExternalCharacterName(name).toLowerCase())
                .filter(Boolean);
            const oneToOneFallback = candidateNames.length === 0 && String(row.import_mode || '') === 'one_to_one' && selectedIds.length === 1;
            if (!candidateNames.includes(characterName) && !oneToOneFallback) continue;
            const key = makeExternalProcessingKey(row.id, candidate.id, characterId);
            if (processedKeys.has(key)) continue;
            items.push({
                importRow: row,
                candidate,
                key,
                sourceApp,
                appLabel,
                sceneTag
            });
        }
    }
    return items;
}

function getExternalImportPendingCountForCharacter(rawDb, characterId) {
    return buildExternalImportPendingItems(rawDb, characterId).length;
}

function getExternalImportPendingStatsByCharacter(rawDb) {
    let characters = [];
    try {
        characters = rawDb.prepare('SELECT id, name FROM characters ORDER BY name COLLATE NOCASE ASC').all();
    } catch (e) {
        return new Map();
    }
    const stats = new Map();
    for (const character of characters) {
        const count = getExternalImportPendingCountForCharacter(rawDb, character.id);
        if (count > 0) {
            stats.set(String(character.id), {
                character_id: character.id,
                name: character.name || character.id,
                pending: count,
                total: count
            });
        }
    }
    return stats;
}

function getExternalImportMaintenanceBatch(rawDb, characterId, options = {}) {
    const batchOptions = normalizeMemoryMaintenanceBatchOptions(options, { limitFallback: 30 });
    const limit = batchOptions.limit;
    const offset = batchOptions.offset;
    const allItems = buildExternalImportPendingItems(rawDb, characterId);
    const now = Date.now();
    const items = allItems.slice(offset, offset + limit).map((entry, index) => {
        const candidate = entry.candidate || {};
        const sourceStartedAt = Number(candidate.source_started_at || 0);
        const sourceEndedAt = Number(candidate.source_ended_at || sourceStartedAt || 0);
        return {
            id: index + 1,
            character_id: characterId,
            summary: candidate.summary || candidate.content || '',
            content: candidate.content || candidate.summary || '',
            event: candidate.summary || candidate.content || '',
            current: {
                memory_type: 'external_import_staged',
                memory_focus: MEMORY_MAINTENANCE_FOCUS.has(candidate.memory_focus) ? candidate.memory_focus : 'general',
                memory_tier: MEMORY_MAINTENANCE_TIERS.has(candidate.memory_tier) ? candidate.memory_tier : 'ambient',
                importance: Math.round(clampImportNumber(candidate.importance, 5, 1, 10)),
                maintenance_status: 'pending',
                retention_action: 'keep',
                retention_score: 1,
                consolidation_key: candidate.consolidation_key || '',
                consolidation_summary: '',
                source_context: 'external_app',
                scene_tag: entry.sceneTag,
                source_app: entry.appLabel,
                temporal_label: '',
                temporal_scope: '',
                temporal_anchor: ''
            },
            signals: {
                retrieval_count: 0,
                last_retrieved_at: 0,
                created_at: Number(entry.importRow?.created_at || now),
                updated_at: Number(entry.importRow?.committed_at || entry.importRow?.created_at || now),
                source_started_at: sourceStartedAt,
                source_ended_at: sourceEndedAt,
                source_time_text: candidate.source_time_text || '',
                source_message_count: Number(candidate.source_message_count || candidate.source_refs?.length || 0)
            },
            retention: {
                retention_score: 1,
                suggested_action: 'keep',
                reason: '外部导入暂存原料，等待自动总结。',
                threshold: null,
                days_until_threshold: null,
                forgetting_window: null
            },
            external_import: {
                import_id: Number(entry.importRow?.id || 0),
                candidate_id: String(candidate.id || ''),
                character_id: String(characterId),
                key: entry.key,
                source_message_ids_json: [`external-import:${entry.importRow?.id}:${candidate.id}`],
                source_refs: Array.isArray(candidate.source_refs) ? candidate.source_refs : [],
                source_app: entry.appLabel,
                scene_tag: entry.sceneTag
            }
        };
    });
    return {
        source_kind: 'external_import',
        items,
        next_after_id: 0,
        remaining_pending: allItems.length,
        offset,
        batch_index: Math.floor(offset / limit) + 1,
        total_matching: allItems.length,
        total_batches: Math.max(0, Math.ceil(allItems.length / limit))
    };
}

function buildMemoryTemporalBindingPayload(row, source = 'new') {
    const legacyText = row.summary || row.content || row.event || '';
    const primaryText = row.consolidation_summary || legacyText;
    const sourceContext = inferMemorySourceContext(row);
    const sceneTag = inferMemorySceneTag(row, sourceContext);
    const sourceIds = String(row.source_ids || row.id || '')
        .split(',')
        .map(id => Number(id || 0))
        .filter(id => id > 0);
    return {
        id: row.id,
        source_ids: sourceIds.length ? sourceIds : [Number(row.id || 0)].filter(Boolean),
        source_count: Number(row.source_count || sourceIds.length || 1),
        text: clipMemoryDisplayText(primaryText, 180),
        source_card_text: clipMemoryDisplayText(legacyText, 120),
        current: {
            memory_focus: row.memory_focus || 'general',
            memory_tier: row.memory_tier || 'ambient',
            importance: Number(row.importance || 5),
            maintenance_status: row.maintenance_status || 'pending',
            consolidation_key: row.consolidation_key || '',
            has_consolidation_summary: !!String(row.consolidation_summary || '').trim(),
            source_context: sourceContext,
            scene_tag: sceneTag,
            source_app: row.source_app || '',
            temporal_label: row.temporal_label || '',
            temporal_scope: row.temporal_scope || '',
            temporal_anchor: row.temporal_anchor || ''
        },
        signals: {
            time: row.time || '',
            source_time_text: row.source_time_text || '',
            source_started_at: Number(row.source_started_at || 0),
            source_ended_at: Number(row.source_ended_at || 0),
            created_at: Number(row.created_at || 0),
            updated_at: Number(row.updated_at || 0),
            retrieval_count: Number(row.retrieval_count || 0)
        }
    };
}

function getMemoryTemporalBindingBatch(rawDb, characterId, options = {}) {
    const batchOptions = normalizeMemoryMaintenanceBatchOptions(options, { limitFallback: 40 });
    const limit = batchOptions.limit;
    const offset = batchOptions.offset;
    const source = normalizeMemoryTemporalBindingSource(options.source || 'new');
    const includeArchived = !!options.include_archived;
    const where = ['character_id = ?'];
    const params = [characterId];
    if (!includeArchived) where.push('COALESCE(is_archived, 0) = 0');
    where.push("COALESCE(NULLIF(consolidation_summary, ''), '') <> ''");
    if (source === 'new_temporal_signal') {
        where.push(getMemoryTemporalSignalSql());
        params.push(...getMemoryTemporalSignalParams());
    }
    const formalGroupExpr = "COALESCE(NULLIF(consolidation_key, ''), '') || '::' || LOWER(TRIM(COALESCE(consolidation_summary, '')))";
    const totalMatching = rawDb.prepare(`
        SELECT COUNT(*) AS count
        FROM (
            SELECT 1
            FROM memories
            WHERE ${where.join(' AND ')}
            GROUP BY ${formalGroupExpr}
        ) formal_groups
    `).get(...params)?.count || 0;
    const rows = rawDb.prepare(`
        WITH eligible AS (
            SELECT *,
                   ${formalGroupExpr} AS formal_group_key,
                   COALESCE(NULLIF(source_ended_at, 0), NULLIF(source_started_at, 0), NULLIF(created_at, 0), id) AS formal_sort_at
            FROM memories
            WHERE ${where.join(' AND ')}
        ),
        grouped AS (
            SELECT formal_group_key,
                   MAX(formal_sort_at) AS formal_sort_at,
                   COUNT(*) AS source_count,
                   GROUP_CONCAT(id) AS source_ids
            FROM eligible
            GROUP BY formal_group_key
        )
        SELECT e.*, g.source_count, g.source_ids, g.formal_sort_at
        FROM grouped g
        JOIN eligible e ON e.id = (
            SELECT e2.id
            FROM eligible e2
            WHERE e2.formal_group_key = g.formal_group_key
            ORDER BY e2.formal_sort_at DESC, e2.id DESC
            LIMIT 1
        )
        ORDER BY g.formal_sort_at DESC, e.id DESC
        LIMIT ? OFFSET ?
    `).all(...params, limit, offset);
    return {
        source,
        items: rows.map(row => buildMemoryTemporalBindingPayload(row, source)),
        offset,
        batch_index: Math.floor(offset / limit) + 1,
        total_matching: Number(totalMatching || 0),
        total_batches: Math.max(0, Math.ceil(Number(totalMatching || 0) / limit))
    };
}

function buildMemoryMigrationPrompt(character, batch, options = {}) {
    const batchSize = Array.isArray(batch?.items) ? batch.items.length : 0;
    const fields = ['id', 'memory_card_text', 'focus', 'tier', 'importance', 'calls', 'score', 'forget_in_days', 'action', 'time', 'source_time_text', 'source_context', 'scene_tag'];
    const compactItems = (batch?.items || []).map(item => ([
        item.id,
        clipMemoryDisplayText(item.summary || item.content || item.event || '', 120),
        item.current?.memory_focus || 'general',
        item.current?.memory_tier || 'ambient',
        Number(item.current?.importance || 5),
        Number(item.signals?.retrieval_count || 0),
        Number(item.retention?.retention_score ?? item.current?.retention_score ?? 1),
        item.retention?.days_until_threshold ?? null,
        item.current?.retention_action || item.retention?.suggested_action || 'keep',
        item.signals?.time || '',
        item.signals?.source_time_text || '',
        item.current?.source_context || 'private_chat',
        item.current?.scene_tag || 'private_chat'
    ]));
    const source = {
        input_kind: 'old_memory_card_compact_rows',
        input_note: 'Rows are model-extracted memory cards from ChatPulse or imported apps such as GPT/Gemini/SillyTavern, not raw chat/log source text and not embedding index text.',
        character: { id: character?.id || '', name: character?.name || '' },
        fields,
        rows: compactItems,
        next_after_id: batch?.next_after_id || 0,
        remaining_pending: batch?.remaining_pending || 0
    };
    const systemPrompt = `你是 ChatPulse 记忆库迁移与时间标签小模型。输入是“旧记忆卡片/外部 App 导入记忆的紧凑概况”，不是原始对话/日志，也不是 embedding 索引文本。你只做卡片级整理：去噪、合并、拆分、分类、给迁移建议，并为新记忆判断时间绑定标签。不要聊天、不要扩写、不要猜测。所有面向用户的自然语言字段必须输出简体中文，即使输入记忆卡片是英文；枚举值和 consolidation_key 保持英文机器格式。只输出合法 JSON；不要输出思考过程、解释、Markdown 或代码块。输出必须以 { 开始、以 } 结束。`;
    const userPrompt = `任务：把本批旧记忆卡片或外部 App 导入记忆迁移为新版记忆库条目，并同时给每条新记忆打时间标签。30 条卡片不是总结成 1 条，而是去噪、拆分、合并后输出若干条可召回的原子记忆。每个输入 id 都必须有明确去向：要么被某条 new_memories.source_ids 覆盖，要么出现在 old_memory_actions 里；不要无声忽略任何输入卡片。

分类：user_profile=用户长期画像；relationship=用户与当前角色关系；user_current_arc=近期阶段/任务/压力；general=普通事件。
来源/场景：source_context 表示记忆从哪里来，只能是 private_chat、group_chat、commercial_street、external_app、unknown；scene_tag 表示场景/来源细分，只能是 none、private_chat、group_chat、commercial_street、external_gpt、external_gemini、external_sillytavern、external_app、other。商业街、群聊和外部 App 不要新增为 memory_focus，而是写在 source_context/scene_tag。
层级：core=身份/人格/长期关系/强边界，慎用；active=当前有用但会过期；ambient=低价值背景。
语言：summary、reason 等自然语言字段统一用简体中文；可以保留 Claude、GPT、API、Qdrant、地名、人名等专有名词原文；consolidation_key 必须是英文 snake_case。
规则：只基于输入卡片概况；不要假装读过原始对话；同义重复合并；一条新记忆只写一个事实；冲突/敏感/不确定用 needs_review；明确无后续价值的噪声/一次性闲聊才 archive；summary 不写“本批/多条记忆显示”。用户临时身体/情绪状态保留在原语义分类中，不新增分类；除非卡片明确表示长期、反复、慢性或稳定偏好，否则不要写成 user_profile。临时状态有明确日期、当天、近期等时间锚时，summary 要保留这个时间锚。
保留角色记忆：不要因为内容是“角色自己的经历/状态/商业街生活/对用户的反应”就默认当成无用。只要它体现当前角色的持续状态、重要经历、任务进展、健康/金钱风险、对用户的关系变化、稳定偏好或会影响未来互动，就必须 create 或 merge_create。只有纯流水账、失败输出、系统提示、重复片段、没有后续影响的一次性动作才 archive。
表述规则：summary 是给主模型召回的正式记忆，不是元叙事备注。不要用“在角色扮演中”“角色扮演里”“在设定中”“剧情中”“扮演时”等前缀包装普通事件；除非输入卡片明确讨论“角色扮演机制/元矛盾/扮演规则”本身，否则直接写成“${character?.name || '当前对象'}……”。如果必须表达元层冲突，用“互动语境/对话语境/元层矛盾”，不要把普通经历都说成角色扮演。
主语判定（非常重要）：
- “用户/Nana”只指真实用户；“${character?.name || '当前对象'} / 当前对象 / 当前角色本人”指本角色本人。这里的“角色”只是数据库对象，不等于 roleplay。
- commercial_street / 商业街 / city 活动 / 工厂 / 餐厅 / 便利店 / 公园 / 回家 / 领工钱 / 日结等第一人称生活日志，默认是 ${character?.name || '当前对象'} 自己在商业街发生的事，不是用户做的事。summary 必须写“${character?.name || '当前对象'}……”，不能写“用户……”，也不能额外加“在角色扮演中”。
- source_context="commercial_street" 的硬前提：主语必须是第一人称商业街生活日志、当前角色本人，或可明确还原为当前角色本人。只要这条新记忆的主语是“用户/Nana/User”（例如用户开发游戏、读博实习、现实工作压力、现实身体状态），就禁止标 commercial_street；即使文本提到“商业街”、可视化商业街、或本批 source_ids 混有 city:，也只能按内容标 private_chat 或 unknown。
- 只有输入卡片明确写“用户/Nana/User”做了某事时，summary 才能以用户为主语。
- ${character?.name || '当前对象'} 在商业街的工作、吃饭、休息、受伤、赚钱、回家等经历，不要归为 user_profile 或 user_current_arc；通常用 general，只有直接改变用户与 ${character?.name || '当前对象'} 关系时才用 relationship。
动作：create, merge_create, archive, needs_review, skip_duplicate。

时间标签规则：
- 只有记忆内容依赖时间语境时才标 is_time_bound=true；不要因为有来源日期就强行标。
- 临时身体/情绪/地点/计划/阶段/周期性状态必须打时间标签，例如痛经、今天焦虑、最近赶 ddl、明天面试、这次经期。
- 长期身份、长期偏好、长期关系边界、稳定目标通常 is_time_bound=false。
- 如果输入来自 GPT/Gemini/SillyTavern 等外部导出，可能只有概况没有来源时间；不能补造日期，只能写“未明确”或从卡片文字中抽取。

输出 JSON：
{
  "new_memories": [
    {
      "action": "create | merge_create",
      "source_ids": [123],
      "summary": "短而清楚的中文新记忆",
      "memory_focus": "user_profile | relationship | user_current_arc | general",
      "memory_tier": "core | active | ambient",
      "source_context": "private_chat | group_chat | commercial_street | external_app | unknown",
      "scene_tag": "none | private_chat | group_chat | commercial_street | external_gpt | external_gemini | external_sillytavern | external_app | other",
      "importance": 1-10,
      "consolidation_key": "english_snake_case_key",
      "reason": "一句中文理由",
      "time_binding": {
        "is_time_bound": true,
        "label": "temporary_body_state | temporary_emotion | deadline_or_plan | temporary_location | recent_phase | single_event_state | cyclic_state | other",
        "scope": "single_day | recent_period | until_event_end | cyclic | unknown",
        "time_anchor": "今天 / 2026-05-22 / 最近几天 / 明天汇报前 / 未明确",
        "confidence": 0.0-1.0,
        "reason": "一句中文理由"
      }
    }
  ],
  "old_memory_actions": [
    {
      "id": 123,
      "action": "archive | needs_review | skip_duplicate",
      "reason": "一句中文理由"
    }
  ]
}

约束：new_memories 通常 3-12 条；source_ids 必须来自输入卡片 id；importance 是整数；不确定就 needs_review；非时间绑定记忆的 time_binding 写 {"is_time_bound":false,"label":"","scope":"","time_anchor":"","confidence":0,"reason":"长期或不依赖时间语境"}；如果本批没有可迁移内容，也必须把所有输入 id 放进 old_memory_actions，并说明 archive/needs_review/skip_duplicate 的理由。禁止返回空 JSON 导致输入 id 没有去向。

输入旧记忆/外部导入记忆卡片 JSON（紧凑数组；fields 对应 rows 每一列；不含原始对话/日志，不含 embedding 索引文本）：
${JSON.stringify(source)}`;
    return {
        version: 'memory-card-migration-time-tags-v9',
        target: 'old-or-external-memory-card-batch-to-new-library-with-time-tags',
        batch_size: batchSize,
        model_name: options.model_name || '',
        system_prompt: systemPrompt,
        user_prompt: userPrompt,
        full_prompt: `${systemPrompt}\n\n---\n\n${userPrompt}`
    };
}

function buildMemoryTemporalBindingPrompt(character, batch, options = {}) {
    const batchSize = Array.isArray(batch?.items) ? batch.items.length : 0;
    const fields = [
        'id',
        'memory_text',
        'source_card_text',
        'source_count',
        'focus',
        'tier',
        'importance',
        'calls',
        'time',
        'source_time_text',
        'source_context',
        'scene_tag'
    ];
    const compactItems = (batch?.items || []).map(item => ([
        item.id,
        item.text || '',
        item.source_card_text || '',
        Number(item.source_count || 1),
        item.current?.memory_focus || 'general',
        item.current?.memory_tier || 'ambient',
        Number(item.current?.importance || 5),
        Number(item.signals?.retrieval_count || 0),
        item.signals?.time || '',
        item.signals?.source_time_text || '',
        item.current?.source_context || 'private_chat',
        item.current?.scene_tag || 'private_chat'
    ]));
    const source = {
        input_kind: 'memory_temporal_binding_compact_rows',
        input_note: 'Rows are memory cards or migrated memory summaries, not raw chat/log source text and not embedding index text.',
        character: { id: character?.id || '', name: character?.name || '' },
        source_scope: batch?.source || 'new',
        fields,
        rows: compactItems,
        batch_index: batch?.batch_index || 1,
        total_batches: batch?.total_batches || 0,
        total_matching: batch?.total_matching || 0
    };
    const systemPrompt = `你是 ChatPulse 记忆库来源场景与时间标签小模型。输入是已经存在的记忆卡片或新版总结，不是原始对话/日志，也不是 embedding 索引文本。你只做两件事：判断每条记忆的来源/场景标签，并判断它是否和时间强绑定。不要改写记忆内容，不要改变 memory_focus，不做归纳迁移，不删除记忆。所有自然语言字段输出简体中文。只输出合法 JSON；不要输出解释、Markdown 或代码块。输出必须以 { 开始、以 } 结束。`;
    const userPrompt = `任务：给本批记忆补来源场景标签和时间标签。这个 prompt 只负责标注，不负责总结、合并、分类或写新记忆。商业街、群聊、外部 App 是 source_context/scene_tag，不是 memory_focus。

来源/场景标签规则：
- source_context 只能是：private_chat、group_chat、commercial_street、external_app、unknown。
- scene_tag 只能是：none、private_chat、group_chat、commercial_street、external_gpt、external_gemini、external_sillytavern、external_app、other。
- 商业街活动、商业街行动、city: 来源、街区/餐厅/便利店/公园/工厂等商业街生活记录，标 commercial_street。
- commercial_street 的主语必须是第一人称商业街生活日志、当前角色本人，或可明确还原为当前角色本人。主语是“用户/Nana/User”的记忆禁止标 commercial_street；用户开发游戏、读博实习、现实工作压力、现实身体状态，即使文本提到商业街或混有 city: source_id，也按内容标 private_chat 或 unknown。
- 群聊、group_id、多人对话、群成员互动，标 group_chat。
- GPT、Gemini、SillyTavern 等外部 App 导入记忆，source_context 标 external_app，scene_tag 按 external_gpt/external_gemini/external_sillytavern 细分；不能判断具体 App 就用 external_app。
- 私聊记忆标 private_chat；当前版本不使用日记/动态作为来源分类，如果只像日记或动态但无法归入私聊、群聊、商业街、外部 App，就用 unknown/other。

主语判定规则：
- “用户/Nana”只指真实用户；“当前角色/角色/${character?.name || '当前角色'}”指本角色。
- commercial_street / 商业街 / city 活动 / 工厂 / 餐厅 / 便利店 / 公园 / 回家 / 领工钱 / 日结等第一人称生活日志，默认是当前角色在商业街发生的事，不是用户做的事。
- source_context="commercial_street" 的硬前提：主语必须是第一人称商业街生活日志、当前角色本人，或可明确还原为当前角色本人。主语是“用户/Nana/User”的记忆，禁止标 commercial_street；即使文本提到商业街或本批 source_ids 混有 city:，也只能按内容标 private_chat 或 unknown。
- 本 prompt 只补标签，不改写文本；但判断 source_context/scene_tag 和 time_labels 时必须按上述主语理解，不要把角色的商业街行动当成用户状态。

时间强绑定包括：
- 临时身体状态：痛经、经期/生理期、当天不舒服、发烧、感冒、胃痛、头痛、短期疲惫等。
- 临时情绪/压力：今天焦虑、这几天崩溃、最近压力很大、某个汇报/考试/ddl 前后的情绪。
- 临时地点/行程/任务：今天在某地、刚从某地回来、明天要做某事、短期计划或截止日期。
- 周期性但不是长期画像的状态：例如“这次经期痛经”，可以标 cyclic_state，但不能把它当成用户永远如此。

不要标为时间强绑定：
- 稳定身份、专业、长期偏好、长期关系边界、长期目标。
- 长期/反复/慢性状态，除非这条记忆明确是在说“这一次/今天/近期”的状态。
- 普通历史事件本身有来源时间，但内容不依赖这个时间仍然成立的，不要仅因为有 source_time_text 就标。

输出 JSON：
{
  "source_labels": [
    {
      "id": 123,
      "source_context": "private_chat | group_chat | commercial_street | external_app | unknown",
      "scene_tag": "none | private_chat | group_chat | commercial_street | external_gpt | external_gemini | external_sillytavern | external_app | other",
      "source_app": "GPT / Gemini / SillyTavern / 空字符串",
      "confidence": 0.0-1.0,
      "reason": "一句中文理由"
    }
  ],
  "time_labels": [
    {
      "id": 123,
      "is_time_bound": true,
      "label": "temporary_body_state | temporary_emotion | deadline_or_plan | temporary_location | recent_phase | single_event_state | cyclic_state | other",
      "scope": "single_day | recent_period | until_event_end | cyclic | unknown",
      "time_anchor": "今天 / 2026-05-22 / 最近几天 / 明天汇报前 / 未明确",
      "confidence": 0.0-1.0,
      "reason": "一句中文理由"
    }
  ],
  "needs_review": [
    {
      "id": 123,
      "reason": "为什么不确定"
    }
  ],
  "not_time_bound_ids": [456]
}

约束：id 必须来自输入；source_labels 必须尽量覆盖输入里的每条记忆；真正依赖时间语境的记忆放进 time_labels 且 is_time_bound=true；不依赖时间语境的 id 放进 not_time_bound_ids；来源或时间不确定的放进 needs_review。不要输出原文以外的新事实；如果没有时间候选，也仍然要输出 source_labels，并输出 {"time_labels":[],"needs_review":[],"not_time_bound_ids":[...]}。

输入记忆 JSON（紧凑数组；fields 对应 rows 每一列；不含原始对话/日志，不含 embedding 索引文本）：
${JSON.stringify(source)}`;
    return {
        version: 'memory-source-scene-time-label-v6',
        target: 'memory-library-source-scene-and-time-label-only',
        batch_size: batchSize,
        model_name: options.model_name || '',
        system_prompt: systemPrompt,
        user_prompt: userPrompt,
        full_prompt: `${systemPrompt}\n\n---\n\n${userPrompt}`
    };
}

function extractJsonObjectFromText(text = '') {
    const raw = String(text || '').replace(/```json/gi, '').replace(/```/g, '').trim();
    if (!raw) {
        const error = new Error('小模型没有返回 JSON 对象，后端找不到完整的 { ... }。');
        error.code = 'small_model_json_missing';
        error.payload = { raw_response: raw };
        throw error;
    }
    try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            const error = new Error('小模型返回的 JSON 不是对象。');
            error.code = 'small_model_invalid_json';
            error.payload = { raw_response: raw, json_preview: clipMemoryDisplayText(raw, 1600) };
            throw error;
        }
        return parsed;
    } catch (e) {
        if (e?.code === 'small_model_invalid_json') throw e;
        const error = new Error(`小模型返回的 JSON 格式不合法：${e.message}`);
        error.code = 'small_model_invalid_json';
        error.payload = { raw_response: raw, json_preview: clipMemoryDisplayText(raw, 1600) };
        throw error;
    }
}

function hasCjkText(value = '') {
    return /[\u3400-\u9fff]/.test(String(value || ''));
}

function normalizeSmallModelMigrationResult(parsed = {}, knownIds = []) {
    const idSet = new Set((knownIds || []).map(id => Number(id || 0)).filter(Boolean));
    const applyItems = [];
    const errors = [];
    const newMemories = Array.isArray(parsed.new_memories) ? parsed.new_memories : [];
    const oldActions = Array.isArray(parsed.old_memory_actions) ? parsed.old_memory_actions : [];

    for (const mem of newMemories) {
        const sourceIds = Array.isArray(mem?.source_ids) ? mem.source_ids.map(id => Number(id || 0)).filter(id => idSet.has(id)) : [];
        if (sourceIds.length === 0) {
            errors.push({ error: 'new_memory missing valid source_ids', memory: mem });
            continue;
        }
        const action = String(mem.action || '').trim() === 'create' ? 'keep' : 'merge_candidate';
        const summary = String(mem.summary || '').trim();
        if (!summary || !hasCjkText(summary)) {
            errors.push({ error: 'new_memory summary must be Simplified Chinese', memory: mem });
            continue;
        }
        const reason = String(mem.reason || '').trim();
        const sourceContext = String(mem.source_context || '').trim();
        const sceneTag = String(mem.scene_tag || '').trim();
        if (sourceContext && !MEMORY_SOURCE_CONTEXTS.has(sourceContext)) {
            errors.push({ error: `Invalid source_context: ${sourceContext}`, memory: mem });
            continue;
        }
        if (sceneTag && !MEMORY_SCENE_TAGS.has(sceneTag)) {
            errors.push({ error: `Invalid scene_tag: ${sceneTag}`, memory: mem });
            continue;
        }
        const timeBinding = mem.time_binding && typeof mem.time_binding === 'object' ? mem.time_binding : {};
        const isTimeBound = timeBinding.is_time_bound === true;
        const temporalLabel = isTimeBound ? String(timeBinding.label || '').trim() : '';
        const temporalScope = isTimeBound ? String(timeBinding.scope || '').trim() : '';
        if (temporalLabel && !MEMORY_TEMPORAL_BINDING_LABELS.has(temporalLabel)) {
            errors.push({ error: `Invalid temporal label: ${temporalLabel}`, memory: mem });
            continue;
        }
        if (temporalScope && !MEMORY_TEMPORAL_BINDING_SCOPES.has(temporalScope)) {
            errors.push({ error: `Invalid temporal scope: ${temporalScope}`, memory: mem });
            continue;
        }
        for (const id of sourceIds) {
            applyItems.push({
                id,
                memory_focus: mem.memory_focus,
                memory_tier: mem.memory_tier,
                importance: mem.importance,
                source_context: sourceContext,
                scene_tag: sceneTag,
                maintenance_status: 'classified',
                retention_action: action,
                retention_reason: (hasCjkText(reason) ? reason : '小模型未提供中文理由。').slice(0, 500),
                consolidation_key: String(mem.consolidation_key || '').slice(0, 240),
                consolidation_summary: summary.slice(0, 1000),
                temporal_label: temporalLabel,
                temporal_scope: temporalScope,
                temporal_anchor: isTimeBound ? String(timeBinding.time_anchor || '').trim().slice(0, 120) : '',
                temporal_confidence: isTimeBound ? clampNumber(timeBinding.confidence, 0.5, 0, 1) : 0,
                temporal_reason: isTimeBound
                    ? (hasCjkText(timeBinding.reason) ? String(timeBinding.reason || '') : '小模型未提供中文理由。').slice(0, 500)
                    : ''
            });
        }
    }

    for (const action of oldActions) {
        const id = Number(action?.id || 0);
        if (!idSet.has(id)) {
            errors.push({ error: 'old_memory_action id is not in this batch', item: action });
            continue;
        }
        const rawAction = String(action.action || '').trim();
        const mappedAction = rawAction === 'archive'
            ? 'archive_candidate'
            : (rawAction === 'skip_duplicate' ? 'superseded' : 'needs_review');
        applyItems.push({
            id,
            maintenance_status: rawAction === 'skip_duplicate' ? 'ignored' : 'needs_review',
            retention_action: mappedAction,
            retention_reason: (hasCjkText(action.reason) ? String(action.reason || '') : '小模型未提供中文理由。').slice(0, 500)
        });
    }

    const merged = new Map();
    for (const item of applyItems) {
        const id = Number(item.id || 0);
        merged.set(id, { ...(merged.get(id) || {}), ...item, id });
    }
    for (const id of idSet) {
        if (merged.has(id)) continue;
        merged.set(id, {
            id,
            maintenance_status: 'needs_review',
            retention_action: 'needs_review',
            retention_reason: '小模型未覆盖这条输入记忆，保留人工复核，避免静默漏迁移。'
        });
        errors.push({ id, error: 'Small model omitted this input memory; marked needs_review instead of leaving pending.' });
    }
    return {
        applyItems: Array.from(merged.values()),
        errors,
        newMemories,
        oldActions
    };
}

function normalizeTemporalBindingResult(parsed = {}, knownIds = []) {
    const idSet = new Set((knownIds || []).map(id => Number(id || 0)).filter(Boolean));
    const sourceLabels = [];
    const candidates = [];
    const needsReview = [];
    const notTimeBoundIds = [];
    const errors = [];
    for (const item of Array.isArray(parsed.source_labels) ? parsed.source_labels : []) {
        const id = Number(item?.id || 0);
        if (!idSet.has(id)) {
            errors.push({ error: 'source_label id is not in this batch', item });
            continue;
        }
        const sourceContext = String(item.source_context || '').trim();
        const sceneTag = String(item.scene_tag || '').trim();
        const reason = String(item.reason || '').trim();
        if (!MEMORY_SOURCE_CONTEXTS.has(sourceContext)) {
            errors.push({ id, error: `Invalid source_context: ${sourceContext}` });
            continue;
        }
        if (!MEMORY_SCENE_TAGS.has(sceneTag)) {
            errors.push({ id, error: `Invalid scene_tag: ${sceneTag}` });
            continue;
        }
        sourceLabels.push({
            id,
            source_context: sourceContext,
            scene_tag: sceneTag,
            source_app: String(item.source_app || '').trim().slice(0, 80),
            confidence: clampNumber(item.confidence, 0.5, 0, 1),
            reason: (hasCjkText(reason) ? reason : '小模型未提供中文理由。').slice(0, 500)
        });
    }
    const labelItems = Array.isArray(parsed.time_labels)
        ? parsed.time_labels
        : (Array.isArray(parsed.time_bound_candidates) ? parsed.time_bound_candidates : []);
    for (const item of labelItems) {
        const id = Number(item?.id || 0);
        if (!idSet.has(id)) {
            errors.push({ error: 'time_bound_candidate id is not in this batch', item });
            continue;
        }
        if (item?.is_time_bound === false) {
            notTimeBoundIds.push(id);
            continue;
        }
        const label = String(item.label || '').trim();
        const scope = String(item.scope || '').trim();
        const reason = String(item.reason || '').trim();
        if (!MEMORY_TEMPORAL_BINDING_LABELS.has(label)) {
            errors.push({ id, error: `Invalid temporal label: ${label}` });
            continue;
        }
        if (!MEMORY_TEMPORAL_BINDING_SCOPES.has(scope)) {
            errors.push({ id, error: `Invalid temporal scope: ${scope}` });
            continue;
        }
        candidates.push({
            id,
            label,
            scope,
            time_anchor: String(item.time_anchor || '').trim().slice(0, 120),
            confidence: clampNumber(item.confidence, 0.5, 0, 1),
            reason: (hasCjkText(reason) ? reason : '小模型未提供中文理由。').slice(0, 500)
        });
    }
    for (const item of Array.isArray(parsed.needs_review) ? parsed.needs_review : []) {
        const id = Number(item?.id || 0);
        if (!idSet.has(id)) {
            errors.push({ error: 'needs_review id is not in this batch', item });
            continue;
        }
        const reason = String(item.reason || '').trim();
        needsReview.push({
            id,
            reason: (hasCjkText(reason) ? reason : '小模型未提供中文理由。').slice(0, 500)
        });
    }
    for (const idValue of Array.isArray(parsed.not_time_bound_ids) ? parsed.not_time_bound_ids : []) {
        const id = Number(idValue || 0);
        if (idSet.has(id)) notTimeBoundIds.push(id);
        else errors.push({ error: 'not_time_bound id is not in this batch', id: idValue });
    }
    return { sourceLabels, candidates, needsReview, notTimeBoundIds: Array.from(new Set(notTimeBoundIds)), errors };
}

function buildTemporalBindingApplyItems(normalized = {}) {
    const merged = new Map();
    const ensureItem = (id) => {
        const safeId = Number(id || 0);
        if (!safeId) return null;
        if (!merged.has(safeId)) merged.set(safeId, { id: safeId });
        return merged.get(safeId);
    };
    for (const item of normalized.sourceLabels || []) {
        const target = ensureItem(item.id);
        if (!target) continue;
        target.source_context = item.source_context;
        target.scene_tag = item.scene_tag;
        target.source_app = item.source_app || '';
        target.retention_reason = item.reason || target.retention_reason || '补充来源场景标签。';
    }
    for (const item of normalized.candidates || []) {
        const target = ensureItem(item.id);
        if (!target) continue;
        target.temporal_label = item.label;
        target.temporal_scope = item.scope;
        target.temporal_anchor = item.time_anchor || '';
        target.temporal_confidence = item.confidence;
        target.temporal_reason = item.reason || '';
    }
    for (const id of normalized.notTimeBoundIds || []) {
        const target = ensureItem(id);
        if (!target) continue;
        target.temporal_label = '';
        target.temporal_scope = '';
        target.temporal_anchor = '';
        target.temporal_confidence = 0;
        target.temporal_reason = target.temporal_reason || '小模型判断这条记忆不依赖时间语境。';
    }
    for (const item of normalized.needsReview || []) {
        const target = ensureItem(item.id);
        if (!target) continue;
        target.maintenance_status = 'needs_review';
        target.retention_action = 'needs_review';
        target.retention_reason = item.reason || '来源或时间标签需要人工复核。';
    }
    return Array.from(merged.values());
}

function expandTemporalBindingApplyItemsForFormalBatch(applyItems = [], batchItems = []) {
    const sourceIdsByRepresentative = new Map();
    for (const item of Array.isArray(batchItems) ? batchItems : []) {
        const representativeId = Number(item?.id || 0);
        if (!representativeId) continue;
        const sourceIds = Array.from(new Set((Array.isArray(item.source_ids) ? item.source_ids : [representativeId])
            .map(id => Number(id || 0))
            .filter(id => id > 0)));
        sourceIdsByRepresentative.set(representativeId, sourceIds.length ? sourceIds : [representativeId]);
    }
    const merged = new Map();
    for (const item of Array.isArray(applyItems) ? applyItems : []) {
        const representativeId = Number(item?.id || 0);
        if (!representativeId) continue;
        const sourceIds = sourceIdsByRepresentative.get(representativeId) || [representativeId];
        for (const sourceId of sourceIds) {
            merged.set(sourceId, { ...item, id: sourceId });
        }
    }
    return Array.from(merged.values());
}

function applyMemoryMaintenanceItems(rawDb, characterId, items = [], source = 'small-model', options = {}) {
    const now = Date.now();
    const inputRows = Array.isArray(items) ? items : [];
    const replaceSourceIds = Array.from(new Set((Array.isArray(options.replaceSourceIds) ? options.replaceSourceIds : [])
        .map(id => Number(id || 0))
        .filter(id => id > 0)))
        .slice(0, 200);
    const affectedIds = Array.from(new Set([
        ...replaceSourceIds,
        ...inputRows.map(item => Number(item?.id || 0)).filter(id => id > 0)
    ]));
    let previousRows = [];
    if (affectedIds.length > 0) {
        const placeholders = affectedIds.map(() => '?').join(', ');
        previousRows = rawDb.prepare(`
            SELECT *
            FROM memories
            WHERE character_id = ?
              AND id IN (${placeholders})
        `).all(characterId, ...affectedIds);
    }
    const updateColumns = [
        'memory_focus', 'memory_tier', 'importance', 'summary', 'content', 'event',
        'source_context', 'scene_tag', 'source_app',
        'maintenance_status', 'classification_source', 'classified_at',
        'retention_score', 'retention_action', 'retention_reason', 'retention_checked_at',
        'consolidation_key', 'consolidation_summary', 'consolidated_into_memory_id', 'archive_reason',
        'temporal_label', 'temporal_scope', 'temporal_anchor', 'temporal_confidence', 'temporal_reason', 'temporal_checked_at',
        'forgetting_grace_started_at', 'forgetting_grace_expires_at',
        'updated_at'
    ];
    const stmt = rawDb.prepare(`UPDATE memories SET ${updateColumns.map(col => `${col} = ?`).join(', ')} WHERE id = ? AND character_id = ?`);
    let updated = 0;
    let cleared = 0;
    const errors = [];
    const tx = rawDb.transaction((rows) => {
        if (replaceSourceIds.length > 0) {
            const placeholders = replaceSourceIds.map(() => '?').join(', ');
            const info = rawDb.prepare(`
                UPDATE memories
                SET consolidation_key = '',
                    consolidation_summary = '',
                    consolidated_into_memory_id = 0,
                    temporal_label = '',
                    temporal_scope = '',
                    temporal_anchor = '',
                    temporal_confidence = 0,
                    temporal_reason = '',
                    temporal_checked_at = 0,
                    updated_at = ?
                WHERE character_id = ?
                  AND id IN (${placeholders})
            `).run(now, characterId, ...replaceSourceIds);
            cleared = Number(info.changes || 0);
        }
        for (let idx = 0; idx < rows.length; idx++) {
            const item = rows[idx] || {};
            const id = Number(item.id || 0);
            if (!id) {
                errors.push({ index: idx, error: 'Missing memory id.' });
                continue;
            }
            const existing = rawDb.prepare('SELECT * FROM memories WHERE id = ? AND character_id = ?').get(id, characterId);
            if (!existing) {
                errors.push({ id, error: 'Memory not found for this character.' });
                continue;
            }
            const focus = String(item.memory_focus || existing.memory_focus || 'general').trim();
            const tier = String(item.memory_tier || existing.memory_tier || 'ambient').trim();
            const status = String(item.maintenance_status || 'classified').trim();
            const action = String(item.retention_action || existing.retention_action || computeMemoryRetention(existing, now).suggested_action || 'keep').trim();
            if (!MEMORY_MAINTENANCE_FOCUS.has(focus)) {
                errors.push({ id, error: `Invalid memory_focus: ${focus}` });
                continue;
            }
            if (!MEMORY_MAINTENANCE_TIERS.has(tier)) {
                errors.push({ id, error: `Invalid memory_tier: ${tier}` });
                continue;
            }
            if (!MEMORY_MAINTENANCE_STATUS.has(status)) {
                errors.push({ id, error: `Invalid maintenance_status: ${status}` });
                continue;
            }
            if (action && !MEMORY_MAINTENANCE_ACTIONS.has(action)) {
                errors.push({ id, error: `Invalid retention_action: ${action}` });
                continue;
            }
            const sourceContext = String(item.source_context || existing.source_context || inferMemorySourceContext(existing)).trim();
            const sceneTag = String(item.scene_tag || existing.scene_tag || inferMemorySceneTag(existing, sourceContext)).trim();
            if (sourceContext && !MEMORY_SOURCE_CONTEXTS.has(sourceContext)) {
                errors.push({ id, error: `Invalid source_context: ${sourceContext}` });
                continue;
            }
            if (sceneTag && !MEMORY_SCENE_TAGS.has(sceneTag)) {
                errors.push({ id, error: `Invalid scene_tag: ${sceneTag}` });
                continue;
            }
            const hasTemporalLabel = Object.prototype.hasOwnProperty.call(item, 'temporal_label');
            const hasTemporalScope = Object.prototype.hasOwnProperty.call(item, 'temporal_scope');
            const temporalLabel = String(hasTemporalLabel ? item.temporal_label : (existing.temporal_label || '')).trim();
            const temporalScope = String(hasTemporalScope ? item.temporal_scope : (existing.temporal_scope || '')).trim();
            if (temporalLabel && !MEMORY_TEMPORAL_BINDING_LABELS.has(temporalLabel)) {
                errors.push({ id, error: `Invalid temporal_label: ${temporalLabel}` });
                continue;
            }
            if (temporalScope && !MEMORY_TEMPORAL_BINDING_SCOPES.has(temporalScope)) {
                errors.push({ id, error: `Invalid temporal_scope: ${temporalScope}` });
                continue;
            }
            const retention = computeMemoryRetention({ ...existing, memory_focus: focus, memory_tier: tier, importance: item.importance ?? existing.importance }, now);
            const retentionScore = Number.isFinite(Number(item.retention_score)) ? clampNumber(item.retention_score, retention.retention_score, 0, 1) : retention.retention_score;
            const existingGraceStartedAt = Number(existing.forgetting_grace_started_at || 0);
            const existingGraceExpiresAt = Number(existing.forgetting_grace_expires_at || 0);
            const startsForgettingGrace = (action || retention.suggested_action) === 'archive_candidate';
            const nextGraceStartedAt = startsForgettingGrace
                ? (existingGraceStartedAt > 0 ? existingGraceStartedAt : now)
                : 0;
            const nextGraceExpiresAt = startsForgettingGrace
                ? (existingGraceExpiresAt > nextGraceStartedAt ? existingGraceExpiresAt : nextGraceStartedAt + MEMORY_FORGETTING_GRACE_MS)
                : 0;
            const valuesByColumn = {
                memory_focus: focus,
                memory_tier: tier,
                importance: clampNumber(item.importance ?? existing.importance, Number(existing.importance || 5), 1, 10),
                summary: firstImportString(item.summary, item.normalized_summary, existing.summary, existing.event),
                content: firstImportString(item.content, item.normalized_content, existing.content, existing.event),
                event: firstImportString(item.event, item.summary, existing.event, existing.summary),
                source_context: sourceContext,
                scene_tag: sceneTag,
                source_app: firstImportString(item.source_app, existing.source_app).slice(0, 80),
                maintenance_status: status,
                classification_source: String(source || 'small-model').slice(0, 80),
                classified_at: now,
                retention_score: retentionScore,
                retention_action: action || retention.suggested_action,
                retention_reason: firstImportString(item.retention_reason, item.reason, retention.reason).slice(0, 500),
                retention_checked_at: now,
                consolidation_key: firstImportString(item.consolidation_key, item.merge_key, existing.consolidation_key).slice(0, 160),
                consolidation_summary: firstImportString(item.consolidation_summary, item.merge_summary, existing.consolidation_summary).slice(0, 2000),
                consolidated_into_memory_id: Math.max(0, Number(item.consolidated_into_memory_id || existing.consolidated_into_memory_id || 0) || 0),
                archive_reason: firstImportString(item.archive_reason, existing.archive_reason).slice(0, 500),
                temporal_label: temporalLabel,
                temporal_scope: temporalScope,
                temporal_anchor: firstImportString(item.temporal_anchor, existing.temporal_anchor).slice(0, 120),
                temporal_confidence: Number.isFinite(Number(item.temporal_confidence)) ? clampNumber(item.temporal_confidence, 0, 0, 1) : Number(existing.temporal_confidence || 0),
                temporal_reason: firstImportString(item.temporal_reason, existing.temporal_reason).slice(0, 500),
                temporal_checked_at: (temporalLabel || temporalScope || item.temporal_anchor || item.temporal_reason) ? now : Number(existing.temporal_checked_at || 0),
                forgetting_grace_started_at: nextGraceStartedAt,
                forgetting_grace_expires_at: nextGraceExpiresAt,
                updated_at: now
            };
            const info = stmt.run(...updateColumns.map(col => valuesByColumn[col]), id, characterId);
            updated += Number(info.changes || 0);
        }
    });
    tx(inputRows);
    const result = { updated, cleared, replace_source_ids: replaceSourceIds, affected_ids: affectedIds, errors };
    Object.defineProperty(result, 'previousRows', {
        value: previousRows,
        enumerable: false
    });
    return result;
}

async function refreshMaintenanceMemoryIndex(memory, characterId, applyResult = {}) {
    const affectedIds = Array.from(new Set((Array.isArray(applyResult.affected_ids) ? applyResult.affected_ids : [])
        .map(id => Number(id || 0))
        .filter(id => id > 0)));
    const previousRows = Array.isArray(applyResult.previousRows) ? applyResult.previousRows : [];
    if (!memory || (affectedIds.length === 0 && previousRows.length === 0)) {
        return null;
    }
    if (typeof memory.refreshMemoryIndexEntries === 'function') {
        return await memory.refreshMemoryIndexEntries(characterId, affectedIds, { previousRows });
    }
    if (typeof memory.rebuildIndex === 'function') {
        return await memory.rebuildIndex(characterId);
    }
    return null;
}

function getMemoryMaintenanceStats(rawDb, characterId) {
    const row = rawDb.prepare(`
        SELECT
            COUNT(*) AS total,
            SUM(CASE WHEN COALESCE(is_archived, 0) = 0 THEN 1 ELSE 0 END) AS active,
            SUM(CASE WHEN COALESCE(is_archived, 0) = 1 THEN 1 ELSE 0 END) AS archived,
            SUM(CASE WHEN COALESCE(maintenance_status, '') = '' OR maintenance_status = 'pending' THEN 1 ELSE 0 END) AS pending,
            SUM(CASE WHEN maintenance_status = 'classified' THEN 1 ELSE 0 END) AS classified,
            SUM(CASE WHEN maintenance_status = 'needs_review' THEN 1 ELSE 0 END) AS needs_review,
            SUM(CASE WHEN retention_action = 'archive_candidate' THEN 1 ELSE 0 END) AS archive_candidates,
            SUM(CASE WHEN retention_action = 'merge_candidate' THEN 1 ELSE 0 END) AS merge_candidates
        FROM memories
        WHERE character_id = ?
    `).get(characterId) || {};
    const byFocus = rawDb.prepare(`
        SELECT COALESCE(memory_focus, 'general') AS memory_focus, COUNT(*) AS count
        FROM memories
        WHERE character_id = ? AND COALESCE(is_archived, 0) = 0
        GROUP BY COALESCE(memory_focus, 'general')
        ORDER BY count DESC
    `).all(characterId);
    const byTier = rawDb.prepare(`
        SELECT COALESCE(memory_tier, 'ambient') AS memory_tier, COUNT(*) AS count
        FROM memories
        WHERE character_id = ? AND COALESCE(is_archived, 0) = 0
        GROUP BY COALESCE(memory_tier, 'ambient')
        ORDER BY count DESC
    `).all(characterId);
    const externalPending = getExternalImportPendingCountForCharacter(rawDb, characterId);
    const legacyPending = Number(row.pending || 0);
    return {
        total: Number(row.total || 0) + externalPending,
        active: Number(row.active || 0),
        archived: Number(row.archived || 0),
        pending: legacyPending + externalPending,
        legacy_pending: legacyPending,
        external_pending: externalPending,
        classified: Number(row.classified || 0),
        needs_review: Number(row.needs_review || 0),
        archive_candidates: Number(row.archive_candidates || 0),
        merge_candidates: Number(row.merge_candidates || 0),
        by_focus: byFocus,
        by_tier: byTier
    };
}

function buildMemoryMaintenanceAttemptError(error, attemptNumber) {
    const payload = error?.payload || {};
    return {
        attempt: attemptNumber,
        reroll: Math.max(0, attemptNumber - 1),
        kind: 'error',
        error: error?.message || 'Unknown small model error.',
        model: payload.model || null,
        batch: payload.batch
            ? {
                item_count: payload.batch.item_count || 0,
                ids: payload.batch.ids || [],
                batch_index: payload.batch.batch_index || 0,
                remaining_pending: payload.batch.remaining_pending || 0
            }
            : null,
        raw_response_preview: payload.raw_response ? clipMemoryDisplayText(payload.raw_response, 1600) : ''
    };
}

function isNonRetryableMemoryMaintenanceError(error) {
    const text = [
        error?.message,
        error?.payload?.raw_response,
        error?.payload?.error,
        error?.response?.status,
        error?.status
    ].filter(Boolean).join('\n');
    return /(401|403|unauthorized|forbidden|invalid\s*(api\s*)?key|invalid_key|permission|auth)/i.test(text);
}

function buildMemoryMaintenanceNoProgressAttempt(result, statsAfterBatch, attemptNumber) {
    return {
        attempt: attemptNumber,
        reroll: Math.max(0, attemptNumber - 1),
        kind: 'no_progress',
        error: 'No memory records were updated; rerolling this batch.',
        model: result?.model || null,
        batch: {
            item_count: result?.batch?.item_count || 0,
            ids: result?.batch?.ids || [],
            batch_index: result?.batch?.batch_index || 0,
            remaining_pending_before_batch: result?.batch?.remaining_pending || 0,
            remaining_pending_after_batch: statsAfterBatch?.pending || 0
        },
        normalized_errors: (result?.normalized?.errors || []).slice(0, 6),
        raw_response_preview: result?.raw_response ? clipMemoryDisplayText(result.raw_response, 1600) : ''
    };
}

function appendExternalImportProcessingEntries(rawDb, entries = []) {
    const grouped = new Map();
    for (const entry of entries) {
        const importId = Number(entry?.import_id || 0);
        if (!importId) continue;
        if (!grouped.has(importId)) grouped.set(importId, []);
        grouped.get(importId).push(entry);
    }
    for (const [importId, groupEntries] of grouped.entries()) {
        const row = rawDb.prepare('SELECT id, memory_ids_json FROM external_memory_imports WHERE id = ?').get(importId);
        if (!row) continue;
        const current = normalizeExternalProcessingState(row.memory_ids_json);
        const byKey = new Map();
        for (const item of current) {
            const key = item.key || makeExternalProcessingKey(importId, item.candidate_id, item.character_id);
            if (key) byKey.set(key, { ...item, key });
        }
        for (const entry of groupEntries) {
            const key = entry.key || makeExternalProcessingKey(importId, entry.candidate_id, entry.character_id);
            if (!key) continue;
            byKey.set(key, {
                ...entry,
                key,
                processed_at: entry.processed_at || Date.now()
            });
        }
        rawDb.prepare('UPDATE external_memory_imports SET memory_ids_json = ? WHERE id = ?')
            .run(JSON.stringify(Array.from(byKey.values())), importId);
    }
}

async function applyExternalImportMigrationItems(rawDb, memory, characterId, normalized = {}, batch = {}, source = 'external-import-auto-migration') {
    const now = Date.now();
    const inputRows = Array.isArray(batch.items) ? batch.items : [];
    const itemById = new Map(inputRows.map(item => [Number(item.id || 0), item]));
    const errors = [];
    const affectedIds = [];
    const processingEntries = [];
    const processedVirtualIds = new Set();
    const updateFormalStmt = rawDb.prepare(`
        UPDATE memories
        SET maintenance_status = 'classified',
            classification_source = ?,
            classified_at = ?,
            retention_action = ?,
            retention_reason = ?,
            retention_checked_at = ?,
            temporal_label = ?,
            temporal_scope = ?,
            temporal_anchor = ?,
            temporal_confidence = ?,
            temporal_reason = ?,
            temporal_checked_at = ?,
            updated_at = ?
        WHERE id = ? AND character_id = ?
    `);

    const newMemories = Array.isArray(normalized.newMemories) ? normalized.newMemories : [];
    for (const mem of newMemories) {
        const sourceIds = Array.from(new Set((Array.isArray(mem?.source_ids) ? mem.source_ids : [])
            .map(id => Number(id || 0))
            .filter(id => itemById.has(id))));
        if (!sourceIds.length) continue;
        const sourceItems = sourceIds.map(id => itemById.get(id)).filter(Boolean);
        const summary = String(mem.summary || '').trim();
        if (!summary) continue;
        const sourceContext = MEMORY_SOURCE_CONTEXTS.has(String(mem.source_context || '').trim()) ? String(mem.source_context).trim() : 'external_app';
        const firstExternal = sourceItems[0]?.external_import || {};
        const sceneTag = MEMORY_SCENE_TAGS.has(String(mem.scene_tag || '').trim())
            ? String(mem.scene_tag).trim()
            : (firstExternal.scene_tag || 'external_app');
        const sourceApp = firstExternal.source_app || 'External';
        const startedValues = sourceItems.map(item => Number(item.signals?.source_started_at || 0)).filter(Boolean);
        const endedValues = sourceItems.map(item => Number(item.signals?.source_ended_at || item.signals?.source_started_at || 0)).filter(Boolean);
        const sourceMessageIds = Array.from(new Set(sourceItems.flatMap(item => item.external_import?.source_message_ids_json || [])));
        const sourceTimeText = firstImportString(...sourceItems.map(item => item.signals?.source_time_text).filter(Boolean));
        const timeBinding = mem.time_binding && typeof mem.time_binding === 'object' ? mem.time_binding : {};
        const isTimeBound = timeBinding.is_time_bound === true;
        const temporalLabel = isTimeBound && MEMORY_TEMPORAL_BINDING_LABELS.has(String(timeBinding.label || '').trim()) ? String(timeBinding.label).trim() : '';
        const temporalScope = isTimeBound && MEMORY_TEMPORAL_BINDING_SCOPES.has(String(timeBinding.scope || '').trim()) ? String(timeBinding.scope).trim() : '';
        const sourceKey = sourceItems.map(item => item.external_import?.key || item.id).join('_');
        const consolidationKey = String(mem.consolidation_key || sourceKey || summary)
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '_')
            .replace(/^_+|_+$/g, '')
            .slice(0, 120) || `external_import_${now}`;
        const dedupeKey = `external-import-formal:${characterId}:${sourceKey}:${consolidationKey}`;
        try {
            const memoryId = await memory.saveExtractedMemory(characterId, {
                memory_type: 'formal_memory',
                summary,
                content: summary,
                event: summary,
                importance: Math.round(clampImportNumber(mem.importance, sourceItems[0]?.current?.importance || 5, 1, 10)),
                memory_focus: MEMORY_MAINTENANCE_FOCUS.has(mem.memory_focus) ? mem.memory_focus : 'general',
                memory_tier: MEMORY_MAINTENANCE_TIERS.has(mem.memory_tier) ? mem.memory_tier : 'ambient',
                consolidation_key: consolidationKey,
                consolidation_summary: summary,
                source_context: sourceContext,
                scene_tag: sceneTag,
                source_app: sourceApp,
                source_message_ids_json: sourceMessageIds,
                source_started_at: startedValues.length ? Math.min(...startedValues) : 0,
                source_ended_at: endedValues.length ? Math.max(...endedValues) : 0,
                source_time_text: sourceTimeText || '',
                source_message_count: sourceMessageIds.length || sourceItems.reduce((sum, item) => sum + Number(item.signals?.source_message_count || 0), 0),
                dedupe_key: dedupeKey
            }, null);
            if (memoryId) {
                affectedIds.push(Number(memoryId));
                const retentionAction = String(mem.action || '').trim() === 'merge_create' ? 'merge_candidate' : 'keep';
                const reason = hasCjkText(mem.reason) ? String(mem.reason || '') : '外部导入自动总结生成。';
                updateFormalStmt.run(
                    source,
                    now,
                    retentionAction,
                    reason.slice(0, 500),
                    now,
                    temporalLabel,
                    temporalScope,
                    temporalLabel ? String(timeBinding.time_anchor || '').trim().slice(0, 120) : '',
                    temporalLabel ? clampNumber(timeBinding.confidence, 0.5, 0, 1) : 0,
                    temporalLabel ? (hasCjkText(timeBinding.reason) ? String(timeBinding.reason || '').slice(0, 500) : '小模型未提供中文理由。') : '',
                    temporalLabel ? now : 0,
                    now,
                    memoryId,
                    characterId
                );
                for (const item of sourceItems) {
                    processedVirtualIds.add(Number(item.id || 0));
                    processingEntries.push({
                        import_id: item.external_import?.import_id,
                        candidate_id: item.external_import?.candidate_id,
                        character_id: String(characterId),
                        key: item.external_import?.key,
                        action: 'created',
                        memory_id: Number(memoryId)
                    });
                }
            }
        } catch (e) {
            errors.push({ source_ids: sourceIds, error: e.message || 'Failed to save external formal memory.' });
        }
    }

    for (const action of Array.isArray(normalized.oldActions) ? normalized.oldActions : []) {
        const id = Number(action?.id || 0);
        const item = itemById.get(id);
        if (!item || processedVirtualIds.has(id)) continue;
        processedVirtualIds.add(id);
        processingEntries.push({
            import_id: item.external_import?.import_id,
            candidate_id: item.external_import?.candidate_id,
            character_id: String(characterId),
            key: item.external_import?.key,
            action: String(action.action || 'needs_review').trim() || 'needs_review',
            reason: String(action.reason || '').slice(0, 500)
        });
    }

    for (const applyItem of Array.isArray(normalized.applyItems) ? normalized.applyItems : []) {
        const id = Number(applyItem?.id || 0);
        const item = itemById.get(id);
        if (!item || processedVirtualIds.has(id)) continue;
        processedVirtualIds.add(id);
        processingEntries.push({
            import_id: item.external_import?.import_id,
            candidate_id: item.external_import?.candidate_id,
            character_id: String(characterId),
            key: item.external_import?.key,
            action: applyItem.maintenance_status || 'needs_review',
            reason: String(applyItem.retention_reason || '').slice(0, 500)
        });
    }

    appendExternalImportProcessingEntries(rawDb, processingEntries);
    return {
        updated: processingEntries.length,
        inserted: affectedIds.length,
        affected_ids: affectedIds,
        errors,
        external_processed: processingEntries.length
    };
}

async function runMemoryMaintenanceBatch(rawDb, memory, character, settings, options = {}) {
    const characterId = character.id;
    const batchOptions = normalizeMemoryMaintenanceBatchOptions(options, {
        limitFallback: settings.batch_size || 30
    });
    const batch = getMemoryMaintenanceBatch(rawDb, characterId, {
        limit: batchOptions.limit,
        offset: batchOptions.offset,
        after_id: batchOptions.after_id,
        status: options.status || 'pending',
        include_archived: parseBooleanFlag(options.include_archived)
    });
    if (!batch.items.length) {
        return {
            success: true,
            empty: true,
            character: { id: character.id, name: character.name },
            message: 'No pending memory cards in this batch.',
            batch
        };
    }
    const prompt = buildMemoryMigrationPrompt(character, batch, settings);
    const response = await callLLM({
        endpoint: settings.api_endpoint,
        key: settings.api_key,
        model: settings.model_name,
        messages: [
            { role: 'system', content: prompt.system_prompt },
            { role: 'user', content: prompt.user_prompt }
        ],
        maxTokens: Math.max(1000, Math.min(20000, Number(settings.max_output_tokens || 8000) || 8000)),
        temperature: 0.1,
        returnUsage: true,
        responseFormat: { type: 'json_object' }
    });
    const rawText = typeof response === 'string' ? response : response.content;
    let parsed;
    try {
        parsed = extractJsonObjectFromText(rawText);
    } catch (parseError) {
        const error = new Error(parseError.message);
        error.status = 422;
        error.payload = {
            success: false,
            error: parseError.message,
            character: { id: character.id, name: character.name },
            prompt,
            batch: {
                item_count: batch.items.length,
                ids: batch.items.map(item => item.id),
                next_after_id: batch.next_after_id,
                remaining_pending: batch.remaining_pending,
                offset: batch.offset,
                batch_index: batch.batch_index,
                total_batches: batch.total_batches
            },
            model: { name: settings.model_name, usage: response?.usage || null, finishReason: response?.finishReason || '' },
            raw_response: rawText
        };
        throw error;
    }
    const normalized = normalizeSmallModelMigrationResult(parsed, batch.items.map(item => item.id));
    let applyResult = { updated: 0, errors: [] };
    let indexRefresh = null;
    let indexRefreshWarning = '';
    if (!parseBooleanFlag(options.dry_run)) {
        if (batch.source_kind === 'external_import') {
            applyResult = await applyExternalImportMigrationItems(
                rawDb,
                memory,
                characterId,
                normalized,
                batch,
                options.source || 'external-import-auto-migration'
            );
        } else {
            applyResult = applyMemoryMaintenanceItems(
                rawDb,
                characterId,
                normalized.applyItems,
                options.source || 'small-model-migration',
                { replaceSourceIds: normalized.applyItems.length > 0 ? batch.items.map(item => item.id) : [] }
            );
            try {
                indexRefresh = await refreshMaintenanceMemoryIndex(memory, characterId, applyResult);
            } catch (e) {
                indexRefreshWarning = e.message || 'Memory index refresh failed.';
                console.error(`[Memory Maintenance] Failed to refresh memory index for ${characterId}:`, indexRefreshWarning);
            }
        }
    }
    return {
        success: true,
        empty: false,
        character: { id: character.id, name: character.name },
        dry_run: parseBooleanFlag(options.dry_run),
        prompt,
        batch: {
            source_kind: batch.source_kind || 'legacy_memory',
            item_count: batch.items.length,
            ids: batch.items.map(item => item.id),
            next_after_id: batch.next_after_id,
            remaining_pending: batch.remaining_pending,
            offset: batch.offset,
            batch_index: batch.batch_index,
            total_matching: batch.total_matching,
            total_batches: batch.total_batches
        },
        model: { name: settings.model_name, usage: response?.usage || null, finishReason: response?.finishReason || '' },
        raw_response: rawText,
        parsed,
        normalized: {
            apply_items: normalized.applyItems,
            errors: normalized.errors,
            new_memory_count: normalized.newMemories.length,
            old_action_count: normalized.oldActions.length
        },
        apply: applyResult,
        index_refresh: indexRefresh,
        index_refresh_warning: indexRefreshWarning,
        stats: getMemoryMaintenanceStats(rawDb, characterId)
    };
}

async function runMemoryTemporalBindingBatch(rawDb, character, settings, options = {}) {
    const characterId = character.id;
    const batchOptions = normalizeMemoryMaintenanceBatchOptions(options, {
        limitFallback: settings.batch_size || 40
    });
    const batch = getMemoryTemporalBindingBatch(rawDb, characterId, {
        limit: batchOptions.limit,
        offset: batchOptions.offset,
        source: options.source || 'new',
        include_archived: parseBooleanFlag(options.include_archived)
    });
    if (!batch.items.length) {
        return {
            success: true,
            empty: true,
            character: { id: character.id, name: character.name },
            message: 'No new-library memories in this supplemental batch.',
            batch
        };
    }
    const prompt = buildMemoryTemporalBindingPrompt(character, batch, settings);
    const response = await callLLM({
        endpoint: settings.api_endpoint,
        key: settings.api_key,
        model: settings.model_name,
        messages: [
            { role: 'system', content: prompt.system_prompt },
            { role: 'user', content: prompt.user_prompt }
        ],
        maxTokens: Math.max(1000, Math.min(20000, Number(settings.max_output_tokens || 8000) || 8000)),
        temperature: 0.1,
        returnUsage: true,
        responseFormat: { type: 'json_object' }
    });
    const rawText = typeof response === 'string' ? response : response.content;
    let parsed;
    try {
        parsed = extractJsonObjectFromText(rawText);
    } catch (parseError) {
        const error = new Error(parseError.message);
        error.status = 422;
        error.payload = {
            success: false,
            error: parseError.message,
            character: { id: character.id, name: character.name },
            prompt,
            batch: {
                item_count: batch.items.length,
                ids: batch.items.map(item => item.id),
                offset: batch.offset,
                batch_index: batch.batch_index,
                total_batches: batch.total_batches
            },
            model: { name: settings.model_name, usage: response?.usage || null, finishReason: response?.finishReason || '' },
            raw_response: rawText
        };
        throw error;
    }
    const normalized = normalizeTemporalBindingResult(parsed, batch.items.map(item => item.id));
    const applyItems = buildTemporalBindingApplyItems(normalized);
    const expandedApplyItems = expandTemporalBindingApplyItemsForFormalBatch(applyItems, batch.items);
    let applyResult = { updated: 0, errors: [] };
    if (!parseBooleanFlag(options.dry_run)) {
        applyResult = applyMemoryMaintenanceItems(
            rawDb,
            characterId,
            expandedApplyItems,
            options.source_name || 'small-model-temporal-binding'
        );
    }
    return {
        success: true,
        empty: false,
        character: { id: character.id, name: character.name },
        dry_run: parseBooleanFlag(options.dry_run),
        prompt,
        batch: {
            item_count: batch.items.length,
            ids: batch.items.map(item => item.id),
            offset: batch.offset,
            batch_index: batch.batch_index,
            total_matching: batch.total_matching,
            total_batches: batch.total_batches
        },
        model: { name: settings.model_name, usage: response?.usage || null, finishReason: response?.finishReason || '' },
        raw_response: rawText,
        parsed,
        normalized: {
            apply_items: applyItems,
            expanded_apply_count: expandedApplyItems.length,
            errors: normalized.errors,
            source_label_count: normalized.sourceLabels.length,
            time_label_count: normalized.candidates.length,
            not_time_bound_count: normalized.notTimeBoundIds.length,
            needs_review_count: normalized.needsReview.length
        },
        apply: applyResult,
        stats: getMemoryMaintenanceStats(rawDb, characterId)
    };
}

function incrementCount(map, key, amount = 1) {
    const safeKey = String(key || 'unknown');
    map[safeKey] = Number(map[safeKey] || 0) + Number(amount || 0);
}

function getMemoryTemporalSignalSql() {
    const haystack = [
        "COALESCE(consolidation_summary, '')",
        "COALESCE(summary, '')",
        "COALESCE(content, '')",
        "COALESCE(event, '')",
        "COALESCE(time, '')",
        "COALESCE(source_time_text, '')"
    ].join(" || ' ' || ");
    return `(${MEMORY_TEMPORAL_SIGNAL_TERMS.map(() => `${haystack} LIKE ?`).join(' OR ')})`;
}

function getMemoryTemporalSignalParams() {
    return MEMORY_TEMPORAL_SIGNAL_TERMS.map(term => `%${term}%`);
}

function normalizeMemoryTimelineFilter(value = 'strong_time_bound') {
    const normalized = String(value || 'strong_time_bound').trim();
    return MEMORY_TIMELINE_FILTERS.has(normalized) ? normalized : 'strong_time_bound';
}

function getMemoryStrongTimelineSql() {
    const labels = Array.from(MEMORY_TEMPORAL_BINDING_LABELS);
    return `(
        COALESCE(NULLIF(temporal_label, ''), '') IN (${labels.map(() => '?').join(', ')})
        AND COALESCE(temporal_confidence, 0) >= ?
    )`;
}

function getMemoryStrongTimelineParams() {
    return [...Array.from(MEMORY_TEMPORAL_BINDING_LABELS), MEMORY_TIMELINE_CONFIDENCE_THRESHOLD];
}

function getMemoryTimelineFilterClause(filter = 'strong_time_bound') {
    const normalized = normalizeMemoryTimelineFilter(filter);
    if (normalized === 'all') {
        return {
            filter: normalized,
            where: '1 = 1',
            params: [],
            description: '调试模式：展示所有有时间位置的记忆，不代表正式时间线。'
        };
    }
    if (normalized === 'temporal_signal') {
        return {
            filter: normalized,
            where: getMemoryTemporalSignalSql(),
            params: getMemoryTemporalSignalParams(),
            description: '预筛模式：按关键词找疑似时间相关记忆，供二轮小模型标注使用。'
        };
    }
    return {
        filter: normalized,
        where: getMemoryStrongTimelineSql(),
        params: getMemoryStrongTimelineParams(),
        description: `正式时间线：仅展示已被小模型标为时间强绑定、且置信度 >= ${MEMORY_TIMELINE_CONFIDENCE_THRESHOLD} 的记忆。`
    };
}

function getFormalMemoryGroupSql() {
    return "COALESCE(character_id, '') || '::' || COALESCE(NULLIF(consolidation_key, ''), '') || '::' || LOWER(TRIM(COALESCE(consolidation_summary, '')))";
}

function countFormalMemoryGroups(rawDb, where, params = []) {
    const formalGroupExpr = getFormalMemoryGroupSql();
    return Number(rawDb.prepare(`
        SELECT COUNT(*) AS c
        FROM (
            SELECT 1
            FROM memories
            WHERE ${where.join(' AND ')}
            GROUP BY ${formalGroupExpr}
        ) formal_groups
    `).get(...params)?.c || 0);
}

function normalizeMemoryTemporalBindingSource(value = 'new') {
    const normalized = String(value || 'new').trim().toLowerCase();
    if (normalized === 'temporal_signal' || normalized === 'new_temporal_signal') return 'new_temporal_signal';
    return 'new';
}

const MEMORY_LIBRARY_FOCUS_DEFINITIONS = [
    {
        key: 'user_profile',
        label: '用户画像分类',
        description: '长期稳定的用户身份、偏好、背景、边界、长期目标。适合长期保留，通常只在冲突或更新时合并。'
    },
    {
        key: 'relationship',
        label: '关系记忆分类',
        description: '用户与角色之间的承诺、冲突、和解、告白、亲密度变化和相处边界。决定角色如何看待这段关系。'
    },
    {
        key: 'user_current_arc',
        label: '当前阶段分类',
        description: '用户近期正在经历的事情、短期计划、压力、情绪和当前任务。时效性强，会更早进入遗忘曲线。'
    },
    {
        key: 'general',
        label: '普通事件分类',
        description: '不属于画像、关系、当前阶段的普通事实和背景事件。重要性低且长期未调用时会优先降级或归档。'
    }
];

function clampMemoryLibraryLimit(value, fallback = 28, max = 120) {
    return Math.max(5, Math.min(max, Number(value || fallback) || fallback));
}

function clipMemoryDisplayText(value, max = 520) {
    const text = String(value || '').replace(/\s+/g, ' ').trim();
    if (text.length <= max) return text;
    return `${text.slice(0, max - 1)}…`;
}

const MEMORY_LIBRARY_ROW_COLUMNS = [
    'id',
    'character_id',
    'time',
    'location',
    'people',
    'event',
    'relationships',
    'items',
    'importance',
    'created_at',
    'group_id',
    'last_retrieved_at',
    'retrieval_count',
    'memory_type',
    'summary',
    'content',
    'people_json',
    'items_json',
    'relationship_json',
    'emotion',
    'source_message_ids_json',
    'dedupe_key',
    'updated_at',
    'is_archived',
    'source_started_at',
    'source_ended_at',
    'source_time_text',
    'source_message_count',
    'memory_tier',
    'memory_focus',
    'maintenance_status',
    'classification_source',
    'classified_at',
    'retention_score',
    'retention_action',
    'retention_reason',
    'retention_checked_at',
    'consolidation_key',
    'consolidation_summary',
    'consolidated_into_memory_id',
    'archive_reason',
    'forgetting_grace_started_at',
    'forgetting_grace_expires_at',
    'source_context',
    'scene_tag',
    'source_app',
    'temporal_label',
    'temporal_scope',
    'temporal_anchor',
    'temporal_confidence',
    'temporal_reason',
    'temporal_checked_at'
];

function quoteSqlIdentifier(name) {
    return `"${String(name || '').replace(/"/g, '""')}"`;
}

function getMemoryLibraryRowSelect(rawDb, alias = '') {
    const columns = getTableColumnSet(rawDb, 'memories');
    const prefix = alias ? `${quoteSqlIdentifier(alias)}.` : '';
    const selected = MEMORY_LIBRARY_ROW_COLUMNS.filter(column => columns.has(column));
    return selected.map(column => `${prefix}${quoteSqlIdentifier(column)}`).join(', ');
}

function parseMemorySourceIds(value) {
    if (Array.isArray(value)) return value.map(item => String(item || '').trim()).filter(Boolean);
    const raw = String(value || '').trim();
    if (!raw) return [];
    try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) return parsed.map(item => String(item || '').trim()).filter(Boolean);
    } catch (e) {
        // Keep compact source detection resilient for legacy rows.
    }
    return raw.split(/[,\s]+/).map(item => item.trim()).filter(Boolean);
}

function hasExternalMemorySourceSignal(row = {}) {
    if (String(row.source_app || '').trim()) return true;
    if (String(row.classification_source || '').trim() === 'manual-edit') return true;
    const ids = parseMemorySourceIds(row.source_message_ids_json);
    return ids.some(id => /^(external|import|gpt|gemini|sillytavern|silly-tavern):/i.test(id));
}

function inferMemorySourceContext(row = {}) {
    const existing = String(row.source_context || '').trim();
    if (existing === 'diary' || existing === 'moment') return 'unknown';
    if (existing === 'external_app') {
        return hasExternalMemorySourceSignal(row) ? 'external_app' : 'unknown';
    }
    if (MEMORY_SOURCE_CONTEXTS.has(existing)) return existing;
    const ids = parseMemorySourceIds(row.source_message_ids_json);
    const text = [
        row.summary,
        row.content,
        row.event,
        row.location,
        row.source_time_text,
        row.group_id,
        row.source_app,
        ...ids
    ].filter(Boolean).join(' ');
    if (hasExternalMemorySourceSignal(row)) return 'external_app';
    if (ids.some(id => /^city:/i.test(id)) || /(商业街|city activity|商业街行动|商业街活动|街区|公告任务|工厂|厂区|工头|工服|领工钱|日结|仓储区|堆货区|签到处|便利店|餐厅|公园|长椅|回家|出租屋)/i.test(text)) return 'commercial_street';
    if (row.group_id || ids.some(id => /^group:/i.test(id)) || /(群聊|group_chat|group message)/i.test(text)) return 'group_chat';
    if (ids.some(id => /^diary:/i.test(id) || /^moment:/i.test(id))) return 'unknown';
    return 'private_chat';
}

function inferMemorySceneTag(row = {}, context = inferMemorySourceContext(row)) {
    const existing = String(row.scene_tag || '').trim();
    if (existing === 'diary' || existing === 'moment') return 'other';
    if (/^external_/i.test(existing) && context !== 'external_app') return 'other';
    if (existing === 'external_app' && context !== 'external_app') return 'other';
    if (MEMORY_SCENE_TAGS.has(existing)) return existing;
    const app = String(row.source_app || '').toLowerCase();
    if (/gpt/.test(app)) return 'external_gpt';
    if (/gemini/.test(app)) return 'external_gemini';
    if (/silly/.test(app)) return 'external_sillytavern';
    if (context === 'commercial_street') return 'commercial_street';
    if (context === 'group_chat') return 'group_chat';
    if (context === 'external_app') return 'external_app';
    if (context === 'private_chat') return 'private_chat';
    return 'other';
}

function buildMemoryLibraryItem(row, charById, now = Date.now()) {
    const character = charById.get(String(row.character_id)) || { id: row.character_id, name: row.character_id };
    const retention = computeMemoryRetention(row, now);
    const daysUntilThreshold = computeDaysUntilRetentionThreshold(row, retention);
    const forgettingWindow = computeMemoryForgettingWindow(row, retention, now);
    const text = row.consolidation_summary || row.summary || row.content || row.event || '';
    const sourceIds = String(row.source_ids || '')
        .split(',')
        .map(id => Number(id || 0))
        .filter(id => id > 0);
    const fallbackSourceIds = sourceIds.length ? sourceIds : [Number(row.id || 0)].filter(Boolean);
    const isFormalNewMemory = !!row.formal_group_key;
    return {
        id: row.formal_group_key || row.id,
        representative_id: row.id,
        character_id: row.character_id,
        character_name: character.name || row.character_id,
        text: clipMemoryDisplayText(text),
        legacy_text: row.consolidation_summary ? clipMemoryDisplayText(row.summary || row.content || row.event || '', 260) : '',
        memory_library_source: isFormalNewMemory ? 'new_grouped' : (row.consolidation_summary ? 'new' : 'legacy_backup'),
        memory_focus: row.memory_focus || 'general',
        memory_tier: row.memory_tier || 'ambient',
        memory_type: row.memory_type || 'event',
        importance: Number(row.source_importance || row.importance || 5),
        retrieval_count: Number(row.source_retrieval_count || row.retrieval_count || 0),
        last_retrieved_at: Number(row.last_retrieved_at || 0),
        created_at: Number(row.created_at || 0),
        updated_at: Number(row.updated_at || 0),
        source_started_at: Number(row.source_started_at || 0),
        source_ended_at: Number(row.source_ended_at || 0),
        source_time_text: row.source_time_text || '',
        source_ids: fallbackSourceIds,
        source_count: Number(row.source_count || fallbackSourceIds.length || 1),
        source_context: inferMemorySourceContext(row),
        scene_tag: inferMemorySceneTag(row),
        source_app: row.source_app || '',
        temporal_label: row.temporal_label || '',
        temporal_scope: row.temporal_scope || '',
        temporal_anchor: row.temporal_anchor || '',
        temporal_confidence: Number(row.temporal_confidence || 0),
        temporal_reason: row.temporal_reason || '',
        timeline_at: Number(row.formal_sort_at || row.source_ended_at || row.source_started_at || row.created_at || 0),
        is_archived: Number(row.is_archived || 0),
        maintenance_status: row.maintenance_status || 'pending',
        retention_score: retention.retention_score,
        retention_action: retention.suggested_action,
        days_until_threshold: daysUntilThreshold,
        forgetting_stage: forgettingWindow.stage,
        threshold_at: forgettingWindow.threshold_at,
        grace_started_at: forgettingWindow.grace_started_at,
        grace_expires_at: forgettingWindow.grace_expires_at,
        days_until_grace_expires: forgettingWindow.days_until_grace_expires,
        grace_hours: forgettingWindow.grace_hours,
        protected: !!retention.protected
    };
}

function compareMemoryForgettingItems(a, b) {
    const dayDiff = Number(a.days_until_threshold || 0) - Number(b.days_until_threshold || 0);
    if (dayDiff !== 0) return dayDiff;
    const graceDiff = Number(a.grace_expires_at || 0) - Number(b.grace_expires_at || 0);
    if (graceDiff !== 0) return graceDiff;
    return Number(a.retention_score || 0) - Number(b.retention_score || 0);
}

function buildMemoryForgettingGroups(curveItems = [], showAll = false, forgettingLimit = 120, mode = 'legacy') {
    const sortedItems = [...curveItems].sort(compareMemoryForgettingItems);
    const fastForgetting = sortedItems.filter(item => Number(item.days_until_threshold || 0) <= 30);
    const onCurve = sortedItems.filter(item => Number(item.days_until_threshold || 0) > 30);
    const isFormal = mode === 'new';
    return [
        {
            key: 'fast',
            label: '快遗忘',
            description: isFormal
                ? '按新版正式记忆本身计算：30 天内到达遗忘阈值，或已经进入 24 小时缓冲池。救回会作用到背后的承载卡片。'
                : '30 天内到达遗忘阈值，或已经进入 24 小时缓冲池的记忆。缓冲期内可以救回。',
            count: fastForgetting.length,
            items: showAll ? fastForgetting : fastForgetting.slice(0, forgettingLimit),
            has_more: !showAll && fastForgetting.length > forgettingLimit
        },
        {
            key: 'on_curve',
            label: '已进入遗忘曲线',
            description: isFormal
                ? '按新版正式记忆的 summary、分类、重要性和调用情况计算衰减；还没进入 30 天快遗忘窗口。'
                : '已经按遗忘曲线开始衰减，但还没进入 30 天快遗忘窗口。越靠前越接近缓冲池。',
            count: onCurve.length,
            items: showAll ? onCurve : onCurve.slice(0, forgettingLimit),
            has_more: !showAll && onCurve.length > forgettingLimit
        }
    ];
}

function getPositiveMin(values = []) {
    const positives = values.map(value => Number(value || 0)).filter(value => value > 0);
    return positives.length ? Math.min(...positives) : 0;
}

function updateFormalMemoryGraceRows(rawDb, sourceIds = [], patch = {}) {
    const ids = Array.from(new Set((Array.isArray(sourceIds) ? sourceIds : [])
        .map(id => Number(id || 0))
        .filter(id => id > 0)));
    if (!rawDb || ids.length === 0) return;
    const columns = getTableColumnSet(rawDb, 'memories');
    if (!columns.has('forgetting_grace_started_at') || !columns.has('forgetting_grace_expires_at')) return;
    const stmt = rawDb.prepare(`
        UPDATE memories
        SET forgetting_grace_started_at = ?,
            forgetting_grace_expires_at = ?
        WHERE id = ?
    `);
    const tx = rawDb.transaction((rows) => {
        for (const id of rows) {
            stmt.run(Number(patch.started_at || 0), Number(patch.expires_at || 0), id);
        }
    });
    tx(ids);
}

function applyFormalMemoryForgettingState(item, rawDb, now = Date.now(), options = {}) {
    const persistGrace = options.persistGrace !== false;
    const rows = Array.isArray(item._source_rows) ? item._source_rows : [];
    const virtualRow = {
        id: item.id,
        character_id: item.character_id,
        summary: item.summary,
        content: item.summary,
        event: item.summary,
        consolidation_summary: item.summary,
        memory_type: 'formal_memory',
        memory_focus: item.memory_focus || 'general',
        memory_tier: item.memory_tier || 'ambient',
        importance: Number(item.importance || 5),
        retrieval_count: Number(item.retrieval_count || 0),
        last_retrieved_at: Number(item.last_retrieved_at || 0),
        created_at: Number(item.created_at || 0),
        updated_at: Number(item.updated_at || 0),
        source_started_at: Number(item.source_started_at || 0),
        source_ended_at: Number(item.source_ended_at || 0)
    };
    const retention = computeMemoryRetention(virtualRow, now);
    const daysUntilThreshold = computeDaysUntilRetentionThreshold(virtualRow, retention);
    const shouldBeInGrace = !retention.protected && daysUntilThreshold !== null && Number(daysUntilThreshold) <= 0;
    if (shouldBeInGrace) {
        const existingStartedAt = getPositiveMin(rows.map(row => row.forgetting_grace_started_at));
        const existingExpiresAt = getPositiveMin(rows.map(row => row.forgetting_grace_expires_at));
        const startedAt = existingStartedAt > 0 ? existingStartedAt : now;
        const expiresAt = existingExpiresAt > startedAt ? existingExpiresAt : startedAt + MEMORY_FORGETTING_GRACE_MS;
        virtualRow.forgetting_grace_started_at = startedAt;
        virtualRow.forgetting_grace_expires_at = expiresAt;
        if (persistGrace) {
            updateFormalMemoryGraceRows(rawDb, item.source_ids, { started_at: startedAt, expires_at: expiresAt });
        }
    } else {
        virtualRow.forgetting_grace_started_at = 0;
        virtualRow.forgetting_grace_expires_at = 0;
        if (persistGrace) {
            updateFormalMemoryGraceRows(rawDb, item.source_ids, { started_at: 0, expires_at: 0 });
        }
    }
    const forgettingWindow = computeMemoryForgettingWindow(virtualRow, retention, now);
    item.text = item.summary || '';
    item.memory_library_source = 'new_grouped';
    item.representative_id = rows[0]?.id || item.source_ids?.[0] || 0;
    item.retention_score = retention.retention_score;
    item.retention_action = retention.suggested_action || item.retention_action || 'keep';
    item.days_until_threshold = daysUntilThreshold;
    item.forgetting_stage = forgettingWindow.stage;
    item.threshold_at = forgettingWindow.threshold_at;
    item.grace_started_at = forgettingWindow.grace_started_at;
    item.grace_expires_at = forgettingWindow.grace_expires_at;
    item.days_until_grace_expires = forgettingWindow.days_until_grace_expires;
    item.grace_hours = forgettingWindow.grace_hours;
    item.protected = !!retention.protected;
    delete item._source_rows;
    return item;
}

function buildNewMemorySummaryLibrary(rawDb, charById, definitions, baseWhere, baseParams, options = {}) {
    const now = Number(options.now || Date.now());
    const showAll = !!options.showAll;
    const forgettingLimit = options.forgettingLimit || 120;
    const limitPerGroup = showAll ? null : clampMemoryLibraryLimit(options.limitPerGroup, 28, 120);
    const rowSelect = getMemoryLibraryRowSelect(rawDb);
    const rows = rawDb.prepare(`
        SELECT ${rowSelect}
        FROM memories
        WHERE ${baseWhere.join(' AND ')}
          AND COALESCE(NULLIF(consolidation_summary, ''), '') <> ''
        ORDER BY COALESCE(NULLIF(updated_at, 0), NULLIF(classified_at, 0), NULLIF(created_at, 0), id) DESC, id ASC
    `).all(...baseParams);
    const grouped = new Map();
    for (const row of rows) {
        const character = charById.get(String(row.character_id)) || { id: row.character_id, name: row.character_id };
        const summary = clipMemoryDisplayText(row.consolidation_summary || '', 720);
        if (!summary) continue;
        const groupKey = [
            row.character_id || '',
            row.consolidation_key || '',
            String(summary).toLowerCase()
        ].join('::');
        const existing = grouped.get(groupKey);
        const sourceText = clipMemoryDisplayText(row.summary || row.content || row.event || '', 180);
        const sourceContext = inferMemorySourceContext(row);
        const sceneTag = inferMemorySceneTag(row, sourceContext);
        const item = existing || {
            id: groupKey,
            character_id: row.character_id,
            character_name: character.name || row.character_id,
            summary,
            memory_focus: row.memory_focus || 'general',
            memory_tier: row.memory_tier || 'ambient',
            importance: Number(row.importance || 5),
            consolidation_key: row.consolidation_key || '',
            retention_action: row.retention_action || '',
            classification_source: row.classification_source || '',
            source_context: sourceContext,
            scene_tag: sceneTag,
            source_contexts: [],
            scene_tags: [],
            source_ids: [],
            source_count: 0,
            source_preview: [],
            retrieval_count: 0,
            last_retrieved_at: 0,
            created_at: Number(row.created_at || 0),
            updated_at: Number(row.updated_at || row.classified_at || row.created_at || 0),
            source_started_at: Number(row.source_started_at || 0),
            source_ended_at: Number(row.source_ended_at || row.source_started_at || 0),
            _source_rows: []
        };
        if (sourceContext && !item.source_contexts.includes(sourceContext)) item.source_contexts.push(sourceContext);
        if (sceneTag && !item.scene_tags.includes(sceneTag)) item.scene_tags.push(sceneTag);
        if ((!item.source_context || item.source_context === 'unknown') && sourceContext && sourceContext !== 'unknown') {
            item.source_context = sourceContext;
        }
        if ((!item.scene_tag || item.scene_tag === 'none' || item.scene_tag === 'other') && sceneTag && !['none', 'other'].includes(sceneTag)) {
            item.scene_tag = sceneTag;
        }
        item.source_ids.push(row.id);
        item.source_count += 1;
        item._source_rows.push(row);
        item.retrieval_count += Number(row.retrieval_count || 0);
        item.last_retrieved_at = Math.max(Number(item.last_retrieved_at || 0), Number(row.last_retrieved_at || 0));
        item.importance = Math.max(item.importance, Number(row.importance || 5));
        item.updated_at = Math.max(Number(item.updated_at || 0), Number(row.updated_at || row.classified_at || 0));
        item.created_at = Math.min(Number(item.created_at || row.created_at || 0), Number(row.created_at || item.created_at || 0));
        const rowSourceStartedAt = Number(row.source_started_at || 0);
        const rowSourceEndedAt = Number(row.source_ended_at || row.source_started_at || 0);
        if (rowSourceStartedAt > 0) {
            item.source_started_at = item.source_started_at > 0
                ? Math.min(Number(item.source_started_at || 0), rowSourceStartedAt)
                : rowSourceStartedAt;
        }
        if (rowSourceEndedAt > 0) {
            item.source_ended_at = Math.max(Number(item.source_ended_at || 0), rowSourceEndedAt);
        }
        if (row.memory_tier === 'core' || (row.memory_tier === 'active' && item.memory_tier === 'ambient')) {
            item.memory_tier = row.memory_tier;
        }
        if (row.retention_action === 'merge_candidate') item.retention_action = 'merge_candidate';
        if (sourceText && item.source_preview.length < 4) {
            item.source_preview.push({ id: row.id, text: sourceText });
        }
        grouped.set(groupKey, item);
    }
    const items = Array.from(grouped.values())
        .map(item => applyFormalMemoryForgettingState(item, rawDb, now, { persistGrace: false }))
        .sort((a, b) => Number(b.updated_at || 0) - Number(a.updated_at || 0));
    const curveItems = items
        .filter(item => !item.protected && item.days_until_threshold !== null && item.days_until_threshold !== undefined)
        .sort(compareMemoryForgettingItems);
    const categories = definitions.map(def => {
        const categoryItems = items.filter(item => item.memory_focus === def.key);
        return {
            key: def.key,
            label: def.label,
            description: def.description,
            count: categoryItems.length,
            limit: showAll ? categoryItems.length : limitPerGroup,
            has_more: !showAll && categoryItems.length > limitPerGroup,
            items: showAll ? categoryItems : categoryItems.slice(0, limitPerGroup)
        };
    }).filter(group => group.count > 0 || ['user_profile', 'relationship', 'user_current_arc', 'general'].includes(group.key));
    const sourceGroups = MEMORY_SOURCE_CONTEXT_DEFINITIONS.map(def => {
        const sourceItems = items.filter(item => {
            if (Array.isArray(item.source_contexts) && item.source_contexts.length > 0) {
                return item.source_contexts.includes(def.key);
            }
            return item.source_context === def.key;
        });
        return {
            key: def.key,
            label: def.label,
            description: def.description,
            count: sourceItems.length,
            limit: showAll ? sourceItems.length : limitPerGroup,
            has_more: !showAll && sourceItems.length > limitPerGroup,
            items: showAll ? sourceItems : sourceItems.slice(0, limitPerGroup)
        };
    });
    return {
        total: items.length,
        source_total: rows.length,
        categories,
        source_groups: sourceGroups,
        forgetting_groups: buildMemoryForgettingGroups(curveItems, showAll, forgettingLimit, 'new')
    };
}

function getMemoryMaintenanceLibrary(rawDb, options = {}) {
    const showAll = parseBooleanFlag(options.all);
    const limitPerGroup = showAll ? null : clampMemoryLibraryLimit(options.limit_per_group, 28, 120);
    const forgettingLimit = showAll ? null : clampMemoryLibraryLimit(options.forgetting_limit, 70, 160);
    const timelineShowAll = showAll || parseBooleanFlag(options.timeline_all);
    const timelineLimit = timelineShowAll
        ? null
        : clampMemoryLibraryLimit(options.timeline_limit, Math.max(limitPerGroup || 36, 720), 3000);
    const characterId = String(options.character_id || '').trim();
    const temporalFilter = String(options.temporal_filter || 'all').trim();
    const timelineFilter = normalizeMemoryTimelineFilter(options.timeline_filter || 'strong_time_bound');
    const sourceMode = String(options.source || 'new').trim() === 'legacy' ? 'legacy' : 'new';
    const characters = rawDb.prepare('SELECT id, name, avatar FROM characters ORDER BY name COLLATE NOCASE ASC').all();
    const charById = new Map(characters.map(c => [String(c.id), c]));
    const now = Date.now();
    const rowSelect = getMemoryLibraryRowSelect(rawDb);
    const baseWhere = ['COALESCE(is_archived, 0) = 0'];
    const baseParams = [];
    if (sourceMode === 'new') {
        baseWhere.push("COALESCE(NULLIF(consolidation_summary, ''), '') <> ''");
    }
    if (characterId) {
        baseWhere.push('character_id = ?');
        baseParams.push(characterId);
    }
    if (sourceMode === 'new' && temporalFilter === 'temporal_signal') {
        baseWhere.push(getMemoryTemporalSignalSql());
        baseParams.push(...getMemoryTemporalSignalParams());
    }
    const graceRows = rawDb.prepare(`
        SELECT ${rowSelect}
        FROM memories
        WHERE ${baseWhere.join(' AND ')}
    `).all(...baseParams);
    if (sourceMode === 'legacy') {
        ensureForgettingGraceWindows(rawDb, graceRows, now);
    }

    const focusCounts = rawDb.prepare(`
        SELECT COALESCE(NULLIF(memory_focus, ''), 'general') AS memory_focus, COUNT(*) AS count
        FROM memories
        WHERE ${baseWhere.join(' AND ')}
        GROUP BY COALESCE(NULLIF(memory_focus, ''), 'general')
        ORDER BY count DESC
    `).all(...baseParams);
    const knownKeys = new Set(MEMORY_LIBRARY_FOCUS_DEFINITIONS.map(item => item.key));
    const extraDefinitions = focusCounts
        .filter(item => !knownKeys.has(item.memory_focus))
        .map(item => ({
            key: item.memory_focus,
            label: `${item.memory_focus} 分类`,
            description: '小模型或历史数据写入的扩展分类。后续可以补充专门规则，暂时按原分类名展示。'
        }));
    const definitions = [...MEMORY_LIBRARY_FOCUS_DEFINITIONS, ...extraDefinitions];

    const categories = definitions.map(def => {
        const where = [...baseWhere, "COALESCE(NULLIF(memory_focus, ''), 'general') = ?"];
        const params = [...baseParams, def.key];
        const count = Number(rawDb.prepare(`SELECT COUNT(*) AS c FROM memories WHERE ${where.join(' AND ')}`).get(...params)?.c || 0);
        const rows = rawDb.prepare(`
            SELECT ${rowSelect}
            FROM memories
            WHERE ${where.join(' AND ')}
            ORDER BY COALESCE(NULLIF(updated_at, 0), NULLIF(created_at, 0), id) DESC, id DESC
            ${showAll ? '' : 'LIMIT ?'}
        `).all(...params, ...(showAll ? [] : [limitPerGroup]));
        return {
            ...def,
            count,
            limit: showAll ? count : limitPerGroup,
            has_more: !showAll && count > rows.length,
            items: rows.map(row => buildMemoryLibraryItem(row, charById, now))
        };
    }).filter(group => group.count > 0 || knownKeys.has(group.key));

    const timelineBaseWhere = [
        'COALESCE(is_archived, 0) = 0',
        "COALESCE(NULLIF(consolidation_summary, ''), '') <> ''"
    ];
    const timelineBaseParams = [];
    if (characterId) {
        timelineBaseWhere.push('character_id = ?');
        timelineBaseParams.push(characterId);
    }
    const timelineClause = getMemoryTimelineFilterClause(timelineFilter);
    const timelineWhere = [...timelineBaseWhere, timelineClause.where];
    const timelineParams = [...timelineBaseParams, ...timelineClause.params];
    const formalGroupExpr = getFormalMemoryGroupSql();
    const timelineCount = countFormalMemoryGroups(rawDb, timelineWhere, timelineParams);
    const timelineSourceCount = Number(rawDb.prepare(`SELECT COUNT(*) AS c FROM memories WHERE ${timelineWhere.join(' AND ')}`).get(...timelineParams)?.c || 0);
    const timelineSignalCount = countFormalMemoryGroups(rawDb, [...timelineBaseWhere, getMemoryTemporalSignalSql()], [...timelineBaseParams, ...getMemoryTemporalSignalParams()]);
    const timelineStrongCount = timelineFilter === 'strong_time_bound'
        ? timelineCount
        : countFormalMemoryGroups(rawDb, [...timelineBaseWhere, getMemoryStrongTimelineSql()], [...timelineBaseParams, ...getMemoryStrongTimelineParams()]);
    const timelineRows = rawDb.prepare(`
        WITH eligible AS (
            SELECT ${rowSelect},
                   ${formalGroupExpr} AS formal_group_key,
                   COALESCE(NULLIF(source_ended_at, 0), NULLIF(source_started_at, 0), NULLIF(created_at, 0), id) AS row_sort_at
            FROM memories
            WHERE ${timelineWhere.join(' AND ')}
        ),
        ranked AS (
            SELECT eligible.*,
                   MAX(row_sort_at) OVER (PARTITION BY formal_group_key) AS formal_sort_at,
                   COUNT(*) OVER (PARTITION BY formal_group_key) AS source_count,
                   GROUP_CONCAT(id) OVER (PARTITION BY formal_group_key) AS source_ids,
                   SUM(COALESCE(retrieval_count, 0)) OVER (PARTITION BY formal_group_key) AS source_retrieval_count,
                   MAX(COALESCE(importance, 0)) OVER (PARTITION BY formal_group_key) AS source_importance,
                   ROW_NUMBER() OVER (PARTITION BY formal_group_key ORDER BY row_sort_at DESC, id DESC) AS formal_rank
            FROM eligible
        )
        SELECT *
        FROM ranked
        WHERE formal_rank = 1
        ORDER BY formal_sort_at DESC, id DESC
        ${timelineShowAll ? '' : 'LIMIT ?'}
    `).all(...timelineParams, ...(timelineShowAll ? [] : [timelineLimit]));

    const newLibrary = buildNewMemorySummaryLibrary(rawDb, charById, definitions, baseWhere, baseParams, {
        now,
        showAll,
        forgettingLimit,
        limitPerGroup
    });

    const forgettingRows = rawDb.prepare(`
        SELECT ${rowSelect}
        FROM memories
        WHERE ${baseWhere.join(' AND ')}
    `).all(...baseParams);
    const curveItems = forgettingRows
        .map(row => buildMemoryLibraryItem(row, charById, now))
        .filter(item => !item.protected && item.days_until_threshold !== null && item.days_until_threshold !== undefined)
        .sort(compareMemoryForgettingItems);
    const legacyForgettingGroups = buildMemoryForgettingGroups(curveItems, showAll, forgettingLimit, 'legacy');

    return {
        all: showAll,
        source: sourceMode,
        temporal_filter: temporalFilter,
        timeline_filter: timelineFilter,
        limit_per_group: limitPerGroup,
        forgetting_limit: forgettingLimit,
        categories,
        timeline: {
            filter: timelineClause.filter,
            criteria: timelineClause.description,
            count: timelineCount,
            strong_time_bound_count: timelineStrongCount,
            temporal_signal_count: timelineSignalCount,
            source_count: timelineSourceCount,
            confidence_threshold: MEMORY_TIMELINE_CONFIDENCE_THRESHOLD,
            limit: timelineShowAll ? timelineCount : timelineLimit,
            items: timelineRows.map(row => buildMemoryLibraryItem(row, charById, now)),
            has_more: !timelineShowAll && timelineCount > timelineRows.length
        },
        new_library: newLibrary,
        forgetting_groups: sourceMode === 'new' ? (newLibrary.forgetting_groups || []) : legacyForgettingGroups
    };
}

function getMemoryMaintenanceOverview(rawDb) {
    const characters = rawDb.prepare('SELECT id, name, avatar FROM characters ORDER BY name COLLATE NOCASE ASC').all();
    const charById = new Map(characters.map(c => [String(c.id), c]));
    const rowSelect = getMemoryLibraryRowSelect(rawDb);
    const allRows = rawDb.prepare(`SELECT ${rowSelect} FROM memories ORDER BY id ASC`).all();
    const rows = allRows.filter(row => String(row.consolidation_summary || '').trim());
    const legacyRows = allRows.filter(row => {
        const sourceContext = String(row.source_context || '').trim();
        const source = String(row.classification_source || '').trim();
        const dedupeKey = String(row.dedupe_key || '').trim();
        const hasFormalSummary = !!String(row.consolidation_summary || '').trim();
        const externalFormalOnly = sourceContext === 'external_app'
            && hasFormalSummary
            && (source === 'external-import-direct'
                || source === 'small-model-auto-migration'
                || dedupeKey.startsWith('external-import-direct:')
                || dedupeKey.startsWith('external-import-formal:'));
        return !externalFormalOnly;
    });
    const formalNewKeys = new Set();
    const formalNewKeysByCharacter = new Map();
    const legacyByCharacter = new Map();
    for (const row of legacyRows) {
        const key = String(row.character_id || '');
        if (!key) continue;
        const character = charById.get(key) || { id: key, name: key };
        if (!legacyByCharacter.has(key)) {
            legacyByCharacter.set(key, {
                character_id: row.character_id,
                name: character.name || key,
                total: 0,
                pending: 0,
                new_total: 0
            });
        }
        const legacyStats = legacyByCharacter.get(key);
        legacyStats.total += 1;
        if (String(row.consolidation_summary || '').trim()) {
            legacyStats.new_total += 1;
        }
        const maintenanceStatus = String(row.maintenance_status || 'pending');
        if (!maintenanceStatus || maintenanceStatus === 'pending') {
            legacyStats.pending += 1;
        }
    }
    const externalPendingByCharacter = getExternalImportPendingStatsByCharacter(rawDb);
    for (const [key, externalStats] of externalPendingByCharacter.entries()) {
        const character = charById.get(key) || { id: key, name: externalStats.name || key };
        if (!legacyByCharacter.has(key)) {
            legacyByCharacter.set(key, {
                character_id: character.id,
                name: character.name || key,
                total: 0,
                pending: 0,
                new_total: 0
            });
        }
        const legacyStats = legacyByCharacter.get(key);
        legacyStats.external_pending = Number(externalStats.pending || 0);
        legacyStats.external_total = Number(externalStats.total || 0);
        legacyStats.pending += Number(externalStats.pending || 0);
        legacyStats.total += Number(externalStats.total || 0);
    }
    const now = Date.now();
    const totals = {
        total: rows.length,
        migrated_card_total: rows.length,
        formal_total: 0,
        legacy_total: legacyRows.length,
        legacy_pending: legacyRows.filter(row => !String(row.maintenance_status || 'pending') || String(row.maintenance_status || 'pending') === 'pending').length,
        external_pending: Array.from(externalPendingByCharacter.values()).reduce((sum, item) => sum + Number(item.pending || 0), 0),
        active: 0,
        archived: 0,
        pending: 0,
        classified: 0,
        total_retrieval_count: 0,
        recalled_memories: 0,
        never_recalled: 0
    };
    totals.legacy_pending += totals.external_pending;
    const byFocus = {};
    const byTier = {};
    const byAction = {};
    const byCharacter = new Map();
    const forgettingBuckets = {
        protected: 0,
        now: 0,
        within_7_days: 0,
        within_14_days: 0,
        within_30_days: 0,
        later: 0,
        no_curve: 0
    };
    const upcoming = [];

    for (const row of rows) {
        const character = charById.get(String(row.character_id)) || { id: row.character_id, name: row.character_id };
        if (!byCharacter.has(row.character_id)) {
            byCharacter.set(row.character_id, {
                character_id: row.character_id,
                name: character.name || row.character_id,
                total: 0,
                migrated_card_total: 0,
                formal_total: 0,
                active: 0,
                archived: 0,
                pending: 0,
                classified: 0,
                retrieval_count: 0,
                archive_candidates: 0
            });
        }
        const charStats = byCharacter.get(row.character_id);
        charStats.total += 1;
        charStats.migrated_card_total += 1;
        const formalKey = [
            row.character_id || '',
            row.consolidation_key || '',
            String(row.consolidation_summary || '').trim().toLowerCase()
        ].join('::');
        formalNewKeys.add(formalKey);
        if (!formalNewKeysByCharacter.has(row.character_id)) {
            formalNewKeysByCharacter.set(row.character_id, new Set());
        }
        formalNewKeysByCharacter.get(row.character_id).add(formalKey);
        const archived = Number(row.is_archived || 0) === 1;
        if (archived) {
            totals.archived += 1;
            charStats.archived += 1;
        } else {
            totals.active += 1;
            charStats.active += 1;
        }
        const maintenanceStatus = String(row.maintenance_status || 'pending');
        if (!maintenanceStatus || maintenanceStatus === 'pending') {
            totals.pending += 1;
            charStats.pending += 1;
        } else if (maintenanceStatus === 'classified') {
            totals.classified += 1;
            charStats.classified += 1;
        }
        const retrievalCount = Number(row.retrieval_count || 0);
        totals.total_retrieval_count += retrievalCount;
        charStats.retrieval_count += retrievalCount;
        if (retrievalCount > 0) totals.recalled_memories += 1;
        else totals.never_recalled += 1;

        if (!archived) {
            incrementCount(byFocus, row.memory_focus || 'general');
            incrementCount(byTier, row.memory_tier || 'ambient');
            const retention = computeMemoryRetention(row, now);
            const daysUntil = computeDaysUntilRetentionThreshold(row, retention);
            incrementCount(byAction, retention.suggested_action);
            if (retention.suggested_action === 'archive_candidate') {
                charStats.archive_candidates += 1;
            }
            if (retention.protected) {
                forgettingBuckets.protected += 1;
            } else if (daysUntil === null) {
                forgettingBuckets.no_curve += 1;
            } else if (daysUntil <= 0) {
                forgettingBuckets.now += 1;
            } else if (daysUntil <= 7) {
                forgettingBuckets.within_7_days += 1;
            } else if (daysUntil <= 14) {
                forgettingBuckets.within_14_days += 1;
            } else if (daysUntil <= 30) {
                forgettingBuckets.within_30_days += 1;
            } else {
                forgettingBuckets.later += 1;
            }
            if (!retention.protected && daysUntil !== null && daysUntil <= 30) {
                const forgettingWindow = computeMemoryForgettingWindow(row, retention, now);
                upcoming.push({
                    id: row.id,
                    character_id: row.character_id,
                    character_name: character.name || row.character_id,
                    memory_focus: row.memory_focus || 'general',
                    memory_tier: row.memory_tier || 'ambient',
                    importance: Number(row.importance || 5),
                    retrieval_count: retrievalCount,
                    retention_score: retention.retention_score,
                    retention_action: retention.suggested_action,
                    days_until_threshold: daysUntil,
                    forgetting_stage: forgettingWindow.stage,
                    threshold_at: forgettingWindow.threshold_at,
                    grace_expires_at: forgettingWindow.grace_expires_at,
                    days_until_grace_expires: forgettingWindow.days_until_grace_expires,
                    routine_city: !!retention.routine_city
                });
            }
        }
    }
    totals.formal_total = formalNewKeys.size;
    for (const legacyStats of legacyByCharacter.values()) {
        if (!byCharacter.has(legacyStats.character_id)) {
            byCharacter.set(legacyStats.character_id, {
                character_id: legacyStats.character_id,
                name: legacyStats.name || legacyStats.character_id,
                total: 0,
                migrated_card_total: 0,
                formal_total: 0,
                active: 0,
                archived: 0,
                pending: 0,
                classified: 0,
                retrieval_count: 0,
                archive_candidates: 0
            });
        }
        const charStats = byCharacter.get(legacyStats.character_id);
        charStats.legacy_total = legacyStats.total;
        charStats.legacy_pending = legacyStats.pending;
        charStats.external_pending = Number(legacyStats.external_pending || 0);
        charStats.external_total = Number(legacyStats.external_total || 0);
        charStats.migrated_total = legacyStats.new_total;
        charStats.migrated_card_total = legacyStats.new_total;
        charStats.formal_total = formalNewKeysByCharacter.get(legacyStats.character_id)?.size || 0;
        charStats.needs_migration = legacyStats.new_total < legacyStats.total;
    }
    for (const charStats of byCharacter.values()) {
        if (charStats.legacy_total === undefined) {
            charStats.legacy_total = 0;
            charStats.legacy_pending = 0;
            charStats.migrated_total = 0;
            charStats.formal_total = formalNewKeysByCharacter.get(charStats.character_id)?.size || charStats.formal_total || 0;
            charStats.needs_migration = false;
        }
    }
    const byCharacterList = Array.from(byCharacter.values()).sort((a, b) => {
        const totalDiff = Number(b.total || 0) - Number(a.total || 0);
        if (totalDiff !== 0) return totalDiff;
        return Number(b.legacy_total || 0) - Number(a.legacy_total || 0);
    });
    const migrationCharacters = Array.from(legacyByCharacter.values())
        .map(stats => ({
            ...stats,
            migrated_card_total: stats.new_total,
            formal_total: formalNewKeysByCharacter.get(stats.character_id)?.size || 0
        }))
        .sort((a, b) => {
            const pendingDiff = Number(b.pending || 0) - Number(a.pending || 0);
            if (pendingDiff !== 0) return pendingDiff;
            return Number(b.total || 0) - Number(a.total || 0);
        });

    return {
        totals,
        by_focus: Object.entries(byFocus).map(([memory_focus, count]) => ({ memory_focus, count })).sort((a, b) => b.count - a.count),
        by_tier: Object.entries(byTier).map(([memory_tier, count]) => ({ memory_tier, count })).sort((a, b) => b.count - a.count),
        by_action: Object.entries(byAction).map(([action, count]) => ({ action, count })).sort((a, b) => b.count - a.count),
        forgetting_buckets: forgettingBuckets,
        by_character: byCharacterList,
        legacy_by_character: migrationCharacters,
        migration_characters: migrationCharacters,
        upcoming_forgetting: upcoming.sort((a, b) => a.days_until_threshold - b.days_until_threshold).slice(0, 80)
    };
}

function getMemoryMaintenanceSettings(db) {
    const profile = db.getUserProfile?.() || {};
    return {
        api_endpoint: profile.memory_maintenance_api_endpoint || '',
        api_key: profile.memory_maintenance_api_key || '',
        model_name: profile.memory_maintenance_model_name || '',
        batch_size: Math.max(10, Math.min(100, Number(profile.memory_maintenance_batch_size || 30) || 30)),
        max_output_tokens: Math.max(1000, Math.min(20000, Number(profile.memory_maintenance_max_tokens || 8000) || 8000))
    };
}

function updateMemoryMaintenanceSettings(db, body = {}) {
    const patch = normalizeMemoryMaintenanceSettingsPatch(body);
    db.updateUserProfile?.(patch);
    return getMemoryMaintenanceSettings(db);
}

function normalizeManualMemoryPatch(body = {}) {
    const now = Date.now();
    const patch = {};
    const setString = (field, maxLen = 2000) => {
        if (!Object.prototype.hasOwnProperty.call(body, field)) return;
        patch[field] = String(body[field] ?? '').trim().slice(0, maxLen);
    };
    setString('summary', 1000);
    setString('content', 4000);
    setString('event', 1000);
    setString('consolidation_summary', 2000);
    setString('consolidation_key', 160);
    setString('source_app', 80);
    setString('time', 240);
    setString('location', 240);
    setString('emotion', 500);
    if (Object.prototype.hasOwnProperty.call(body, 'memory_focus')) {
        const value = String(body.memory_focus || '').trim();
        if (!MEMORY_MAINTENANCE_FOCUS.has(value)) {
            const error = new Error(`Invalid memory_focus: ${value}`);
            error.status = 400;
            throw error;
        }
        patch.memory_focus = value;
    }
    if (Object.prototype.hasOwnProperty.call(body, 'memory_tier')) {
        const value = String(body.memory_tier || '').trim();
        if (!MEMORY_MAINTENANCE_TIERS.has(value)) {
            const error = new Error(`Invalid memory_tier: ${value}`);
            error.status = 400;
            throw error;
        }
        patch.memory_tier = value;
    }
    if (Object.prototype.hasOwnProperty.call(body, 'source_context')) {
        const value = String(body.source_context || '').trim();
        if (value && !MEMORY_SOURCE_CONTEXTS.has(value)) {
            const error = new Error(`Invalid source_context: ${value}`);
            error.status = 400;
            throw error;
        }
        patch.source_context = value;
    }
    if (Object.prototype.hasOwnProperty.call(body, 'scene_tag')) {
        const value = String(body.scene_tag || '').trim();
        if (value && !MEMORY_SCENE_TAGS.has(value)) {
            const error = new Error(`Invalid scene_tag: ${value}`);
            error.status = 400;
            throw error;
        }
        patch.scene_tag = value;
    }
    if (Object.prototype.hasOwnProperty.call(body, 'importance')) {
        patch.importance = clampNumber(body.importance, 5, 1, 10);
    }
    if (Object.prototype.hasOwnProperty.call(body, 'is_archived')) {
        patch.is_archived = parseBooleanFlag(body.is_archived) ? 1 : 0;
    }
    if (Object.keys(patch).length === 0) {
        const error = new Error('No editable memory fields provided.');
        error.status = 400;
        throw error;
    }
    patch.maintenance_status = 'classified';
    patch.classification_source = 'manual-edit';
    patch.classified_at = now;
    patch.updated_at = now;
    return patch;
}

function buildMemoryIndexTargets(db, rows = []) {
    const targetsByMemoryId = new Map();
    const ids = Array.from(new Set((Array.isArray(rows) ? rows : [])
        .map(row => Number(row?.id || 0))
        .filter(id => id > 0)));

    for (const row of rows || []) {
        const memoryId = Number(row?.id || 0);
        if (!memoryId) continue;
        const targets = targetsByMemoryId.get(memoryId) || new Map();
        const characterId = String(row?.character_id || '').trim();
        if (characterId) {
            targets.set(characterId, {
                characterId,
                previousRow: { ...row }
            });
        }
        targetsByMemoryId.set(memoryId, targets);
    }

    const rawDb = typeof db?.getRawDb === 'function' ? db.getRawDb() : null;
    if (rawDb && ids.length > 0) {
        try {
            const placeholders = ids.map(() => '?').join(',');
            const bindings = rawDb.prepare(`
                SELECT memory_id, character_id, character_name
                FROM external_memory_role_bindings
                WHERE memory_id IN (${placeholders})
            `).all(...ids);
            const rowsById = new Map((rows || []).map(row => [Number(row?.id || 0), row]));
            for (const binding of bindings || []) {
                const memoryId = Number(binding.memory_id || 0);
                const characterId = String(binding.character_id || '').trim();
                if (!memoryId || !characterId) continue;
                const sourceRow = rowsById.get(memoryId) || {};
                const targets = targetsByMemoryId.get(memoryId) || new Map();
                targets.set(characterId, {
                    characterId,
                    previousRow: {
                        ...sourceRow,
                        shared_binding: 1,
                        bound_character_id: characterId,
                        bound_character_name: String(binding.character_name || '')
                    }
                });
                targetsByMemoryId.set(memoryId, targets);
            }
        } catch (e) {
            console.warn('[Memory] Failed to read external memory role bindings for index cleanup:', e.message);
        }
    }

    return targetsByMemoryId;
}

function rescueMemoryMaintenanceItems(rawDb, ids = []) {
    const safeIds = Array.from(new Set((Array.isArray(ids) ? ids : [])
        .map(id => Number(id || 0))
        .filter(id => id > 0)))
        .slice(0, 200);
    if (safeIds.length === 0) return { rescued: 0, characterIds: [] };
    const now = Date.now();
    const rows = rawDb.prepare(`SELECT id, character_id, memory_tier, importance FROM memories WHERE id IN (${safeIds.map(() => '?').join(', ')})`).all(...safeIds);
    const stmt = rawDb.prepare(`
        UPDATE memories
        SET is_archived = 0,
            memory_tier = CASE WHEN COALESCE(memory_tier, 'ambient') = 'ambient' THEN 'active' ELSE memory_tier END,
            importance = CASE WHEN COALESCE(importance, 0) < 5 THEN 5 ELSE importance END,
            maintenance_status = 'needs_review',
            classification_source = 'manual-rescue',
            classified_at = ?,
            retention_score = 1,
            retention_action = 'keep',
            retention_reason = 'rescued_by_user',
            retention_checked_at = ?,
            last_retrieved_at = ?,
            archive_reason = '',
            forgetting_grace_started_at = 0,
            forgetting_grace_expires_at = 0,
            updated_at = ?
        WHERE id = ?
    `);
    const tx = rawDb.transaction((items) => {
        for (const row of items) stmt.run(now, now, now, now, row.id);
    });
    tx(rows);
    return {
        rescued: rows.length,
        characterIds: Array.from(new Set(rows.map(row => String(row.character_id || '')).filter(Boolean)))
    };
}

// Initialize the Database schemas


// Setup Server and WebSockets
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const userWsClients = new Map();
const memoryMaintenanceRuns = new Map();

function getWsClients(userId) {
    if (!userWsClients.has(userId)) {
        userWsClients.set(userId, new Set());
    }
    return userWsClients.get(userId);
}

function broadcastToWsClients(clients, message) {
    if (!clients) return;
    const payload = JSON.stringify(message);
    clients.forEach(client => {
        if (client.readyState === 1) client.send(payload);
    });
}

function getMemoryMaintenanceRunSnapshot(run) {
    if (!run) return null;
    return {
        run_id: run.run_id,
        user_id: run.user_id,
        characterId: run.characterId,
        character: run.character,
        task_mode: run.task_mode || '',
        import_id: run.import_id || null,
        source_app: run.source_app || '',
        import_mode: run.import_mode || '',
        filename: run.filename || '',
        continue_from_offset: run.continue_from_offset || 0,
        total_messages: run.total_messages || 0,
        phase: run.phase || 'queued',
        running: !!run.running,
        success: run.success,
        limit: run.limit,
        max_batches: run.max_batches,
        run_until_empty: run.run_until_empty,
        max_rerolls: run.max_rerolls,
        batch_number: run.batch_number || 0,
        attempt: run.attempt || 0,
        reroll: run.reroll || 0,
        processed: run.processed || 0,
        updated: run.updated || 0,
        applied_errors: run.applied_errors || 0,
        remaining_pending_after_batch: run.remaining_pending_after_batch,
        pending_before: run.pending_before,
        stopped_reason: run.stopped_reason || '',
        can_continue: !!run.can_continue,
        continue_from: run.continue_from || null,
        message: run.message || '',
        new_memory_samples: run.new_memory_samples || [],
        errors: run.errors || [],
        stats: run.stats || null,
        started_at: run.started_at,
        updated_at: run.updated_at,
        finished_at: run.finished_at || 0,
        events: (run.events || []).slice(-30)
    };
}

function findActiveMemoryMaintenanceRun(userId, characterId = '') {
    for (const run of memoryMaintenanceRuns.values()) {
        if (String(run.user_id) !== String(userId)) continue;
        if (!run.running) continue;
        if (characterId && String(run.characterId) !== String(characterId)) continue;
        return run;
    }
    return null;
}

function pruneMemoryMaintenanceRuns() {
    const cutoff = Date.now() - 6 * 60 * 60 * 1000;
    for (const [runId, run] of memoryMaintenanceRuns.entries()) {
        if (!run.running && Number(run.finished_at || run.updated_at || 0) < cutoff) {
            memoryMaintenanceRuns.delete(runId);
        }
    }
}

// Inject the global WS resolver into memory.js so it can broadcast without circular dependencies
setWsClientsResolver(getWsClients);

wss.on('connection', (ws) => {
    console.log('[WS] Frontend client connected.');

    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            if (data.type === 'auth') {
                const { user } = verifyAuthToken(data.token);
                ws.userId = user.id;
                authDb.updateLastActive(user.id);
                const clients = getWsClients(user.id);
                clients.add(ws);
                const engine = getEngineWithPluginHooks(user.id);
                engine.startEngine(clients);
                engine.startGroupProactiveTimers(clients);
                console.log(`[WS] Authenticated frontend socket for user: ${user.username}`);
            }
        } catch (e) {
            console.error('[WS] Auth or Engine Start Error:', e.message);
            try { ws.close(1008, 'Unauthorized'); } catch { /* ignore */ }
        }
    });

    ws.on('close', () => {
        console.log('[WS] Frontend client disconnected.');
        if (ws.userId) {
            getWsClients(ws.userId).delete(ws);
        }
    });
});



// AUTHENTICATION MIDDLEWARE
authDb.initAuthDb();

function createAuthError(message, statusCode = 401) {
    const error = new Error(message);
    error.statusCode = statusCode;
    return error;
}

function verifyAuthToken(token) {
    if (!token) throw createAuthError('Unauthorized');
    const decoded = jwt.verify(token, JWT_SECRET);
    const authUser = authDb.getUserById(decoded.id);
    if (!authUser) throw createAuthError('Invalid token');
    if (authUser.status === 'banned') throw createAuthError('Account banned', 403);
    if (Number(decoded.tokenVersion ?? 0) !== Number(authUser.token_version ?? 0)) {
        throw createAuthError('Session expired');
    }
    return {
        decoded,
        authUser,
        user: {
            id: authUser.id,
            username: authUser.username,
            role: authUser.role || decoded.role || 'user',
            status: authUser.status || 'active',
            tokenVersion: authUser.token_version || 0
        }
    };
}

const authMiddleware = (req, res, next) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    const token = authHeader.split(' ')[1];
    try {
        const { user } = verifyAuthToken(token);
        req.user = user;
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
        return res.status(e.statusCode || 401).json({ error: e.statusCode ? e.message : 'Invalid token' });
    }
};

// 0. Upload a profile/avatar image
app.post('/api/upload', authMiddleware, (req, res) => {
    upload.single('image')(req, res, function (err) {
        if (err instanceof multer.MulterError) {
            // A Multer error occurred when uploading (e.g. file too large)
            return res.status(400).json({ error: err.message });
        } else if (err) {
            // An unknown error occurred (e.g. our custom fileFilter threw an error)
            return res.status(400).json({ error: err.message });
        }

        try {
            const file = req.file;
            if (!file) {
                return res.status(400).json({ error: 'No file uploaded' });
            }
            if (!isValidImageUploadContent(file)) {
                cleanupUploadedFile(file);
                return res.status(400).json({ error: 'Invalid image content. Upload a PNG, JPEG, GIF, or WebP image.' });
            }
            // Return relative path so frontend can construct absolute URL or use it directly
            const fileUrl = `/uploads/${file.filename}`;
            res.json({ success: true, url: fileUrl });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });
});

// AUTH ROUTES
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

// SYSTEM ROUTES
app.get('/api/system/announcement', authMiddleware, (req, res) => {
    try {
        const ann = authDb.getLatestAnnouncement();
        res.json({ success: true, announcement: ann });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});


// PLUGIN MANAGER
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
// ---------------------------------------------------------------------------

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
                    SUM(CASE WHEN COALESCE(NULLIF(consolidation_summary, ''), '') <> '' THEN 1 ELSE 0 END) AS memories_count,
                    COUNT(*) AS legacy_memories_count,
                    SUM(CASE WHEN COALESCE(NULLIF(consolidation_summary, ''), '') <> '' AND embedding IS NOT NULL AND length(embedding) > 0 THEN 1 ELSE 0 END) AS embedded_count,
                    SUM(CASE WHEN COALESCE(NULLIF(consolidation_summary, ''), '') <> '' AND COALESCE(is_archived, 0) = 1 THEN 1 ELSE 0 END) AS archived_count,
                    SUM(CASE WHEN COALESCE(NULLIF(consolidation_summary, ''), '') <> '' THEN 1 ELSE 0 END) AS structured_count,
                    COUNT(DISTINCT CASE WHEN COALESCE(NULLIF(consolidation_summary, ''), '') <> '' THEN character_id END) AS characters_with_memories,
                    SUM(CASE WHEN COALESCE(NULLIF(consolidation_summary, ''), '') <> '' AND (COALESCE(last_retrieved_at, 0) > 0 OR COALESCE(retrieval_count, 0) > 0) THEN 1 ELSE 0 END) AS ever_retrieved_count,
                    COALESCE(SUM(CASE WHEN COALESCE(NULLIF(consolidation_summary, ''), '') <> '' THEN COALESCE(retrieval_count, 0) ELSE 0 END), 0) AS total_retrievals,
                    MAX(CASE WHEN COALESCE(NULLIF(consolidation_summary, ''), '') <> '' THEN COALESCE(updated_at, created_at, 0) ELSE 0 END) AS last_memory_at,
                    MAX(CASE WHEN COALESCE(NULLIF(consolidation_summary, ''), '') <> '' THEN COALESCE(last_retrieved_at, 0) ELSE 0 END) AS last_retrieved_at
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
            legacyMemoriesCount: Number(summaryRow?.legacy_memories_count || 0),
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

app.get('/api/memory-maintenance/settings', authMiddleware, (req, res) => {
    try {
        res.json({ success: true, settings: getMemoryMaintenanceSettings(req.db) });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.put('/api/memory-maintenance/settings', authMiddleware, (req, res) => {
    try {
        res.json({ success: true, settings: updateMemoryMaintenanceSettings(req.db, req.body || {}) });
    } catch (e) {
        res.status(e.status || 500).json({ error: e.message });
    }
});

app.get('/api/memory-maintenance/overview', authMiddleware, (req, res) => {
    try {
        const rawDb = typeof req.db.getRawDb === 'function' ? req.db.getRawDb() : null;
        if (!rawDb) return res.status(500).json({ error: 'Raw database handle is unavailable.' });
        res.json({
            success: true,
            settings: getMemoryMaintenanceSettings(req.db),
            overview: getMemoryMaintenanceOverview(rawDb)
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/memory-maintenance/library', authMiddleware, (req, res) => {
    try {
        const rawDb = typeof req.db.getRawDb === 'function' ? req.db.getRawDb() : null;
        if (!rawDb) return res.status(500).json({ error: 'Raw database handle is unavailable.' });
        const options = normalizeMemoryMaintenanceLibraryOptions(req.query || {});
        if (options.character_id && !req.db.getCharacter(options.character_id)) {
            return res.status(404).json({ success: false, error: 'Character not found' });
        }
        res.json({
            success: true,
            library: getMemoryMaintenanceLibrary(rawDb, options)
        });
    } catch (e) {
        res.status(e.status || 500).json({ error: e.message });
    }
});

app.post('/api/memory-maintenance/rescue', authMiddleware, async (req, res) => {
    try {
        const rawDb = typeof req.db.getRawDb === 'function' ? req.db.getRawDb() : null;
        if (!rawDb) return res.status(500).json({ error: 'Raw database handle is unavailable.' });
        const result = rescueMemoryMaintenanceItems(rawDb, req.body?.ids || []);
        const rebuilt = [];
        if (parseBooleanFlag(req.query.rebuild_index ?? req.body?.rebuild_index)) {
            for (const characterId of result.characterIds) {
                try {
                    await req.memory.rebuildIndex(characterId);
                    rebuilt.push(characterId);
                } catch (e) {
                    console.error(`[Memory Maintenance] Failed to rebuild rescued memory index for ${characterId}:`, e.message);
                }
            }
        }
        const wsClients = getWsClients(req.user.id);
        result.characterIds.forEach(characterId => {
            wsClients.forEach(c => {
                if (c.readyState === 1) c.send(JSON.stringify({ type: 'memory_update', characterId }));
            });
        });
        res.json({
            success: true,
            rescued: result.rescued,
            characterIds: result.characterIds,
            rebuilt,
            overview: getMemoryMaintenanceOverview(rawDb)
        });
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
        // Changing S only changes future batch size; keep summaries/baseline so failed pending messages stay pending.
        if (prevCharacter && Object.prototype.hasOwnProperty.call(data, 'context_msg_limit')) {
            const prevLimit = Number(prevCharacter.context_msg_limit || 60);
            const nextLimit = Number(data.context_msg_limit || prevLimit);
            if (prevLimit !== nextLimit) {
                db.clearConversationDigest?.(data.id);
                const rawDb = typeof db.getRawDb === 'function' ? db.getRawDb() : null;
                rawDb?.prepare('DELETE FROM history_window_cache WHERE character_id = ?').run(data.id);
                rawDb?.prepare('DELETE FROM private_context_summaries WHERE character_id = ?').run(data.id);
                const nextCharacter = typeof db.getCharacter === 'function' ? db.getCharacter(data.id) : null;
                const rawWindow = Math.max(0, Number(nextCharacter?.context_msg_limit || 60) || 60);
                const visibleMessages = db.getVisibleMessages(data.id, 0) || [];
                const overflowMessages = rawWindow > 0 ? visibleMessages.slice(0, Math.max(0, visibleMessages.length - rawWindow)) : visibleMessages;
                db.updateCharacter(data.id, { private_summary_baseline_message_id: Number(overflowMessages[overflowMessages.length - 1]?.id || 0) });
            }
        }
        // Reset proactive timer after settings change. Do NOT call handleUserMessage here;
        // that would echo the character's own last message back to the AI as user input.
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
        if (!prevCharacter) return res.status(404).json({ error: 'Character not found' });

        db.updateCharacter(id, data);
        // Changing S only changes future batch size; keep summaries/baseline so failed pending messages stay pending.
        if (prevCharacter && Object.prototype.hasOwnProperty.call(data, 'context_msg_limit')) {
            const prevLimit = Number(prevCharacter.context_msg_limit || 60);
            const nextLimit = Number(data.context_msg_limit || prevLimit);
            if (prevLimit !== nextLimit) {
                db.clearConversationDigest?.(id);
                const rawDb = typeof db.getRawDb === 'function' ? db.getRawDb() : null;
                rawDb?.prepare('DELETE FROM history_window_cache WHERE character_id = ?').run(id);
                rawDb?.prepare('DELETE FROM private_context_summaries WHERE character_id = ?').run(id);
                const nextCharacter = typeof db.getCharacter === 'function' ? db.getCharacter(id) : null;
                const rawWindow = Math.max(0, Number(nextCharacter?.context_msg_limit || 60) || 60);
                const visibleMessages = db.getVisibleMessages(id, 0) || [];
                const overflowMessages = rawWindow > 0 ? visibleMessages.slice(0, Math.max(0, visibleMessages.length - rawWindow)) : visibleMessages;
                db.updateCharacter(id, { private_summary_baseline_message_id: Number(overflowMessages[overflowMessages.length - 1]?.id || 0) });
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

async function handleModelListProxy(req, res, source) {
    try {
        const { endpoint, key } = source || {};
        if (!endpoint || !key) return res.status(400).json({ error: 'Missing endpoint or key' });

        let baseUrl = endpoint.endsWith('/') ? endpoint.slice(0, -1) : endpoint;
        if (baseUrl.endsWith('/chat/completions')) baseUrl = baseUrl.slice(0, -'/chat/completions'.length);
        const modelsUrl = `${baseUrl}/models`;
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 18000);

        let response;
        try {
            response = await fetch(modelsUrl, {
                headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
                signal: controller.signal
            });
        } catch (fetchError) {
            if (fetchError?.name === 'AbortError') return res.status(504).json({ error: '请求超时' });
            throw fetchError;
        } finally {
            clearTimeout(timeoutId);
        }
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
}

// 2.5 Fetch available models from a given API endpoint (proxy to avoid CORS + key exposure in browser)
app.post('/api/models', authMiddleware, async (req, res) => {
    return handleModelListProxy(req, res, req.body);
});

// Legacy GET shape kept for compatibility, but it is still authenticated.
app.get('/api/models', authMiddleware, async (req, res) => {
    return handleModelListProxy(req, res, req.query);
});

// 3. Get messages for a character (supports ?limit=N and ?before=msgId for pagination)
app.get('/api/messages/:characterId', authMiddleware, (req, res) => {
    const db = req.db;
    try {
        const charId = req.params.characterId;
        const charObj = db.getCharacter(charId);
        if (!charObj) return res.status(404).json({ error: 'Character not found' });
        const limit = normalizeQueryLimit(req.query.limit, 100, 200);
        if (!limit) return res.status(400).json({ error: 'Invalid message limit' });
        const before = req.query.before !== undefined && req.query.before !== null && String(req.query.before).trim() !== ''
            ? Number(req.query.before)
            : 0;  // message ID cursor for older messages
        if (req.query.before !== undefined && (!Number.isSafeInteger(before) || before <= 0)) {
            return res.status(400).json({ error: 'Invalid before cursor' });
        }

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
        const charObj = db.getCharacter(req.params.characterId);
        if (!charObj) return res.status(404).json({ error: 'Character not found' });
        const limit = normalizeQueryLimit(req.query.limit, 50, 100);
        if (!limit) return res.status(400).json({ error: 'Invalid emotion log limit' });
        const logs = typeof db.getEmotionLogs === 'function'
            ? db.getEmotionLogs(charObj.id, limit)
            : [];
        res.json({ success: true, logs });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/characters/:characterId/llm-debug-logs', authMiddleware, (req, res) => {
    const db = req.db;
    try {
        const charObj = db.getCharacter(req.params.characterId);
        if (!charObj) return res.status(404).json({ error: 'Character not found' });
        const limit = normalizeQueryLimit(req.query.limit, 50, 200);
        if (!limit) return res.status(400).json({ error: 'Invalid LLM debug log limit' });
        const logs = typeof db.getLlmDebugLogs === 'function'
            ? db.getLlmDebugLogs(charObj.id, limit)
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
        if (!charObj) return res.status(404).json({ error: 'Character not found' });

        // If character has blocked the user, save message but return blocked flag
        if (charObj.is_blocked) {
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
        const charObj = db.getCharacter(characterId);
        if (!charObj) return res.status(404).json({ error: 'Character not found' });
        const requestId = createRequestTraceId('retry');
        let retryEvent = null;

        if (failedMessageId) {
            const failedMessage = db.getMessages(characterId, 200)
                .find((msg) => String(msg.id) === String(failedMessageId));
            const metadata = failedMessage?.metadata && typeof failedMessage.metadata === 'object'
                ? failedMessage.metadata
                : null;
            retryEvent = metadata?.systemEventReply || null;
            if (failedMessage) db.deleteMessage(failedMessage.id, characterId);
        }

        if (retryEvent?.extraSystemDirective) {
            engine.triggerImmediateUserReply(characterId, wsClients, {
                useRetryResume: false,
                extraSystemDirective: retryEvent.extraSystemDirective,
                extraDirectiveRole: retryEvent.extraDirectiveRole || 'system',
                eventUserDirective: retryEvent.eventUserDirective || '',
                markSystemEventReply: false,
                triggerSource: 'api_retry_system_event',
                triggerRoute: 'POST /api/messages/:characterId/retry',
                requestId,
                triggerNote: failedMessageId ? `retry_system_event_message_${failedMessageId}` : 'retry_system_event',
                skipTopicSwitchGate: !!retryEvent.skipTopicSwitchGate,
                skipContextModuleRouting: !!retryEvent.skipContextModuleRouting
            }).catch((err) => {
                console.error('[Retry] System event retry failed:', err.message);
            });
            return res.json({ success: true, retriedSystemEvent: true });
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

app.get('/api/tts/audio/:messageId', authMiddleware, (req, res) => {
    const db = req.db;
    try {
        const row = db.getMessageTts?.(req.params.messageId);
        if (!row || row.status !== 'ready' || !row.audio_path) {
            return res.status(404).json({ error: 'TTS audio not found.' });
        }
        const messageCharId = db.getMessageCharacterId?.(req.params.messageId);
        if (!messageCharId) {
            return res.status(404).json({ error: 'TTS audio not found.' });
        }
        if (messageCharId && String(messageCharId) !== String(row.character_id)) {
            return res.status(403).json({ error: 'TTS audio does not match message.' });
        }
        const audioPath = resolveTtsAudioPath(req.user.id, row.audio_path);
        if (!audioPath) {
            return res.status(404).json({ error: 'TTS audio not found.' });
        }
        if (!fs.existsSync(audioPath)) {
            return res.status(404).json({ error: 'TTS audio file is missing.' });
        }
        res.setHeader('Content-Type', sanitizeTtsMimeType(row.mime_type));
        res.setHeader('Cache-Control', 'private, max-age=86400');
        res.sendFile(audioPath);
    } catch (e) {
        res.status(e.status || 500).json({ error: e.message });
    }
});

app.get('/api/tts/tencent/voices', authMiddleware, async (req, res) => {
    try {
        const result = await getTencentVoiceList({ forceRefresh: req.query.refresh === '1' });
        res.json({ success: true, ...result });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/tts/preview/:characterId', authMiddleware, async (req, res) => {
    const db = req.db;
    try {
        const character = db.getCharacter(req.params.characterId);
        if (!character) return res.status(404).json({ error: 'Character not found.' });
        const overrides = req.body?.config && typeof req.body.config === 'object' ? req.body.config : req.body || {};
        const enabled = overrides.tts_enabled !== undefined ? Number(overrides.tts_enabled || 0) === 1 : Number(character.tts_enabled || 0) === 1;
        if (!enabled) {
            return res.status(400).json({ error: 'TTS is not enabled for this character.' });
        }
        const previewCharacter = {
            ...character,
            tts_provider: overrides.tts_provider ?? character.tts_provider,
            tts_api_key: overrides.tts_api_key ?? character.tts_api_key,
            tts_voice: overrides.tts_voice ?? character.tts_voice,
            tts_model: overrides.tts_model ?? character.tts_model,
            tts_endpoint: overrides.tts_endpoint ?? character.tts_endpoint
        };
        const text = String(req.body?.text || `你好，我是${character.name || '这个角色'}。这是一段试听。`).trim().slice(0, 160);
        const audio = await synthesizeSpeech({
            character: previewCharacter,
            text,
            intent: { style: 'preview', reason: 'settings preview', priority: 1 }
        });
        res.setHeader('Content-Type', audio.mimeType || 'audio/mpeg');
        res.setHeader('Cache-Control', 'no-store');
        res.send(audio.buffer);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/debug/reply-dispatch/:characterId', authMiddleware, (req, res) => {
    const db = req.db;
    try {
        const { characterId } = req.params;
        const limit = normalizeQueryLimit(req.query.limit, 50, 200);
        if (!limit) return res.status(400).json({ error: 'Invalid reply dispatch log limit' });
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
        const ids = Array.from(new Set((Array.isArray(messageIds) ? messageIds : [])
            .map(id => Number(id || 0))
            .filter(id => Number.isSafeInteger(id) && id > 0)))
            .slice(0, 500);
        if (ids.length === 0) {
            return res.status(400).json({ error: 'messageIds array required' });
        }
        const requestedCharacterId = String(req.body?.characterId || '').trim();
        const affectedCharacterIds = new Set();
        let deleted = 0;
        for (const id of ids) {
            const characterId = db.getMessageCharacterId?.(id);
            if (!characterId) continue;
            if (requestedCharacterId && String(characterId) !== requestedCharacterId) continue;
            const changes = db.deleteMessage(id, characterId);
            if (changes > 0) {
                affectedCharacterIds.add(characterId);
                deleted += changes;
            }
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
        const transferAmount = normalizePositiveMoney(amount);
        if (!transferAmount) return res.status(400).json({ error: 'Invalid amount' });
        const transferNote = normalizePaymentNote(note, 'Transfer');
        if (transferNote === null) return res.status(400).json({ error: 'Invalid note' });
        let tid;
        try {
            tid = db.createTransfer({
                charId: characterId,
                senderId: 'user',
                recipientId: characterId,
                amount: transferAmount,
                note: transferNote,
                messageId: null
            });
        } catch (e) {
            return res.status(400).json({ error: e.message });
        }

        // Add user transfer message to DB
        const transferText = `[TRANSFER]${tid}|${transferAmount}|${transferNote}`;
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

function parseGeneratedCharacterReply(replyText) {
    const cleanText = String(replyText || '')
        .replace(/```(?:json)?\s*/gi, '')
        .replace(/```/g, '')
        .trim();
    if (!cleanText) throw new Error('LLM did not return a valid JSON object. Check Server Logs.');
    const parsed = JSON.parse(cleanText);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('Generated character must be a JSON object.');
    }
    return parsed;
}

function requireGeneratedCharacterText(value, field, maxLength = 6000) {
    const text = String(value || '').trim();
    if (!text) throw new Error(`Generated character is missing ${field}.`);
    return text.slice(0, maxLength);
}

function requireGeneratedCharacterInteger(value, field, min, max) {
    if (!Number.isSafeInteger(value) || value < min || value > max) {
        throw new Error(`Generated character has invalid ${field}.`);
    }
    return value;
}

function normalizeGeneratedCharacterPayload(parsed) {
    const intervalMin = requireGeneratedCharacterInteger(parsed.interval_min, 'interval_min', 1, 10080);
    const intervalMax = requireGeneratedCharacterInteger(parsed.interval_max, 'interval_max', 1, 10080);
    if (intervalMax < intervalMin) {
        throw new Error('Generated character has invalid interval range.');
    }
    return {
        name: requireGeneratedCharacterText(parsed.name, 'name', 80),
        persona: requireGeneratedCharacterText(parsed.persona, 'persona'),
        world_info: requireGeneratedCharacterText(parsed.world_info, 'world_info'),
        affinity: requireGeneratedCharacterInteger(parsed.affinity, 'affinity', 0, 100),
        sys_pressure: requireGeneratedCharacterInteger(parsed.sys_pressure, 'sys_pressure', 0, 1),
        sys_jealousy: requireGeneratedCharacterInteger(parsed.sys_jealousy, 'sys_jealousy', 0, 1),
        interval_min: intervalMin,
        interval_max: intervalMax,
        target_emoji: requireGeneratedCharacterText(parsed.target_emoji, 'target_emoji', 16)
    };
}

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

        console.log(`[Character Generator] LLM returned ${String(generatedText || '').length} chars.`);

        let parsed;
        try {
            parsed = normalizeGeneratedCharacterPayload(parseGeneratedCharacterReply(generatedText));
        } catch (err) {
            console.error(`[Character Generator] JSON validation failed. responseLength=${String(generatedText || '').length}`);
            throw new Error('LLM JSON Syntax Error: ' + err.message);
        }

        // Set local integration fields only after the generated payload validates.
        parsed.avatar = buildDefaultAvatarUrl(parsed.name);
        parsed.api_endpoint = api_endpoint;
        parsed.api_key = api_key;
        parsed.model_name = model_name;
        parsed.sys_timer = 1;
        parsed.sys_proactive = 1;
        parsed.emoji = parsed.target_emoji;
        delete parsed.target_emoji;

        return res.json({ success: true, character: parsed });
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
        const character = typeof db.getCharacter === 'function' ? db.getCharacter(characterId) : null;
        if (!character) return res.status(404).json({ error: 'Character not found' });
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
        const char = db.getCharacter(id);
        if (!char) return res.status(404).json({ error: 'Character not found' });

        // Stop the engine timer first to minimize the race-condition window.
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

// 4.8 EXPORT: Export character data (settings, messages, memories, moments, diaries)
app.get('/api/data/:characterId/export', authMiddleware, (req, res) => {
    const db = req.db;
    const engine = req.engine;
    const memory = req.memory;
    const wsClients = getWsClients(req.user.id);
    try {
        const data = db.exportCharacterData(req.params.characterId);
        if (!data) return res.status(404).json({ error: 'Character not found' });
        const archive = {
            format: 'chatpulse.character.v2',
            exported_at: Date.now(),
            character_id: req.params.characterId,
            qdrant: {
                strategy: 'rebuild_from_sqlite_memories_on_import',
                collection: qdrant.getCollectionName(req.user.id),
                exported_points: false
            },
            ...data
        };
        const filenameBase = sanitizeDownloadName(data.character?.name || req.params.characterId, req.params.characterId);
        const filenameId = sanitizeDownloadName(req.params.characterId, 'character');

        // Return as a downloadable JSON file
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Content-Disposition', `attachment; filename="${filenameBase}_${filenameId}_character_export.json"`);
        res.send(JSON.stringify(archive, null, 2));
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/data/:characterId/import', authMiddleware, (req, res) => {
    memoryImportUpload.any()(req, res, async function (err) {
        if (err instanceof multer.MulterError) {
            return res.status(400).json({ error: err.message });
        }
        if (err) {
            return res.status(400).json({ error: err.message });
        }

        const db = req.db;
        const memory = req.memory;
        const engine = req.engine;
        try {
            const characterId = req.params.characterId;
            const payload = parseCharacterArchiveRequest(req);
            const existing = db.getCharacter(characterId);
            const mode = String(req.query.mode ?? req.body?.mode ?? '').trim().toLowerCase();
            const merge = mode === 'merge' || parseBooleanFlag(req.query.merge ?? req.body?.merge);
            const replace = !merge && (mode === '' || mode === 'replace' || parseBooleanFlag(req.query.replace ?? req.body?.replace));
            const includeCharacter = !parseBooleanFlag(req.query.skip_character ?? req.body?.skip_character);
            if (!existing && (!includeCharacter || !payload.character)) {
                return res.status(404).json({ error: 'Target character does not exist, and the archive cannot create it with the current import options.' });
            }
            if (!existing && !String(payload.character?.name || '').trim()) {
                return res.status(400).json({ error: 'Archive character name is required to create a missing target character.' });
            }
            const rawDb = typeof db.getRawDb === 'function' ? db.getRawDb() : null;
            if (!rawDb) return res.status(500).json({ error: 'Raw database handle is unavailable.' });

            if (typeof engine?.stopTimer === 'function') {
                engine.stopTimer(characterId);
            }

            const importTransaction = rawDb.transaction(() => {
                if (includeCharacter && payload.character) {
                    db.updateCharacter(characterId, { ...payload.character, id: characterId });
                }
                if (replace) {
                    clearCharacterArchiveData(rawDb, characterId);
                } else {
                    runArchiveCleanup(rawDb, 'DELETE FROM history_window_cache WHERE character_id = ?', characterId);
                    runArchiveCleanup(rawDb, 'DELETE FROM prompt_block_cache WHERE character_id = ?', characterId);
                    runArchiveCleanup(rawDb, 'DELETE FROM conversation_digest_cache WHERE character_id = ?', characterId);
                    runArchiveCleanup(rawDb, 'DELETE FROM llm_cache WHERE character_id = ? OR cache_scope = ?', characterId, `character:${characterId}`);
                }
                return importCharacterArchiveRows(rawDb, characterId, payload);
            });

            const imported = importTransaction();
            let rebuiltMemoryIndex = false;
            let rebuildWarning = '';
            try {
                await memory.rebuildIndex(characterId);
                rebuiltMemoryIndex = true;
            } catch (e) {
                rebuildWarning = e.message || 'Memory index rebuild failed.';
                console.error(`[Character Import] Failed to rebuild memory index for ${characterId}:`, rebuildWarning);
            }

            const wsClients = getWsClients(req.user.id);
            wsClients.forEach(c => {
                if (c.readyState === 1) {
                    c.send(JSON.stringify({ type: 'memory_update', characterId }));
                }
            });

            res.json({
                success: true,
                characterId,
                mode: replace ? 'replace' : 'merge',
                imported,
                rebuiltMemoryIndex,
                qdrant: {
                    strategy: 'rebuilt_from_imported_sqlite_memories',
                    rebuilt: rebuiltMemoryIndex,
                    warning: rebuildWarning
                }
            });
        } catch (e) {
            console.error('Character archive import failed:', e);
            res.status(e.status || 500).json({ error: e.message });
        }
    });
});

function normalizeMemorySourceRef(value) {
    const raw = String(value || '').trim();
    if (!raw) return { raw, kind: 'unknown', id: 0, key: 'unknown:' };
    const externalImport = raw.match(/^external[-_]?import:(\d+):([A-Za-z0-9_-]+)$/i);
    if (externalImport) {
        const importId = Number(externalImport[1] || 0);
        const candidateId = String(externalImport[2] || '').trim();
        return {
            raw,
            kind: 'external_app',
            id: importId,
            import_id: importId,
            candidate_id: candidateId,
            key: `external_app:${importId}:${candidateId}`
        };
    }
    const prefixed = raw.match(/^([a-z_-]+):(.+)$/i);
    const prefix = prefixed ? String(prefixed[1] || '').toLowerCase() : '';
    const idText = prefixed ? String(prefixed[2] || '').trim() : raw;
    const id = Number(idText);
    if (!Number.isFinite(id) || id <= 0) {
        return { raw, kind: 'unknown', id: 0, key: `unknown:${raw}` };
    }
    if (prefix === 'group') return { raw, kind: 'group_chat', id, key: `group_chat:${id}` };
    if (prefix === 'city') return { raw, kind: 'commercial_street', id, key: `commercial_street:${id}` };
    return { raw, kind: 'private_chat', id, key: `private_chat:${id}` };
}

function buildMemorySourcePayload(rawDb, refs = []) {
    const privateStmt = rawDb.prepare('SELECT id, character_id, role, content, timestamp FROM messages WHERE id = ?');
    const groupStmt = rawDb.prepare('SELECT id, group_id, sender_id, sender_name, content, timestamp FROM group_messages WHERE id = ?');
    const cityStmt = rawDb.prepare('SELECT id, character_id, action_type, content, location, timestamp FROM city_logs WHERE id = ?');
    const characterStmt = rawDb.prepare('SELECT name FROM characters WHERE id = ?');
    let externalImportStmt = null;
    try {
        externalImportStmt = rawDb.prepare('SELECT * FROM external_memory_imports WHERE id = ?');
    } catch (e) {
        externalImportStmt = null;
    }
    const characterNameCache = new Map();
    const getCharacterName = (characterId) => {
        const key = String(characterId || '');
        if (!key) return '';
        if (!characterNameCache.has(key)) {
            characterNameCache.set(key, characterStmt.get(key)?.name || key);
        }
        return characterNameCache.get(key);
    };

    return refs.map(ref => {
        if (ref.kind === 'private_chat') {
            const row = privateStmt.get(ref.id);
            if (row) {
                return {
                    source_key: ref.key,
                    raw_ref: ref.raw,
                    kind: ref.kind,
                    id: row.id,
                    character_id: row.character_id,
                    speaker: row.role === 'user' ? 'User' : getCharacterName(row.character_id),
                    role: row.role || '',
                    timestamp: Number(row.timestamp || 0),
                    content: row.content || '',
                    found: true
                };
            }
        }
        if (ref.kind === 'group_chat') {
            const row = groupStmt.get(ref.id);
            if (row) {
                return {
                    source_key: ref.key,
                    raw_ref: ref.raw,
                    kind: ref.kind,
                    id: row.id,
                    group_id: row.group_id,
                    speaker: row.sender_id === 'user' ? 'User' : (row.sender_name || getCharacterName(row.sender_id)),
                    role: row.sender_id || '',
                    timestamp: Number(row.timestamp || 0),
                    content: row.content || '',
                    found: true
                };
            }
        }
        if (ref.kind === 'commercial_street') {
            const row = cityStmt.get(ref.id);
            if (row) {
                return {
                    source_key: ref.key,
                    raw_ref: ref.raw,
                    kind: ref.kind,
                    id: row.id,
                    character_id: row.character_id,
                    speaker: getCharacterName(row.character_id),
                    role: row.action_type || 'city_log',
                    location: row.location || '',
                    timestamp: Number(row.timestamp || 0),
                    content: row.content || '',
                    found: true
                };
            }
        }
        if (ref.kind === 'external_app') {
            const row = externalImportStmt ? externalImportStmt.get(ref.import_id || ref.id) : null;
            if (row) {
                const summary = tryParseJsonValue(row.summary_json || '{}').ok
                    ? tryParseJsonValue(row.summary_json || '{}').value
                    : {};
                const messages = tryParseJsonValue(row.normalized_messages_json || '[]').ok
                    ? tryParseJsonValue(row.normalized_messages_json || '[]').value
                    : [];
                const candidates = Array.isArray(summary?.candidates) ? summary.candidates : [];
                const candidate = candidates.find(item => String(item.id || '') === String(ref.candidate_id || '')) || {};
                const sourceRefs = Array.isArray(candidate.source_refs) ? candidate.source_refs : [];
                const messageById = new Map((Array.isArray(messages) ? messages : []).map(message => [String(message.id), message]));
                const sourceMessages = sourceRefs.map(id => messageById.get(String(id))).filter(Boolean);
                const content = sourceMessages.length > 0
                    ? sourceMessages.map(message => `${message.speaker || 'Unknown'}: ${message.text || ''}`).join('\n')
                    : (candidate.content || candidate.summary || row.raw_text || '');
                const timestamps = sourceMessages.map(message => Number(message.timestamp || 0)).filter(ts => ts > 0);
                return {
                    source_key: ref.key,
                    raw_ref: ref.raw,
                    kind: ref.kind,
                    id: ref.import_id || ref.id,
                    candidate_id: ref.candidate_id || '',
                    source_app: row.source_app || '',
                    speaker: getExternalSourceAppLabel(row.source_app || ''),
                    role: row.import_mode || 'external_import',
                    timestamp: timestamps.length ? Math.min(...timestamps) : Number(row.created_at || 0),
                    content: clipMemoryDisplayText(content, 4000),
                    found: true,
                    filename: row.filename || ''
                };
            }
        }
        return {
            source_key: ref.key,
            raw_ref: ref.raw,
            kind: ref.kind,
            id: ref.id,
            timestamp: 0,
            content: '',
            found: false
        };
    });
}

app.get('/api/memory-source', authMiddleware, (req, res) => {
    try {
        const rawDb = typeof req.db.getRawDb === 'function' ? req.db.getRawDb() : null;
        if (!rawDb) return res.status(500).json({ error: 'Raw database handle is unavailable.' });
        const memoryIds = Array.from(new Set(String(req.query.ids || req.query.memory_ids || '')
            .split(/[,\s]+/)
            .map(id => Number(id || 0))
            .filter(id => id > 0)))
            .slice(0, 120);
        if (memoryIds.length === 0) {
            return res.status(400).json({ error: 'ids query parameter is required.' });
        }

        const memoryStmt = rawDb.prepare(`
            SELECT id, character_id, summary, content, event, consolidation_key, consolidation_summary,
                   source_message_ids_json, source_started_at, source_ended_at, source_time_text,
                   source_message_count, source_context, scene_tag, source_app, created_at, updated_at
            FROM memories
            WHERE id = ?
        `);
        const memories = [];
        const missingMemoryIds = [];
        const sourceRefByKey = new Map();
        const memoryIdsBySourceKey = new Map();

        for (const id of memoryIds) {
            const row = memoryStmt.get(id);
            if (!row) {
                missingMemoryIds.push(id);
                continue;
            }
            const refs = parseMemorySourceIds(row.source_message_ids_json)
                .map(normalizeMemorySourceRef)
                .filter(ref => ref.raw)
                .slice(0, 320);
            const sourceKeys = [];
            for (const ref of refs) {
                sourceKeys.push(ref.key);
                if (!sourceRefByKey.has(ref.key)) sourceRefByKey.set(ref.key, ref);
                if (!memoryIdsBySourceKey.has(ref.key)) memoryIdsBySourceKey.set(ref.key, []);
                memoryIdsBySourceKey.get(ref.key).push(row.id);
            }
            memories.push({
                id: row.id,
                character_id: row.character_id,
                summary: row.consolidation_summary || row.summary || row.content || row.event || '',
                legacy_summary: row.summary || row.content || row.event || '',
                consolidation_key: row.consolidation_key || '',
                source_context: inferMemorySourceContext(row),
                scene_tag: inferMemorySceneTag(row),
                source_time_text: row.source_time_text || '',
                source_started_at: Number(row.source_started_at || 0),
                source_ended_at: Number(row.source_ended_at || 0),
                source_message_count: Number(row.source_message_count || refs.length || 0),
                source_refs: sourceKeys
            });
        }

        const sources = buildMemorySourcePayload(rawDb, Array.from(sourceRefByKey.values()))
            .map(source => ({
                ...source,
                memory_ids: Array.from(new Set(memoryIdsBySourceKey.get(source.source_key) || []))
            }))
            .sort((a, b) => {
                const foundDiff = Number(b.found === true) - Number(a.found === true);
                if (foundDiff !== 0) return foundDiff;
                const timeDiff = Number(a.timestamp || 0) - Number(b.timestamp || 0);
                if (timeDiff !== 0) return timeDiff;
                return String(a.source_key || '').localeCompare(String(b.source_key || ''));
            });

        res.json({
            success: true,
            requested_memory_ids: memoryIds,
            missing_memory_ids: missingMemoryIds,
            memories,
            sources,
            stats: {
                memory_count: memories.length,
                source_ref_count: sourceRefByKey.size,
                found_source_count: sources.filter(source => source.found).length,
                missing_source_count: sources.filter(source => !source.found).length
            }
        });
    } catch (e) {
        console.error('Memory source lookup failed:', e);
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
        const charObj = db.getCharacter(req.params.characterId);
        if (!charObj) return res.status(404).json({ error: 'Character not found' });
        const includeArchived = String(req.query.include_archived || '').trim() === '1';
        const mems = db.getMemories(charObj.id)
            .filter(mem => includeArchived || Number(mem.is_archived || 0) === 0);
        res.json(mems);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/memories/:characterId/export', authMiddleware, (req, res) => {
    const db = req.db;
    try {
        const characterId = req.params.characterId;
        const charObj = db.getCharacter(characterId);
        if (!charObj) return res.status(404).json({ error: 'Character not found' });

        const includeArchived = String(req.query.include_archived || '').trim() === '1';
        const memories = db.getMemories(characterId)
            .filter(mem => includeArchived || Number(mem.is_archived || 0) === 0)
            .map(mem => ({
                ...mem,
                embedding: undefined
            }));
        const archive = {
            format: 'chatpulse.memories.v1',
            exported_at: Date.now(),
            character: {
                id: charObj.id,
                name: charObj.name
            },
            character_id: characterId,
            qdrant: {
                strategy: 'rebuild_or_upsert_from_sqlite_memories_on_import',
                exported_points: false
            },
            memories
        };
        const filenameBase = sanitizeDownloadName(charObj.name || characterId, characterId);
        const filenameId = sanitizeDownloadName(characterId, 'character');
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Content-Disposition', `attachment; filename="${filenameBase}_${filenameId}_memories_export.json"`);
        res.send(JSON.stringify(archive, null, 2));
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

app.post('/api/memories/:characterId/import', authMiddleware, (req, res) => {
    memoryImportUpload.any()(req, res, async function (err) {
        if (err instanceof multer.MulterError) {
            return res.status(400).json({ error: err.message });
        }
        if (err) {
            return res.status(400).json({ error: err.message });
        }

        const db = req.db;
        const memory = req.memory;
        try {
            const characterId = req.params.characterId;
            const charObj = db.getCharacter(characterId);
            if (!charObj) return res.status(404).json({ error: 'Character not found' });

            const dryRun = parseBooleanFlag(req.query.dry_run ?? req.body?.dry_run);
            const mode = String(req.query.mode ?? req.body?.mode ?? '').trim().toLowerCase();
            const merge = mode === 'merge' || parseBooleanFlag(req.query.merge ?? req.body?.merge);
            const replace = !merge && (mode === '' || mode === 'replace' || parseBooleanFlag(req.query.replace ?? req.body?.replace));
            const { entries, source } = parseMemoryImportRequest(req);
            if (!entries || entries.length === 0) {
                return res.status(400).json({
                    error: 'No importable memories found. Use JSON with a memories array, JSONL, or plain text paragraphs.',
                    acceptedFormats: ['json', 'jsonl', 'txt', 'md']
                });
            }
            if (entries.length > MEMORY_IMPORT_MAX_ITEMS) {
                return res.status(413).json({
                    error: `Too many memories in one import. Limit is ${MEMORY_IMPORT_MAX_ITEMS}.`,
                    total: entries.length,
                    acceptedFormats: ['json', 'jsonl', 'txt', 'md']
                });
            }

            const errors = [];
            const importedIds = [];
            const preview = [];
            let skipped = 0;
            const normalizedEntries = entries.map((entry, idx) => normalizeImportedMemoryEntry(entry, idx));
            const validEntryCount = normalizedEntries.filter(item => !item.error).length;
            if (validEntryCount === 0) {
                return res.status(400).json({
                    error: 'No valid memories found in the import file.',
                    total: entries.length,
                    imported: 0,
                    skipped: entries.length,
                    errors: normalizedEntries.slice(0, 20).map((item, idx) => ({ index: idx, error: item.error || 'Invalid memory.' }))
                });
            }

            if (replace && !dryRun) {
                db.clearMemories(characterId);
                await memory.wipeIndex(characterId);
            }

            for (let idx = 0; idx < normalizedEntries.length; idx++) {
                const normalized = normalizedEntries[idx];
                if (normalized.error) {
                    skipped += 1;
                    if (errors.length < 20) errors.push({ index: idx, error: normalized.error });
                    continue;
                }

                const memoryData = normalized.data;
                if (dryRun) {
                    preview.push({
                        index: idx,
                        summary: memoryData.summary,
                        content: memoryData.content,
                        importance: memoryData.importance,
                        memory_type: memoryData.memory_type,
                        memory_tier: memoryData.memory_tier,
                        memory_focus: memoryData.memory_focus
                    });
                    continue;
                }

                try {
                    const groupId = memoryData.group_id || null;
                    delete memoryData.group_id;
                    const memoryId = await memory.saveExtractedMemory(characterId, memoryData, groupId, {
                        allowRoutineCity: true,
                        allowUnindexed: true,
                        throwOnError: true
                    });
                    if (memoryId) {
                        importedIds.push(memoryId);
                    } else {
                        skipped += 1;
                        if (errors.length < 20) errors.push({ index: idx, error: 'Memory was not saved.' });
                    }
                } catch (e) {
                    skipped += 1;
                    if (errors.length < 20) errors.push({ index: idx, error: e.message || 'Memory import failed.' });
                }

                if (idx > 0 && idx % 5 === 0) {
                    await new Promise(resolve => setImmediate(resolve));
                }
            }

            res.json({
                success: dryRun ? errors.length === 0 : importedIds.length > 0,
                dryRun,
                mode: replace ? 'replace' : 'merge',
                total: entries.length,
                imported: importedIds.length,
                skipped,
                ids: importedIds,
                source,
                acceptedFormats: ['json', 'jsonl', 'txt', 'md'],
                preview: dryRun ? preview : undefined,
                errors
            });
        } catch (e) {
            console.error('Memory import failed:', e);
            res.status(500).json({ error: e.message });
        }
    });
});

app.post('/api/memory-import/external/preview', authMiddleware, (req, res) => {
    console.log(`[External Import] Preview route hit user=${req.user?.username || 'unknown'} contentType=${req.headers['content-type'] || ''}`);
    memoryImportUpload.any()(req, res, async function (err) {
        if (err instanceof multer.MulterError) {
            return res.status(400).json({ error: err.message });
        }
        if (err) {
            return res.status(400).json({ error: err.message });
        }

        const db = req.db;
        try {
            const settings = getMemoryMaintenanceSettings(db);
            if (!settings.api_endpoint || !settings.api_key || !settings.model_name) {
                return res.status(400).json({ error: '请先配置“记忆库管理小模型”的 URL、Key 和模型。' });
            }
            const external = parseExternalImportRequest(req);
            const requestedSourceApp = normalizeExternalSourceApp(req.body?.source_app || req.body?.source || req.body?.app);
            const sourceApp = external.detectedSourceApp || requestedSourceApp;
            const importMode = external.detectedSourceApp === 'sillytavern'
                ? 'multi_role'
                : normalizeExternalImportMode(req.body?.import_mode || req.body?.mode, sourceApp);
            const targetCharacterName = normalizeExternalCharacterName(req.body?.target_character_name || req.body?.character_name, getExternalSourceAppLabel(sourceApp));
            const prompt = buildExternalImportPrompt({
                sourceApp,
                importMode,
                targetCharacterName,
                messages: external.messages,
                rawText: external.rawText,
                knownRoleTags: [],
                userName: req.user.username
            });
            const previewStartedAt = Date.now();
            console.log(`[External Import] Preview start user=${req.user.username} source=${sourceApp} requested=${requestedSourceApp} detected=${external.detectedSourceApp || ''} mode=${importMode} messages=${external.messages.length} promptChars=${prompt.user_prompt.length} changed=${external.cleanStats?.changed_messages || 0} dropped=${external.cleanStats?.dropped_messages || 0} jsonlParsed=${external.cleanStats?.jsonl_parsed_lines || 0} rawChars=${external.cleanStats?.raw_chars || 0}`);
            const response = await callLLM({
                endpoint: settings.api_endpoint,
                key: settings.api_key,
                model: settings.model_name,
                messages: [
                    { role: 'system', content: prompt.system_prompt },
                    { role: 'user', content: prompt.user_prompt }
                ],
                maxTokens: Math.max(1500, Math.min(20000, Number(settings.max_output_tokens || 8000) || 8000)),
                temperature: 0.1,
                returnUsage: true,
                responseFormat: { type: 'json_object' },
                requestTimeoutMs: EXTERNAL_MEMORY_IMPORT_LLM_TIMEOUT_MS,
                maxAttempts: 1
            });
            const rawText = typeof response === 'string' ? response : response.content;
            const parsed = extractJsonObjectFromText(rawText);
            const normalized = normalizeExternalImportResult(parsed, {
                sourceApp,
                importMode,
                targetCharacterName,
                messages: external.messages,
                knownRoleTags: [],
                userName: req.user.username
            });
            if (!normalized.candidates.length) {
                console.warn(`[External Import] Preview produced no candidates user=${req.user.username} source=${sourceApp} mode=${importMode} roles=${normalized.role_tags?.length || 0} needsReview=${normalized.needs_review?.length || 0} raw=${clipMemoryDisplayText(rawText, 600)}`);
                return res.status(422).json({
                    error: '小模型没有提取出可导入的新记忆。可以换更明确的导出文件，或改成手动粘贴关键片段。',
                    raw_response: clipMemoryDisplayText(rawText, 1600),
                    role_tags: normalized.role_tags || [],
                    needs_review: normalized.needs_review || []
                });
            }
            const rawDb = typeof db.getRawDb === 'function' ? db.getRawDb() : null;
            if (!rawDb) return res.status(500).json({ error: 'Raw database handle is unavailable.' });
            const now = Date.now();
            const info = rawDb.prepare(`
                INSERT INTO external_memory_imports
                    (source_app, import_mode, filename, raw_text, normalized_messages_json, summary_json, role_tags_json, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            `).run(
                sourceApp,
                importMode,
                external.filename || '',
                external.rawText || '',
                JSON.stringify(external.messages || []),
                JSON.stringify(normalized),
                JSON.stringify(normalized.role_tags || []),
                now
            );
            console.log(`[External Import] Preview success id=${info.lastInsertRowid} user=${req.user.username} roles=${normalized.role_tags.length} candidates=${normalized.candidates.length} durationMs=${Date.now() - previewStartedAt}`);
            res.json({
                success: true,
                import: {
                    id: info.lastInsertRowid,
                    source_app: sourceApp,
                    import_mode: importMode,
                    filename: external.filename || '',
                    message_count: external.messages.length,
                    created_at: now,
                    detected_source_app: external.detectedSourceApp || ''
                },
                role_tags: normalized.role_tags,
                candidates: normalized.candidates,
                needs_review: normalized.needs_review,
                model: {
                    name: settings.model_name,
                    usage: response?.usage || null,
                    finishReason: response?.finishReason || ''
                },
                prompt_stats: {
                    row_count: prompt.row_count,
                    prompt_chars: prompt.user_prompt.length,
                    clean_stats: external.cleanStats || null
                },
                raw_response_preview: clipMemoryDisplayText(rawText, 1600)
            });
        } catch (e) {
            console.error('External memory import preview failed:', e);
            const isTimeout = /timed out|abort/i.test(String(e.message || ''));
            res.status(e.status || (isTimeout ? 504 : 500)).json({ error: e.message });
        }
    });
});

app.post('/api/memory-import/external/auto-run', authMiddleware, (req, res) => {
    memoryImportUpload.any()(req, res, async function (err) {
        if (err instanceof multer.MulterError) {
            return res.status(400).json({ error: err.message });
        }
        if (err) {
            return res.status(400).json({ error: err.message });
        }

        const db = req.db;
        const memory = req.memory;
        const rawDb = typeof db.getRawDb === 'function' ? db.getRawDb() : null;
        if (!rawDb) return res.status(500).json({ error: 'Raw database handle is unavailable.' });

        let runState = null;
        try {
            const settings = getMemoryMaintenanceSettings(db);
            if (!settings.api_endpoint || !settings.api_key || !settings.model_name) {
                return res.status(400).json({ error: '请先配置“记忆库管理小模型”的 URL、Key 和模型。' });
            }

            let continueImportId = normalizeOptionalMemoryId(req.body?.continue_import_id || req.body?.import_id, 'import_id');
            if (!continueImportId && parseBooleanFlag(req.body?.retry_latest_external_import)) {
                const latestImport = rawDb.prepare(`
                    SELECT id
                    FROM external_memory_imports
                    WHERE COALESCE(normalized_messages_json, '') <> ''
                    ORDER BY id DESC
                    LIMIT 1
                `).get();
                continueImportId = Number(latestImport?.id || 0);
            }
            const external = continueImportId
                ? loadExternalImportRequestFromDb(rawDb, continueImportId)
                : parseExternalImportRequest(req);
            const requestedSourceApp = normalizeExternalSourceApp(req.body?.source_app || req.body?.source || req.body?.app);
            const sourceApp = external.storedSourceApp || external.detectedSourceApp || requestedSourceApp;
            const importMode = external.storedImportMode || (external.detectedSourceApp === 'sillytavern'
                ? 'multi_role'
                : normalizeExternalImportMode(req.body?.import_mode || req.body?.mode, sourceApp));
            const targetCharacterName = normalizeExternalCharacterName(req.body?.target_character_name || req.body?.character_name, getExternalSourceAppLabel(sourceApp));
            const batchOptions = normalizeMemoryMaintenanceBatchOptions({
                limit: req.body?.limit,
                offset: req.body?.continue_from_offset ?? req.body?.start_offset
            }, {
                limitFallback: settings.batch_size || 10
            });
            const runControls = normalizeMemoryMaintenanceAutoRunControls({
                ...req.body,
                limit: batchOptions.limit
            }, {
                limitFallback: batchOptions.limit,
                maxBatchesFallback: 1,
                maxRerollsFallback: 0,
                maxRerollsMax: 3,
                missingMaxBatchesMeansAll: true
            });
            const limit = runControls.limit;
            const requestedContinueOffset = batchOptions.offset;
            const runUntilEmpty = runControls.run_until_empty;
            const maxBatches = runControls.max_batches;
            const maxRerolls = runControls.max_rerolls;
            const dryRun = parseBooleanFlag(req.body?.dry_run);
            const backgroundRun = req.body?.background === true || req.body?.background === 'true';
            const runCharacterId = '__external_import__';

            if (backgroundRun) {
                const activeRun = findActiveMemoryMaintenanceRun(req.user.id, runCharacterId);
                if (activeRun) {
                    return res.json({
                        success: true,
                        accepted: true,
                        reused: true,
                        run: getMemoryMaintenanceRunSnapshot(activeRun)
                    });
                }
            }

            let importId = continueImportId || 0;
            const importStartedAt = Date.now();
            let previousSaved = [];
            if (!dryRun && continueImportId) {
                previousSaved = normalizeExternalProcessingState(external.row?.memory_ids_json);
            }
            if (!dryRun && !continueImportId) {
                const info = rawDb.prepare(`
                    INSERT INTO external_memory_imports
                        (source_app, import_mode, filename, raw_text, normalized_messages_json, summary_json, role_tags_json, memory_ids_json, created_at, committed_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                `).run(
                    sourceApp,
                    importMode,
                    external.filename || '',
                    external.rawText || '',
                    JSON.stringify(external.messages || []),
                    JSON.stringify({ source_app: sourceApp, import_mode: importMode, role_tags: [], candidates: [], needs_review: [] }),
                    '[]',
                    '[]',
                    importStartedAt,
                    importStartedAt
                );
                importId = Number(info.lastInsertRowid || 0);
            }

            const totalMessages = external.messages || [];
            const inferredContinueOffset = continueImportId && requestedContinueOffset <= 0
                ? inferExternalImportContinueOffset(external.row, limit)
                : requestedContinueOffset;
            const continueOffset = Math.min(totalMessages.length, Math.max(0, inferredContinueOffset));
            const chunks = chunkExternalImportMessages(totalMessages.slice(continueOffset), limit, maxBatches);
            const runId = `external-import-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
            const wsClients = getWsClients(req.user.id);
            const characterLabel = importMode === 'multi_role' ? '外部导入' : (targetCharacterName || getExternalSourceAppLabel(sourceApp));
            runState = {
                run_id: runId,
                user_id: req.user.id,
                characterId: runCharacterId,
                character: { id: runCharacterId, name: characterLabel },
                task_mode: 'external_import',
                import_id: importId || null,
                source_app: sourceApp,
                import_mode: importMode,
                filename: external.filename || '',
                continue_from_offset: continueOffset,
                total_messages: totalMessages.length,
                phase: 'queued',
                running: true,
                success: undefined,
                limit,
                max_batches: maxBatches,
                run_until_empty: runUntilEmpty,
                max_rerolls: maxRerolls,
                processed: 0,
                updated: 0,
                applied_errors: 0,
                started_at: Date.now(),
                updated_at: Date.now(),
                finished_at: 0,
                events: []
            };
            memoryMaintenanceRuns.set(runId, runState);

            const runs = [];
            const errors = [];
            const previousSummary = continueImportId ? safeJsonParse(external.row?.summary_json, {}) : {};
            const allCandidates = Array.isArray(previousSummary.candidates) ? [...previousSummary.candidates] : [];
            let allRoleTags = Array.isArray(previousSummary.role_tags) ? [...previousSummary.role_tags] : [];
            const allNeedsReview = Array.isArray(previousSummary.needs_review) ? [...previousSummary.needs_review] : [];
            const allSaved = [...previousSaved];
            let processed = continueOffset;
            let updated = previousSaved.length ? countUniqueExternalImportSavedItems(previousSaved) : 0;
            let appliedErrors = 0;
            let lastRawResponse = '';
            let lastPrompt = null;
            let stoppedReason = '';

            const sendProgress = (phase, extra = {}) => {
                const payload = {
                    type: 'memory_maintenance_progress',
                    data: {
                        run_id: runId,
                        task_mode: 'external_import',
                        import_id: importId || null,
                        source_app: sourceApp,
                        import_mode: importMode,
                        filename: external.filename || '',
                        continue_from_offset: continueOffset,
                        total_messages: totalMessages.length,
                        phase,
                        characterId: runCharacterId,
                        character: { id: runCharacterId, name: characterLabel },
                        limit,
                        max_batches: maxBatches,
                        run_until_empty: runUntilEmpty,
                        max_rerolls: maxRerolls,
                        processed,
                        updated,
                        applied_errors: appliedErrors,
                        timestamp: Date.now(),
                        ...extra
                    }
                };
                const eventData = payload.data;
                runState.phase = phase;
                runState.updated_at = eventData.timestamp;
                runState.running = !['done', 'stopped'].includes(phase);
                runState.processed = eventData.processed ?? runState.processed;
                runState.updated = eventData.updated ?? runState.updated;
                runState.applied_errors = eventData.applied_errors ?? runState.applied_errors;
                runState.batch_number = eventData.batch_number ?? runState.batch_number;
                runState.attempt = eventData.attempt ?? runState.attempt;
                runState.reroll = eventData.reroll ?? runState.reroll;
                runState.message = eventData.message || runState.message || '';
                runState.new_memory_samples = eventData.new_memory_samples || runState.new_memory_samples || [];
                runState.stopped_reason = eventData.stopped_reason || runState.stopped_reason || '';
                runState.can_continue = eventData.can_continue ?? runState.can_continue;
                runState.continue_from = eventData.continue_from || runState.continue_from || null;
                runState.errors = eventData.errors || runState.errors || [];
                runState.stats = eventData.stats || runState.stats || null;
                if (!runState.running) {
                    runState.success = eventData.success;
                    runState.finished_at = eventData.timestamp;
                }
                runState.events.push(eventData);
                if (runState.events.length > 100) runState.events.splice(0, runState.events.length - 100);
                broadcastToWsClients(wsClients, payload);
            };

            const executeExternalImportRun = async () => {
                await yieldToServerLoop();
                sendProgress('start', {
                    message: continueOffset > 0
                        ? `外部导入从断点继续：跳过已处理 ${continueOffset} 条，剩余 ${Math.max(0, totalMessages.length - continueOffset)} 条，按每批 ${limit} 条处理。`
                        : `外部导入自动总结已开始：${totalMessages.length} 条正文，按每批 ${limit} 条处理。`,
                    pending_before: Math.max(0, totalMessages.length - continueOffset)
                });

                if (!chunks.length) {
                    stoppedReason = 'empty';
                }

            for (let idx = 0; idx < chunks.length; idx++) {
                const batchNumber = Math.floor(continueOffset / limit) + idx + 1;
                const chunk = chunks[idx];
                const rollAttempts = [];
                let batchSaved = null;
                let batchNormalized = null;
                let batchRawResponse = '';
                let shouldStop = false;

                sendProgress('batch_start', {
                    batch_number: batchNumber,
                    pending_before: Math.max(0, totalMessages.length - continueOffset - idx * limit),
                    message: `第 ${batchNumber} 批开始：读取 ${chunk.length} 条导入正文。`
                });

                for (let reroll = 0; reroll <= maxRerolls; reroll++) {
                    const attemptNumber = reroll + 1;
                    sendProgress('attempt_start', {
                        batch_number: batchNumber,
                        attempt: attemptNumber,
                        reroll,
                        message: reroll > 0 ? `第 ${batchNumber} 批重试第 ${reroll} 次。` : `第 ${batchNumber} 批调用小模型。`
                    });
                    try {
                        const prompt = buildExternalImportPrompt({
                            sourceApp,
                            importMode,
                            targetCharacterName,
                            messages: chunk,
                            rawText: '',
                            knownRoleTags: allRoleTags,
                            userName: req.user.username
                        });
                        lastPrompt = prompt;
                        const response = await callLLM({
                            endpoint: settings.api_endpoint,
                            key: settings.api_key,
                            model: settings.model_name,
                            messages: [
                                { role: 'system', content: prompt.system_prompt },
                                { role: 'user', content: prompt.user_prompt }
                            ],
                            maxTokens: Math.max(1500, Math.min(20000, Number(settings.max_output_tokens || 8000) || 8000)),
                            temperature: 0.1,
                            returnUsage: true,
                            responseFormat: { type: 'json_object' },
                            requestTimeoutMs: EXTERNAL_MEMORY_IMPORT_LLM_TIMEOUT_MS,
                            maxAttempts: 1
                        });
                        batchRawResponse = typeof response === 'string' ? response : response.content;
                        lastRawResponse = batchRawResponse || lastRawResponse;
                        const parsed = extractJsonObjectFromText(batchRawResponse);
                        batchNormalized = normalizeExternalImportResult(parsed, {
                            sourceApp,
                            importMode,
                            targetCharacterName,
                            messages: chunk,
                            knownRoleTags: allRoleTags,
                            userName: req.user.username
                        });
                        batchNormalized.candidates = (batchNormalized.candidates || []).map(candidate => ({
                            ...candidate,
                            id: `b${batchNumber}_${candidate.id || Math.random().toString(16).slice(2, 8)}`
                        }));
                        allRoleTags = mergeExternalImportRoleTags(allRoleTags, batchNormalized.role_tags || []);
                        allCandidates.push(...batchNormalized.candidates);
                        allNeedsReview.push(...(batchNormalized.needs_review || []));
                        batchSaved = await saveExternalImportCandidatesDirect({
                            db,
                            memory,
                            settings,
                            importId,
                            sourceApp,
                            importMode,
                            normalized: batchNormalized,
                            dryRun
                        });
                        break;
                    } catch (e) {
                        lastRawResponse = e?.payload?.raw_response || lastRawResponse;
                        const attemptError = buildMemoryMaintenanceAttemptError(e, attemptNumber);
                        rollAttempts.push(attemptError);
                        const nonRetryable = isNonRetryableMemoryMaintenanceError(e);
                        sendProgress('attempt_error', {
                            batch_number: batchNumber,
                            attempt: attemptNumber,
                            reroll,
                            attempt_error: attemptError,
                            will_reroll: !nonRetryable && reroll < maxRerolls,
                            message: nonRetryable ? '小模型鉴权失败，已停止外部导入。' : undefined
                        });
                        if (nonRetryable || reroll >= maxRerolls) {
                            errors.push({
                                batch_number: batchNumber,
                                error: e.message || 'External import batch failed.',
                                attempts: rollAttempts,
                                raw_response_preview: clipMemoryDisplayText(lastRawResponse, 1600)
                            });
                            stoppedReason = nonRetryable ? 'auth_error' : 'error';
                            shouldStop = true;
                            break;
                        }
                    }
                }

                if (shouldStop) break;
                if (!batchSaved || !batchNormalized) {
                    stoppedReason = 'error';
                    errors.push({ batch_number: batchNumber, error: '小模型没有返回可用结果。', attempts: rollAttempts });
                    break;
                }

                const batchUniqueSaved = countUniqueExternalImportSavedItems(batchSaved.saved || []);
                const batchBindingCount = countExternalImportSavedBindings(batchSaved.saved || []);
                processed += chunk.length;
                updated += batchUniqueSaved;
                appliedErrors += Number(batchSaved.error_count || 0);
                allSaved.push(...(batchSaved.saved || []));
                if (batchSaved.errors?.length) {
                    errors.push({ batch_number: batchNumber, error: '部分记忆保存失败。', attempts: rollAttempts, save_errors: batchSaved.errors });
                }
                const runRecord = {
                    batch_number: batchNumber,
                    item_count: chunk.length,
                    new_memory_count: batchNormalized.candidates.length,
                    updated: batchUniqueSaved,
                    saved_bindings: batchBindingCount,
                    errors: Number(batchSaved.error_count || 0),
                    skipped: batchSaved.skipped || [],
                    rerolls: rollAttempts.length,
                    model: settings.model_name
                };
                runs.push(runRecord);
                sendProgress('batch_success', {
                    ...runRecord,
                    processed,
                    updated,
                    applied_errors: appliedErrors,
                    remaining_pending_after_batch: Math.max(0, totalMessages.length - processed),
                    new_memory_samples: formatExternalImportSavedSamples(batchSaved.saved || [], 5),
                    message: dryRun
                        ? `第 ${batchNumber} 批完成：预览 ${batchUniqueSaved} 条，不写库。`
                        : (batchBindingCount > batchUniqueSaved
                            ? `第 ${batchNumber} 批完成：写入 ${batchUniqueSaved} 条共享记忆，绑定 ${batchBindingCount} 次角色。`
                            : `第 ${batchNumber} 批完成：写入 ${batchUniqueSaved} 条。`)
                });
            }

            if (!stoppedReason) {
                stoppedReason = allSaved.length > 0 || dryRun ? 'completed' : 'no_candidates';
            }

            if (!dryRun && importId) {
                rawDb.prepare(`
                    UPDATE external_memory_imports
                    SET summary_json = ?,
                        role_tags_json = ?,
                        memory_ids_json = ?,
                        committed_at = ?
                    WHERE id = ?
                `).run(
                    JSON.stringify({
                        source_app: sourceApp,
                        import_mode: importMode,
                        role_tags: allRoleTags,
                        candidates: allCandidates,
                        needs_review: allNeedsReview.slice(0, 200),
                        last_run: {
                            processed,
                            updated,
                            limit,
                            max_batches: maxBatches,
                            run_until_empty: runUntilEmpty,
                            stopped_reason: stoppedReason || '',
                            errors: errors.slice(-3),
                            finished_at: Date.now()
                        },
                        continue_from: {
                            import_id: importId,
                            offset: processed,
                            pending: Math.max(0, totalMessages.length - processed),
                            total: totalMessages.length
                        }
                    }),
                    JSON.stringify(allRoleTags),
                    JSON.stringify(allSaved),
                    Date.now(),
                    importId
                );
            }

            const characterIds = getExternalImportSavedCharacterIds(allSaved);
            for (const characterId of characterIds) {
                broadcastToWsClients(wsClients, { type: 'memory_update', characterId });
            }
            broadcastToWsClients(wsClients, { type: 'refresh_contacts' });
            const savedBindingCount = countExternalImportSavedBindings(allSaved);
            const savedCharacters = Array.from(new Map(allSaved.flatMap(item => {
                if (Array.isArray(item?.bound_characters) && item.bound_characters.length > 0) {
                    return item.bound_characters.map(character => [character.id, { id: character.id, name: character.name }]);
                }
                return item?.character_id ? [[item.character_id, { id: item.character_id, name: item.character_name }]] : [];
            }).filter(([id]) => id)).values());

            const responsePayload = {
                success: errors.length === 0,
                mode: 'external_import_auto',
                dry_run: dryRun,
                import_id: importId || null,
                source_app: sourceApp,
                detected_source_app: external.detectedSourceApp || '',
                import_mode: importMode,
                filename: external.filename || '',
                limit,
                max_batches: maxBatches,
                run_until_empty: runUntilEmpty,
                max_rerolls: maxRerolls,
                processed,
                updated,
                applied_errors: appliedErrors,
                stopped_reason: stoppedReason,
                roles: allRoleTags,
                characters: savedCharacters,
                saved: allSaved,
                errors,
                runs,
                prompt: lastPrompt,
                raw_response_preview: clipMemoryDisplayText(lastRawResponse, 1600),
                can_continue: ['error', 'no_progress'].includes(stoppedReason) && processed < totalMessages.length,
                continue_from: {
                    import_id: importId || null,
                    offset: processed,
                    pending: Math.max(0, totalMessages.length - processed),
                    total: totalMessages.length
                },
                stats: {
                    message_count: totalMessages.length,
                    batch_count: chunks.length,
                    candidates: allCandidates.length,
                    saved: allSaved.length,
                    saved_bindings: savedBindingCount,
                    needs_review: allNeedsReview.length
                }
            };
            sendProgress(responsePayload.success ? 'done' : 'stopped', {
                import_id: responsePayload.import_id,
                source_app: sourceApp,
                import_mode: importMode,
                filename: external.filename || '',
                stopped_reason: responsePayload.stopped_reason,
                success: responsePayload.success,
                can_continue: responsePayload.can_continue,
                continue_from: responsePayload.continue_from,
                stats: responsePayload.stats,
                errors: errors.slice(-3),
                runs_count: runs.length,
                new_memory_samples: formatExternalImportSavedSamples(allSaved, 5),
                message: responsePayload.success
                    ? (dryRun
                        ? `外部导入预览完成：处理 ${processed} 条正文，候选 ${updated} 条，未写库。`
                        : (savedBindingCount > updated
                            ? `外部导入完成：处理 ${processed} 条正文，写入 ${updated} 条共享记忆，绑定 ${savedBindingCount} 次角色。`
                            : `外部导入完成：处理 ${processed} 条正文，写入 ${updated} 条正式记忆。`))
                    : `外部导入停止：${responsePayload.stopped_reason || 'error'}。`
            });
            if (!res.headersSent) {
                res.status(responsePayload.success ? 200 : 422).json(responsePayload);
            }
            return responsePayload;
            };

            const failExternalImportRun = (e) => {
                console.error('External memory import auto-run failed:', e);
                runState.running = false;
                runState.success = false;
                runState.finished_at = Date.now();
                runState.stopped_reason = 'error';
                runState.errors = [{ error: e.message || 'External import failed.' }];
                sendProgress('stopped', {
                    stopped_reason: 'error',
                    success: false,
                    errors: runState.errors,
                    message: `外部导入停止：${e.message || 'error'}。`
                });
                if (!res.headersSent) {
                    res.status(e.status || 500).json({ error: e.message });
                }
            };

            if (backgroundRun) {
                res.json({
                    success: true,
                    accepted: true,
                    run: getMemoryMaintenanceRunSnapshot(runState)
                });
                enqueueBackgroundTask({
                    key: `memory-import:${req.user.id}`,
                    dedupeKey: `memory-import:${req.user.id}:external`,
                    maxPending: 2,
                    task: executeExternalImportRun
                }).then((queueResult) => {
                    if (queueResult?.skipped) {
                        const reason = queueResult.reason || 'queue_full';
                        sendProgress('stopped', {
                            stopped_reason: reason,
                            success: false,
                            errors: [{ error: reason }],
                            message: reason === 'duplicate'
                                ? '这个账号已有外部导入在跑。'
                                : '这个账号的外部导入队列已满。'
                        });
                    }
                }).catch(failExternalImportRun);
                return;
            }

            await executeExternalImportRun();
        } catch (e) {
            console.error('External memory import auto-run failed:', e);
            if (runState) {
                runState.running = false;
                runState.success = false;
                runState.finished_at = Date.now();
                runState.stopped_reason = 'error';
                runState.errors = [{ error: e.message || 'External import failed.' }];
            }
            if (!res.headersSent) {
                res.status(e.status || 500).json({ error: e.message });
            }
        }
    });
});

app.get('/api/memory-import/external/latest', authMiddleware, (req, res) => {
    const db = req.db;
    try {
        const rawDb = typeof db.getRawDb === 'function' ? db.getRawDb() : null;
        if (!rawDb) return res.status(500).json({ error: 'Raw database handle is unavailable.' });
        const row = rawDb.prepare(`
            SELECT id,
                   source_app,
                   import_mode,
                   filename,
                   created_at,
                   committed_at,
                   summary_json,
                   role_tags_json,
                   normalized_messages_json
            FROM external_memory_imports
            WHERE COALESCE(committed_at, 0) = 0
            ORDER BY id DESC
            LIMIT 1
        `).get();
        if (!row) {
            return res.json({ success: true, import: null });
        }
        const normalized = safeJsonParse(row.summary_json, {});
        const roleTags = Array.isArray(normalized.role_tags)
            ? normalized.role_tags
            : safeJsonParse(row.role_tags_json, []);
        const candidates = Array.isArray(normalized.candidates) ? normalized.candidates : [];
        const messages = safeJsonParse(row.normalized_messages_json, []);
        res.json({
            success: true,
            import: {
                id: row.id,
                source_app: row.source_app || '',
                import_mode: row.import_mode || '',
                filename: row.filename || '',
                message_count: Array.isArray(messages) ? messages.length : 0,
                created_at: row.created_at || 0,
                committed_at: row.committed_at || 0,
                restored: true
            },
            role_tags: Array.isArray(roleTags) ? roleTags : [],
            candidates,
            needs_review: Array.isArray(normalized.needs_review) ? normalized.needs_review : [],
            restored: true
        });
    } catch (e) {
        console.error('Load latest external memory import failed:', e);
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/memory-import/external/:importId/commit', authMiddleware, async (req, res) => {
    const db = req.db;
    const memory = req.memory;
    try {
        const importId = normalizeMemoryId(req.params.importId);
        const rawDb = typeof db.getRawDb === 'function' ? db.getRawDb() : null;
        if (!rawDb) return res.status(500).json({ error: 'Raw database handle is unavailable.' });
        const row = rawDb.prepare('SELECT * FROM external_memory_imports WHERE id = ?').get(importId);
        if (!row) return res.status(404).json({ error: 'External import preview not found.' });
        const parsedSummary = tryParseJsonValue(row.summary_json || '{}');
        const summary = parsedSummary.ok ? parsedSummary.value : {};
        const candidates = Array.isArray(summary.candidates) ? summary.candidates : [];
        const roleTags = Array.isArray(summary.role_tags) ? summary.role_tags : [];
        const rawSelectedNames = Array.isArray(req.body?.selected_role_names)
            ? req.body.selected_role_names
            : (Array.isArray(req.body?.role_names) ? req.body.role_names : []);
        const requestedNames = Array.from(new Set(rawSelectedNames
            .map(name => normalizeExternalCharacterName(name))
            .filter(Boolean)));
        const defaultNames = roleTags.map(tag => normalizeExternalCharacterName(tag.name)).filter(Boolean);
        const selectedNames = requestedNames.length ? requestedNames : defaultNames;
        if (!selectedNames.length) return res.status(400).json({ error: '请选择至少一个角色标签。' });

        const settings = getMemoryMaintenanceSettings(db);
        const selectedSet = new Set(selectedNames.map(name => name.toLowerCase()));
        const profilesByName = new Map(roleTags.map(tag => [String(tag.name || '').trim().toLowerCase(), tag.profile || tag]));
        const selectedRoleTags = roleTags.filter(tag => selectedSet.has(normalizeExternalCharacterName(tag.name).toLowerCase()));
        const selectedCandidates = [];
        for (const candidate of candidates) {
            let candidateNames = (Array.isArray(candidate.character_names) ? candidate.character_names : [])
                .map(name => normalizeExternalCharacterName(name))
                .filter(name => selectedSet.has(name.toLowerCase()));
            if (!candidateNames.length && String(row.import_mode || '') === 'one_to_one' && selectedNames.length === 1) {
                candidateNames = selectedNames.slice(0, 1);
            }
            if (!candidateNames.length) continue;
            selectedCandidates.push({
                ...candidate,
                character_names: Array.from(new Set(candidateNames))
            });
        }
        if (selectedCandidates.length <= 0) {
            return res.status(400).json({ error: '所选角色没有匹配到可写入的导入候选。' });
        }

        const normalized = {
            source_app: row.source_app || summary.source_app || 'external_app',
            import_mode: row.import_mode || summary.import_mode || 'multi_role',
            role_tags: selectedRoleTags.length
                ? selectedRoleTags
                : selectedNames.map(name => ({ name, confidence: 1, reason: '用户选择导入。', profile: profilesByName.get(name.toLowerCase()) || { name, persona: '' } })),
            candidates: selectedCandidates,
            needs_review: Array.isArray(summary.needs_review) ? summary.needs_review : []
        };
        const applyResult = await saveExternalImportCandidatesDirect({
            db,
            memory,
            settings,
            importId,
            sourceApp: normalized.source_app,
            importMode: normalized.import_mode,
            normalized,
            dryRun: false
        });
        if (applyResult.saved_count <= 0 && applyResult.error_count > 0) {
            return res.status(422).json({ error: '导入候选保存失败。', errors: applyResult.errors });
        }

        rawDb.prepare(`
            UPDATE external_memory_imports
            SET selected_character_ids_json = ?,
                memory_ids_json = ?,
                committed_at = ?
            WHERE id = ?
        `).run(
            JSON.stringify(applyResult.characters.map(character => character.id)),
            JSON.stringify(applyResult.saved),
            Date.now(),
            importId
        );

        const wsClients = getWsClients(req.user.id);
        for (const item of applyResult.saved || []) {
            if (item.character_id) {
                broadcastToWsClients(wsClients, { type: 'memory_update', characterId: item.character_id });
            }
        }
        wsClients.forEach(c => {
            if (c.readyState === 1) {
                c.send(JSON.stringify({ type: 'refresh_contacts' }));
            }
        });

        res.json({
            success: applyResult.saved_count > 0,
            import_id: importId,
            imported_as: 'external_direct',
            characters: applyResult.characters,
            queued: 0,
            imported: applyResult.saved_count,
            ids: applyResult.saved.map(item => item.memory_id).filter(Boolean),
            skipped: applyResult.skipped,
            errors: applyResult.errors
        });
    } catch (e) {
        console.error('External memory import commit failed:', e);
        res.status(e.status || 500).json({ error: e.message });
    }
});

app.get('/api/memories/:characterId/maintenance/stats', authMiddleware, (req, res) => {
    const db = req.db;
    try {
        const characterId = req.params.characterId;
        const charObj = db.getCharacter(characterId);
        if (!charObj) return res.status(404).json({ error: 'Character not found' });
        const rawDb = typeof db.getRawDb === 'function' ? db.getRawDb() : null;
        if (!rawDb) return res.status(500).json({ error: 'Raw database handle is unavailable.' });
        res.json({
            success: true,
            character: { id: charObj.id, name: charObj.name },
            stats: getMemoryMaintenanceStats(rawDb, characterId)
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/memories/:characterId/maintenance/batch', authMiddleware, (req, res) => {
    const db = req.db;
    try {
        const characterId = req.params.characterId;
        const charObj = db.getCharacter(characterId);
        if (!charObj) return res.status(404).json({ error: 'Character not found' });
        const rawDb = typeof db.getRawDb === 'function' ? db.getRawDb() : null;
        if (!rawDb) return res.status(500).json({ error: 'Raw database handle is unavailable.' });
        const batchOptions = normalizeMemoryMaintenanceBatchOptions(req.query || {}, { limitFallback: 30 });
        const batch = getMemoryMaintenanceBatch(rawDb, characterId, {
            limit: batchOptions.limit,
            offset: batchOptions.offset,
            after_id: batchOptions.after_id,
            status: req.query.status || 'pending',
            include_archived: parseBooleanFlag(req.query.include_archived)
        });
        res.json({
            success: true,
            character: { id: charObj.id, name: charObj.name },
            prompt: buildMemoryMigrationPrompt(charObj, batch, getMemoryMaintenanceSettings(db)),
            task: {
                purpose: 'Classify memories and propose consolidation/forgetting actions. Do not delete memories.',
                recommended_batch_size: 30,
                allowed_memory_focus: Array.from(MEMORY_MAINTENANCE_FOCUS),
                allowed_memory_tier: Array.from(MEMORY_MAINTENANCE_TIERS),
                allowed_maintenance_status: Array.from(MEMORY_MAINTENANCE_STATUS),
                allowed_retention_action: Array.from(MEMORY_MAINTENANCE_ACTIONS),
                output_schema: {
                    items: [{
                        id: 'number',
                        memory_focus: 'user_profile | user_current_arc | relationship | general',
                        memory_tier: 'core | active | ambient',
                        importance: '1-10',
                        maintenance_status: 'classified | needs_review | ignored',
                        retention_action: 'keep | downgrade | archive_candidate | merge_candidate | superseded | needs_review',
                        retention_reason: 'short Chinese reason',
                        consolidation_key: 'optional stable key for memories that should be merged',
                        consolidation_summary: 'optional Chinese merged summary proposal'
                    }]
                }
            },
            ...batch
        });
    } catch (e) {
        res.status(e.status || 500).json({ error: e.message });
    }
});

app.get('/api/memories/:characterId/maintenance/temporal-binding-batch', authMiddleware, (req, res) => {
    const db = req.db;
    try {
        const characterId = req.params.characterId;
        const charObj = db.getCharacter(characterId);
        if (!charObj) return res.status(404).json({ error: 'Character not found' });
        const rawDb = typeof db.getRawDb === 'function' ? db.getRawDb() : null;
        if (!rawDb) return res.status(500).json({ error: 'Raw database handle is unavailable.' });
        const batchOptions = normalizeMemoryMaintenanceBatchOptions(req.query || {}, { limitFallback: 40 });
        const batch = getMemoryTemporalBindingBatch(rawDb, characterId, {
            limit: batchOptions.limit,
            offset: batchOptions.offset,
            source: normalizeMemoryTemporalBindingSource(req.query.source || 'new'),
            include_archived: parseBooleanFlag(req.query.include_archived)
        });
        const knownIds = (batch.items || []).map(item => item.id);
        res.json({
            success: true,
            character: { id: charObj.id, name: charObj.name },
            prompt: buildMemoryTemporalBindingPrompt(charObj, batch, getMemoryMaintenanceSettings(db)),
            task: {
                purpose: 'Source/scene and time-label-only pass for existing memories. Do not change memory_focus, do not summarize, do not delete memories.',
                recommended_batch_size: 40,
                allowed_source_contexts: Array.from(MEMORY_SOURCE_CONTEXTS),
                allowed_scene_tags: Array.from(MEMORY_SCENE_TAGS),
                allowed_labels: Array.from(MEMORY_TEMPORAL_BINDING_LABELS),
                allowed_scopes: Array.from(MEMORY_TEMPORAL_BINDING_SCOPES),
                output_schema: {
                    source_labels: [{
                        id: 'number',
                        source_context: Array.from(MEMORY_SOURCE_CONTEXTS).join(' | '),
                        scene_tag: Array.from(MEMORY_SCENE_TAGS).join(' | '),
                        source_app: 'optional short app name',
                        confidence: '0.0-1.0',
                        reason: 'short Chinese reason'
                    }],
                    time_labels: [{
                        id: 'number',
                        is_time_bound: 'boolean',
                        label: Array.from(MEMORY_TEMPORAL_BINDING_LABELS).join(' | '),
                        scope: Array.from(MEMORY_TEMPORAL_BINDING_SCOPES).join(' | '),
                        time_anchor: 'short Chinese time anchor',
                        confidence: '0.0-1.0',
                        reason: 'short Chinese reason'
                    }],
                    needs_review: [{ id: 'number', reason: 'short Chinese reason' }],
                    not_time_bound_ids: ['number']
                },
                validator: 'normalizeTemporalBindingResult',
                known_ids: knownIds
            },
            ...batch
        });
    } catch (e) {
        res.status(e.status || 500).json({ error: e.message });
    }
});

app.post('/api/memories/:characterId/maintenance/temporal-binding-run', authMiddleware, async (req, res) => {
    const db = req.db;
    const memory = req.memory;
    try {
        const characterId = req.params.characterId;
        const charObj = db.getCharacter(characterId);
        if (!charObj) return res.status(404).json({ error: 'Character not found' });
        const rawDb = typeof db.getRawDb === 'function' ? db.getRawDb() : null;
        if (!rawDb) return res.status(500).json({ error: 'Raw database handle is unavailable.' });
        const settings = getMemoryMaintenanceSettings(db);
        if (!settings.api_endpoint || !settings.api_key || !settings.model_name) {
            return res.status(400).json({ error: 'Memory maintenance model URL, key, and model are required.' });
        }
        const result = await runMemoryTemporalBindingBatch(rawDb, charObj, settings, {
            limit: req.body?.limit,
            offset: req.body?.offset,
            source: req.body?.source || 'new',
            include_archived: req.body?.include_archived,
            dry_run: req.body?.dry_run,
            source_name: 'small-model-temporal-binding'
        });
        let rebuiltMemoryIndex = false;
        let rebuildWarning = '';
        if (!result.empty && parseBooleanFlag(req.body?.rebuild_index)) {
            try {
                await memory.rebuildIndex(characterId);
                rebuiltMemoryIndex = true;
            } catch (e) {
                rebuildWarning = e.message || 'Memory index rebuild failed.';
            }
        }
        const wsClients = getWsClients(req.user.id);
        wsClients.forEach(c => {
            if (c.readyState === 1) c.send(JSON.stringify({ type: 'memory_update', characterId }));
        });
        res.json({
            ...result,
            rebuiltMemoryIndex,
            rebuildWarning
        });
    } catch (e) {
        if (e?.payload) {
            return res.status(e.status || 500).json(e.payload);
        }
        console.error('Memory temporal binding run failed:', e);
        res.status(e.status || 500).json({ error: e.message });
    }
});

app.post('/api/memories/:characterId/maintenance/temporal-binding-auto-run', authMiddleware, async (req, res) => {
    const db = req.db;
    try {
        const characterId = req.params.characterId;
        const charObj = db.getCharacter(characterId);
        if (!charObj) return res.status(404).json({ error: 'Character not found' });
        const rawDb = typeof db.getRawDb === 'function' ? db.getRawDb() : null;
        if (!rawDb) return res.status(500).json({ error: 'Raw database handle is unavailable.' });
        const settings = getMemoryMaintenanceSettings(db);
        if (!settings.api_endpoint || !settings.api_key || !settings.model_name) {
            return res.status(400).json({ error: 'Memory maintenance model URL, key, and model are required.' });
        }
        const source = normalizeMemoryTemporalBindingSource(req.body?.source || 'new');
        const batchOptions = normalizeMemoryMaintenanceBatchOptions(req.body || {}, { limitFallback: settings.batch_size || 40 });
        const limit = batchOptions.limit;
        const totalBatch = getMemoryTemporalBindingBatch(rawDb, characterId, {
            limit: 1,
            offset: 0,
            source,
            include_archived: req.body?.include_archived
        });
        const totalMatching = Number(totalBatch.total_matching || 0);
        const totalBatches = Math.max(0, Math.ceil(totalMatching / limit));
        const runControls = normalizeMemoryMaintenanceAutoRunControls({
            ...req.body,
            limit
        }, {
            limitFallback: limit,
            maxBatchesFallback: totalBatches || 1,
            maxRerollsFallback: 3,
            maxRerollsMax: 10
        });
        const runUntilEmpty = runControls.run_until_empty;
        const maxBatches = runUntilEmpty ? totalBatches : Math.min(totalBatches, runControls.max_batches);
        const maxRerolls = runControls.max_rerolls;
        const dryRun = parseBooleanFlag(req.body?.dry_run);
        const backgroundRun = req.body?.background === true;
        if (backgroundRun) {
            const activeRun = findActiveMemoryMaintenanceRun(req.user.id, characterId);
            if (activeRun) {
                return res.json({
                    success: true,
                    accepted: true,
                    reused: true,
                    run: getMemoryMaintenanceRunSnapshot(activeRun)
                });
            }
        }
        const runId = `${characterId}-supplement-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
        const wsClients = getWsClients(req.user.id);
        const runState = {
            run_id: runId,
            user_id: req.user.id,
            characterId,
            character: { id: charObj.id, name: charObj.name },
            task_mode: 'supplement',
            phase: 'queued',
            running: true,
            success: undefined,
            limit,
            max_batches: maxBatches,
            run_until_empty: runUntilEmpty,
            max_rerolls: maxRerolls,
            processed: 0,
            updated: 0,
            applied_errors: 0,
            started_at: Date.now(),
            updated_at: Date.now(),
            finished_at: 0,
            events: []
        };
        memoryMaintenanceRuns.set(runId, runState);
        const runs = [];
        const errors = [];
        let processed = 0;
        let updated = 0;
        let appliedErrors = 0;
        let lastPrompt = null;
        let lastRawResponse = '';
        let stoppedReason = '';
        const sendProgress = (phase, extra = {}) => {
            const payload = {
                type: 'memory_maintenance_progress',
                data: {
                    run_id: runId,
                    task_mode: 'supplement',
                    phase,
                    characterId,
                    character: { id: charObj.id, name: charObj.name },
                    limit,
                    max_batches: maxBatches,
                    run_until_empty: runUntilEmpty,
                    max_rerolls: maxRerolls,
                    processed,
                    updated,
                    applied_errors: appliedErrors,
                    timestamp: Date.now(),
                    ...extra
                }
            };
            const eventData = payload.data;
            runState.phase = phase;
            runState.updated_at = eventData.timestamp;
            runState.running = !['done', 'stopped'].includes(phase);
            runState.processed = eventData.processed ?? runState.processed;
            runState.updated = eventData.updated ?? runState.updated;
            runState.applied_errors = eventData.applied_errors ?? runState.applied_errors;
            runState.batch_number = eventData.batch_number ?? runState.batch_number;
            runState.attempt = eventData.attempt ?? runState.attempt;
            runState.reroll = eventData.reroll ?? runState.reroll;
            runState.message = eventData.message || runState.message || '';
            runState.remaining_pending_after_batch = eventData.remaining_pending_after_batch ?? runState.remaining_pending_after_batch;
            runState.pending_before = eventData.pending_before ?? runState.pending_before;
            runState.new_memory_samples = eventData.new_memory_samples || runState.new_memory_samples || [];
            runState.stopped_reason = eventData.stopped_reason || runState.stopped_reason || '';
            runState.can_continue = eventData.can_continue ?? runState.can_continue;
            runState.continue_from = eventData.continue_from || runState.continue_from || null;
            runState.errors = eventData.errors || runState.errors || [];
            runState.stats = eventData.stats || runState.stats || null;
            if (!runState.running) {
                runState.success = eventData.success;
                runState.finished_at = eventData.timestamp;
            }
            runState.events.push(eventData);
            if (runState.events.length > 100) runState.events.splice(0, runState.events.length - 100);
            broadcastToWsClients(wsClients, payload);
        };

        const executeTemporalBindingRun = async () => {
            await yieldToServerLoop();
            sendProgress('start', {
                message: '自动补充已开始。',
                total_matching: totalMatching,
                total_batches: totalBatches
            });

        for (let idx = 0; idx < maxBatches; idx++) {
            const batchNumber = idx + 1;
            const offset = idx * limit;
            let result = null;
            let batchUpdated = 0;
            let batchErrors = 0;
            let finalAttemptNumber = 1;
            let shouldStopAfterBatch = false;
            const rollAttempts = [];
            sendProgress('batch_start', {
                batch_number: batchNumber,
                pending_before: Math.max(0, totalMatching - offset)
            });
            for (let reroll = 0; reroll <= maxRerolls; reroll++) {
                const attemptNumber = reroll + 1;
                finalAttemptNumber = attemptNumber;
                sendProgress('attempt_start', {
                    batch_number: batchNumber,
                    attempt: attemptNumber,
                    reroll,
                    message: reroll > 0 ? `第 ${batchNumber} 批补充重 roll 第 ${reroll} 次。` : `第 ${batchNumber} 批开始补充标签。`
                });
                try {
                    const candidate = await runMemoryTemporalBindingBatch(rawDb, charObj, settings, {
                        limit,
                        offset,
                        source,
                        dry_run: dryRun,
                        source_name: reroll > 0 ? `small-model-temporal-binding-reroll-${reroll}` : 'small-model-temporal-binding'
                    });
                    result = candidate;
                    lastPrompt = candidate.prompt || lastPrompt;
                    lastRawResponse = candidate.raw_response || lastRawResponse;
                    if (candidate.empty) break;
                    batchUpdated = Number(candidate.apply?.updated || 0);
                    batchErrors = Number(candidate.apply?.errors?.length || 0) + Number(candidate.normalized?.errors?.length || 0);
                    sendProgress('attempt_result', {
                        batch_number: batchNumber,
                        attempt: attemptNumber,
                        reroll,
                        item_count: candidate.batch?.item_count || 0,
                        ids: candidate.batch?.ids || [],
                        updated: batchUpdated,
                        source_label_count: candidate.normalized?.source_label_count || 0,
                        time_label_count: candidate.normalized?.time_label_count || 0,
                        errors: batchErrors,
                        remaining_pending_after_batch: Math.max(0, totalMatching - Math.min(totalMatching, offset + limit)),
                        new_memory_samples: [`来源标签 ${candidate.normalized?.source_label_count || 0} 条，时间标签 ${candidate.normalized?.time_label_count || 0} 条`]
                    });
                    const noProgress = !dryRun && batchUpdated <= 0;
                    if (noProgress) {
                        const attemptError = {
                            attempt: attemptNumber,
                            reroll,
                            kind: 'no_progress',
                            error: 'No memory records were updated; rerolling this supplemental batch.',
                            normalized_errors: (candidate.normalized?.errors || []).slice(0, 6),
                            raw_response_preview: candidate.raw_response ? clipMemoryDisplayText(candidate.raw_response, 1600) : ''
                        };
                        rollAttempts.push(attemptError);
                        sendProgress('attempt_no_progress', {
                            batch_number: batchNumber,
                            attempt: attemptNumber,
                            reroll,
                            attempt_error: attemptError,
                            will_reroll: reroll < maxRerolls
                        });
                        if (reroll < maxRerolls) {
                            result = null;
                            continue;
                        }
                    }
                    break;
                } catch (e) {
                    lastPrompt = e?.payload?.prompt || lastPrompt;
                    lastRawResponse = e?.payload?.raw_response || lastRawResponse;
                    const attemptError = buildMemoryMaintenanceAttemptError(e, attemptNumber);
                    rollAttempts.push(attemptError);
                    const nonRetryable = isNonRetryableMemoryMaintenanceError(e);
                    sendProgress('attempt_error', {
                        batch_number: batchNumber,
                        attempt: attemptNumber,
                        reroll,
                        attempt_error: attemptError,
                        will_reroll: !nonRetryable && reroll < maxRerolls,
                        message: nonRetryable ? '小模型鉴权失败，已停止自动补充；请检查 URL、Key 和模型名。' : undefined
                    });
                    if (nonRetryable) {
                        errors.push({
                            batch_number: batchNumber,
                            error: `Small model authentication failed: ${e.message}`,
                            attempts: rollAttempts,
                            payload: e.payload || null
                        });
                        stoppedReason = 'auth_error';
                        shouldStopAfterBatch = true;
                        break;
                    }
                    if (reroll < maxRerolls) continue;
                    errors.push({
                        batch_number: batchNumber,
                        error: `Small model failed after ${maxRerolls} reroll(s): ${e.message}`,
                        attempts: rollAttempts,
                        payload: e.payload || null
                    });
                    stoppedReason = 'error';
                    shouldStopAfterBatch = true;
                    break;
                }
            }
            if (shouldStopAfterBatch) break;
            if (!result) {
                stoppedReason = 'error';
                errors.push({
                    batch_number: batchNumber,
                    error: `Small model did not produce a usable supplemental result after ${maxRerolls} reroll(s).`,
                    attempts: rollAttempts
                });
                break;
            }
            if (result.empty) {
                runs.push({ batch_number: batchNumber, empty: true, message: result.message, attempts: rollAttempts });
                stoppedReason = 'empty';
                break;
            }
            processed += Number(result.batch?.item_count || 0);
            updated += batchUpdated;
            appliedErrors += batchErrors;
            const runRecord = {
                batch_number: batchNumber,
                ids: result.batch?.ids || [],
                item_count: result.batch?.item_count || 0,
                updated: batchUpdated,
                source_label_count: result.normalized?.source_label_count || 0,
                time_label_count: result.normalized?.time_label_count || 0,
                errors: batchErrors,
                remaining_pending_after_batch: Math.max(0, totalMatching - Math.min(totalMatching, offset + limit)),
                rerolls: Math.max(0, finalAttemptNumber - 1),
                attempts: rollAttempts,
                model: result.model
            };
            runs.push(runRecord);
            sendProgress('batch_success', {
                ...runRecord,
                processed,
                updated,
                applied_errors: appliedErrors
            });
            if (dryRun) {
                stoppedReason = 'dry_run';
                break;
            }
        }

        const stats = getMemoryMaintenanceStats(rawDb, characterId);
        const responsePayload = {
            success: errors.length === 0,
            character: { id: charObj.id, name: charObj.name },
            mode: 'auto',
            task_mode: 'supplement',
            dry_run: dryRun,
            limit,
            max_batches: maxBatches,
            run_until_empty: runUntilEmpty,
            max_rerolls: maxRerolls,
            processed,
            updated,
            applied_errors: appliedErrors,
            stopped_on_error: stoppedReason === 'error' && errors.length > 0,
            stopped_reason: stoppedReason || 'completed',
            errors,
            runs,
            prompt: lastPrompt,
            raw_response: lastRawResponse,
            stats,
            can_continue: stoppedReason === 'error',
            continue_from: {
                status: 'new',
                offset: processed,
                pending: Math.max(0, totalMatching - processed)
            }
        };
        sendProgress(responsePayload.success ? 'done' : 'stopped', {
            stopped_reason: responsePayload.stopped_reason,
            success: responsePayload.success,
            stats,
            can_continue: responsePayload.can_continue,
            continue_from: responsePayload.continue_from,
            errors: errors.slice(-3),
            runs_count: runs.length
        });
        if (!res.headersSent) {
            res.status(responsePayload.success ? 200 : 422).json(responsePayload);
        }
        return responsePayload;
        };

        const failTemporalBindingRun = (e) => {
            console.error('Memory temporal binding auto-run failed:', e);
            runState.running = false;
            runState.success = false;
            runState.finished_at = Date.now();
            runState.stopped_reason = 'error';
            runState.errors = [{ error: e.message || 'Memory temporal binding failed.' }];
            sendProgress('stopped', {
                stopped_reason: 'error',
                success: false,
                errors: runState.errors,
                message: `自动补充停止：${e.message || 'error'}。`
            });
            if (!res.headersSent) {
                res.status(e.status || 500).json({ error: e.message });
            }
        };

        if (backgroundRun) {
            res.json({
                success: true,
                accepted: true,
                run: getMemoryMaintenanceRunSnapshot(runState)
            });
            enqueueBackgroundTask({
                key: `memory-maintenance:${req.user.id}`,
                dedupeKey: `memory-maintenance:${req.user.id}:${characterId}:supplement`,
                maxPending: 2,
                task: executeTemporalBindingRun
            }).then((queueResult) => {
                if (queueResult?.skipped) {
                    const reason = queueResult.reason || 'queue_full';
                    sendProgress('stopped', {
                        stopped_reason: reason,
                        success: false,
                        errors: [{ error: reason }],
                        message: reason === 'duplicate'
                            ? '这个角色已有自动补充在跑。'
                            : '这个账号的自动补充队列已满。'
                    });
                }
            }).catch(failTemporalBindingRun);
            return;
        }

        await executeTemporalBindingRun();
    } catch (e) {
        console.error('Memory temporal binding auto-run failed:', e);
        if (!res.headersSent) {
            res.status(e.status || 500).json({ error: e.message });
        }
    }
});

app.post('/api/memories/:characterId/maintenance/run', authMiddleware, async (req, res) => {
    const db = req.db;
    const memory = req.memory;
    try {
        const characterId = req.params.characterId;
        const charObj = db.getCharacter(characterId);
        if (!charObj) return res.status(404).json({ error: 'Character not found' });
        const rawDb = typeof db.getRawDb === 'function' ? db.getRawDb() : null;
        if (!rawDb) return res.status(500).json({ error: 'Raw database handle is unavailable.' });
        const settings = getMemoryMaintenanceSettings(db);
        if (!settings.api_endpoint || !settings.api_key || !settings.model_name) {
            return res.status(400).json({ error: 'Memory maintenance model URL, key, and model are required.' });
        }
        const result = await runMemoryMaintenanceBatch(rawDb, memory, charObj, settings, {
            limit: req.body?.limit,
            offset: req.body?.offset,
            after_id: req.body?.after_id,
            status: req.body?.status || 'pending',
            include_archived: req.body?.include_archived,
            dry_run: req.body?.dry_run,
            source: 'small-model-migration'
        });
        let rebuiltMemoryIndex = false;
        let rebuildWarning = '';
        if (!result.empty && parseBooleanFlag(req.body?.rebuild_index)) {
            try {
                await memory.rebuildIndex(characterId);
                rebuiltMemoryIndex = true;
            } catch (e) {
                rebuildWarning = e.message || 'Memory index rebuild failed.';
            }
        }
        const wsClients = getWsClients(req.user.id);
        wsClients.forEach(c => {
            if (c.readyState === 1) c.send(JSON.stringify({ type: 'memory_update', characterId }));
        });
        res.json({
            ...result,
            rebuiltMemoryIndex,
            rebuildWarning
        });
    } catch (e) {
        if (e?.payload) {
            return res.status(e.status || 500).json(e.payload);
        }
        console.error('Memory maintenance run failed:', e);
        res.status(e.status || 500).json({ error: e.message });
    }
});

app.get('/api/memory-maintenance/runs', authMiddleware, (req, res) => {
    try {
        pruneMemoryMaintenanceRuns();
        const activeOnly = parseBooleanFlag(req.query.active);
        const characterId = String(req.query.character_id || '').trim();
        const runs = Array.from(memoryMaintenanceRuns.values())
            .filter(run => String(run.user_id) === String(req.user.id))
            .filter(run => !activeOnly || run.running)
            .filter(run => !characterId || String(run.characterId) === characterId)
            .sort((a, b) => Number(b.updated_at || 0) - Number(a.updated_at || 0))
            .map(getMemoryMaintenanceRunSnapshot);
        res.json({ success: true, runs });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/memory-maintenance/runs/:runId', authMiddleware, (req, res) => {
    try {
        pruneMemoryMaintenanceRuns();
        const run = memoryMaintenanceRuns.get(String(req.params.runId || ''));
        if (!run || String(run.user_id) !== String(req.user.id)) {
            return res.status(404).json({ error: 'Run not found' });
        }
        res.json({ success: true, run: getMemoryMaintenanceRunSnapshot(run) });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/memories/:characterId/maintenance/auto-run', authMiddleware, async (req, res) => {
    const db = req.db;
    const memory = req.memory;
    try {
        const characterId = req.params.characterId;
        const charObj = db.getCharacter(characterId);
        if (!charObj) return res.status(404).json({ error: 'Character not found' });
        const rawDb = typeof db.getRawDb === 'function' ? db.getRawDb() : null;
        if (!rawDb) return res.status(500).json({ error: 'Raw database handle is unavailable.' });
        const settings = getMemoryMaintenanceSettings(db);
        if (!settings.api_endpoint || !settings.api_key || !settings.model_name) {
            return res.status(400).json({ error: 'Memory maintenance model URL, key, and model are required.' });
        }
        const runControls = normalizeMemoryMaintenanceAutoRunControls(req.body || {}, {
            limitFallback: settings.batch_size || 30,
            maxBatchesFallback: 10,
            maxRerollsFallback: 3,
            maxRerollsMax: 10
        });
        const limit = runControls.limit;
        const runUntilEmpty = runControls.run_until_empty;
        const maxBatches = runControls.max_batches;
        const maxRerolls = runControls.max_rerolls;
        const dryRun = parseBooleanFlag(req.body?.dry_run);
        const backgroundRun = req.body?.background === true;
        if (backgroundRun) {
            const activeRun = findActiveMemoryMaintenanceRun(req.user.id, characterId);
            if (activeRun) {
                return res.json({
                    success: true,
                    accepted: true,
                    reused: true,
                    run: getMemoryMaintenanceRunSnapshot(activeRun)
                });
            }
        }
        const runId = `${characterId}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
        const wsClients = getWsClients(req.user.id);
        const runState = {
            run_id: runId,
            user_id: req.user.id,
            characterId,
            character: { id: charObj.id, name: charObj.name },
            phase: 'queued',
            running: true,
            success: undefined,
            limit,
            max_batches: maxBatches,
            run_until_empty: runUntilEmpty,
            max_rerolls: maxRerolls,
            processed: 0,
            updated: 0,
            applied_errors: 0,
            started_at: Date.now(),
            updated_at: Date.now(),
            finished_at: 0,
            events: []
        };
        memoryMaintenanceRuns.set(runId, runState);
        const runs = [];
        const errors = [];
        let processed = 0;
        let updated = 0;
        let appliedErrors = 0;
        let lastPrompt = null;
        let lastRawResponse = '';
        let stoppedReason = '';
        const sendProgress = (phase, extra = {}) => {
            const payload = {
                type: 'memory_maintenance_progress',
                data: {
                    run_id: runId,
                    phase,
                    characterId,
                    character: { id: charObj.id, name: charObj.name },
                    limit,
                    max_batches: maxBatches,
                    run_until_empty: runUntilEmpty,
                    max_rerolls: maxRerolls,
                    processed,
                    updated,
                    applied_errors: appliedErrors,
                    timestamp: Date.now(),
                    ...extra
                }
            };
            const eventData = payload.data;
            runState.phase = phase;
            runState.updated_at = eventData.timestamp;
            runState.running = !['done', 'stopped'].includes(phase);
            runState.processed = eventData.processed ?? runState.processed;
            runState.updated = eventData.updated ?? runState.updated;
            runState.applied_errors = eventData.applied_errors ?? runState.applied_errors;
            runState.batch_number = eventData.batch_number ?? runState.batch_number;
            runState.attempt = eventData.attempt ?? runState.attempt;
            runState.reroll = eventData.reroll ?? runState.reroll;
            runState.message = eventData.message || runState.message || '';
            runState.remaining_pending_after_batch = eventData.remaining_pending_after_batch ?? runState.remaining_pending_after_batch;
            runState.pending_before = eventData.pending_before ?? runState.pending_before;
            runState.new_memory_samples = eventData.new_memory_samples || runState.new_memory_samples || [];
            runState.stopped_reason = eventData.stopped_reason || runState.stopped_reason || '';
            runState.can_continue = eventData.can_continue ?? runState.can_continue;
            runState.continue_from = eventData.continue_from || runState.continue_from || null;
            runState.errors = eventData.errors || runState.errors || [];
            runState.stats = eventData.stats || runState.stats || null;
            if (!runState.running) {
                runState.success = eventData.success;
                runState.finished_at = eventData.timestamp;
            }
            runState.events.push(eventData);
            if (runState.events.length > 100) runState.events.splice(0, runState.events.length - 100);
            broadcastToWsClients(wsClients, payload);
        };

        const executeMemoryMaintenanceRun = async () => {
            await yieldToServerLoop();
            sendProgress('start', {
                message: req.body?.continue_from_breakpoint
                    ? '从断点继续自动总结。'
                    : '自动总结已开始。'
            });

        for (let idx = 0; maxBatches === null || idx < maxBatches; idx++) {
            const batchNumber = idx + 1;
            let result = null;
            let statsAfterBatch = null;
            let batchUpdated = 0;
            let batchErrors = 0;
            let finalAttemptNumber = 1;
            let shouldStopAfterBatch = false;
            let noProgressAfterRerolls = false;
            const rollAttempts = [];
            let statsBeforeBatch = null;
            try {
                statsBeforeBatch = getMemoryMaintenanceStats(rawDb, characterId);
            } catch (_) {
                statsBeforeBatch = null;
            }
            sendProgress('batch_start', {
                batch_number: batchNumber,
                pending_before: Number(statsBeforeBatch?.pending || 0)
            });

            for (let reroll = 0; reroll <= maxRerolls; reroll++) {
                const attemptNumber = reroll + 1;
                finalAttemptNumber = attemptNumber;
                sendProgress('attempt_start', {
                    batch_number: batchNumber,
                    attempt: attemptNumber,
                    reroll,
                    message: reroll > 0 ? `第 ${batchNumber} 批重 roll 第 ${reroll} 次。` : `第 ${batchNumber} 批开始调用小模型。`
                });
                try {
                    const candidate = await runMemoryMaintenanceBatch(rawDb, memory, charObj, settings, {
                        limit,
                        offset: 0,
                        status: 'pending',
                        dry_run: dryRun,
                        source: reroll > 0 ? `small-model-auto-migration-reroll-${reroll}` : 'small-model-auto-migration'
                    });
                    result = candidate;
                    lastPrompt = candidate.prompt || lastPrompt;
                    lastRawResponse = candidate.raw_response || lastRawResponse;
                    if (candidate.empty) break;

                    batchUpdated = Number(candidate.apply?.updated || 0);
                    batchErrors = Number(candidate.apply?.errors?.length || 0) + Number(candidate.normalized?.errors?.length || 0);
                    statsAfterBatch = getMemoryMaintenanceStats(rawDb, characterId);
                    sendProgress('attempt_result', {
                        batch_number: batchNumber,
                        attempt: attemptNumber,
                        reroll,
                        item_count: candidate.batch?.item_count || 0,
                        ids: candidate.batch?.ids || [],
                        updated: batchUpdated,
                        new_memory_count: candidate.normalized?.new_memory_count || 0,
                        old_action_count: candidate.normalized?.old_action_count || 0,
                        errors: batchErrors,
                        remaining_pending_before_batch: candidate.batch?.remaining_pending || 0,
                        remaining_pending_after_batch: statsAfterBatch.pending || 0,
                        new_memory_samples: Array.from(new Set((candidate.normalized?.apply_items || [])
                            .map(item => item.consolidation_summary)
                            .filter(Boolean))).slice(0, 5)
                    });
                    const noProgress = !dryRun
                        && batchUpdated <= 0
                        && Number(statsAfterBatch.pending || 0) >= Number(candidate.batch?.remaining_pending || 0);
                    if (noProgress) {
                        const noProgressAttempt = buildMemoryMaintenanceNoProgressAttempt(candidate, statsAfterBatch, attemptNumber);
                        rollAttempts.push(noProgressAttempt);
                        sendProgress('attempt_no_progress', {
                            batch_number: batchNumber,
                            attempt: attemptNumber,
                            reroll,
                            attempt_error: noProgressAttempt,
                            will_reroll: reroll < maxRerolls
                        });
                        if (reroll < maxRerolls) {
                            result = null;
                            continue;
                        }
                        noProgressAfterRerolls = true;
                    }
                    break;
                } catch (e) {
                    lastPrompt = e?.payload?.prompt || lastPrompt;
                    lastRawResponse = e?.payload?.raw_response || lastRawResponse;
                    const attemptError = buildMemoryMaintenanceAttemptError(e, attemptNumber);
                    rollAttempts.push(attemptError);
                    const nonRetryable = isNonRetryableMemoryMaintenanceError(e);
                    sendProgress('attempt_error', {
                        batch_number: batchNumber,
                        attempt: attemptNumber,
                        reroll,
                        attempt_error: attemptError,
                        will_reroll: !nonRetryable && reroll < maxRerolls,
                        message: nonRetryable ? '小模型鉴权失败，已停止自动总结；请检查 URL、Key 和模型名。' : undefined
                    });
                    if (nonRetryable) {
                        errors.push({
                            batch_number: batchNumber,
                            error: `Small model authentication failed: ${e.message}`,
                            attempts: rollAttempts,
                            payload: e.payload || null
                        });
                        stoppedReason = 'auth_error';
                        shouldStopAfterBatch = true;
                        break;
                    }
                    if (reroll < maxRerolls) continue;
                    errors.push({
                        batch_number: batchNumber,
                        error: `Small model failed after ${maxRerolls} reroll(s): ${e.message}`,
                        attempts: rollAttempts,
                        payload: e.payload || null
                    });
                    stoppedReason = 'error';
                    shouldStopAfterBatch = true;
                    break;
                }
            }

            if (shouldStopAfterBatch) break;
            if (!result) {
                stoppedReason = 'error';
                errors.push({
                    batch_number: batchNumber,
                    error: `Small model did not produce a usable result after ${maxRerolls} reroll(s).`,
                    attempts: rollAttempts
                });
                break;
            }
            if (result.empty) {
                const emptyRun = {
                    batch_number: batchNumber,
                    empty: true,
                    message: result.message,
                    remaining_pending: result.batch?.remaining_pending || 0,
                    rerolls: Math.max(0, finalAttemptNumber - 1),
                    attempts: rollAttempts
                };
                runs.push(emptyRun);
                sendProgress('batch_empty', emptyRun);
                stoppedReason = 'empty';
                break;
            }

            processed += Number(result.batch?.item_count || 0);
            updated += batchUpdated;
            appliedErrors += batchErrors;
            if (!statsAfterBatch) statsAfterBatch = getMemoryMaintenanceStats(rawDb, characterId);
            const runRecord = {
                batch_number: batchNumber,
                ids: result.batch?.ids || [],
                item_count: result.batch?.item_count || 0,
                updated: batchUpdated,
                new_memory_count: result.normalized?.new_memory_count || 0,
                old_action_count: result.normalized?.old_action_count || 0,
                errors: batchErrors,
                remaining_pending_before_batch: result.batch?.remaining_pending || 0,
                remaining_pending_after_batch: statsAfterBatch.pending || 0,
                rerolls: Math.max(0, finalAttemptNumber - 1),
                attempts: rollAttempts,
                model: result.model
            };
            runs.push(runRecord);
            sendProgress('batch_success', {
                ...runRecord,
                processed,
                updated,
                applied_errors: appliedErrors
            });
            if (dryRun) {
                stoppedReason = 'dry_run';
                break;
            }
            if (noProgressAfterRerolls) {
                stoppedReason = 'no_progress';
                errors.push({
                    batch_number: batchNumber,
                    error: `No memory records were updated after ${maxRerolls} reroll(s); auto-run stopped to avoid repeating the same pending batch.`,
                    attempts: rollAttempts
                });
                break;
            }
        }

        let rebuiltMemoryIndex = false;
        let rebuildWarning = '';
        if (!dryRun && processed > 0 && parseBooleanFlag(req.body?.rebuild_index)) {
            try {
                await memory.rebuildIndex(characterId);
                rebuiltMemoryIndex = true;
            } catch (e) {
                rebuildWarning = e.message || 'Memory index rebuild failed.';
            }
        }
        broadcastToWsClients(wsClients, { type: 'memory_update', characterId });
        const stats = getMemoryMaintenanceStats(rawDb, characterId);
        const responsePayload = {
            success: errors.length === 0,
            character: { id: charObj.id, name: charObj.name },
            mode: 'auto',
            dry_run: dryRun,
            limit,
            max_batches: maxBatches,
            run_until_empty: runUntilEmpty,
            max_rerolls: maxRerolls,
            processed,
            updated,
            applied_errors: appliedErrors,
            stopped_on_error: stoppedReason === 'error' && errors.length > 0,
            stopped_reason: stoppedReason || (maxBatches === null ? 'completed' : 'max_batches'),
            errors,
            runs,
            prompt: lastPrompt,
            raw_response: lastRawResponse,
            rebuiltMemoryIndex,
            rebuildWarning,
            stats,
            can_continue: ['error', 'no_progress'].includes(stoppedReason) && Number(stats.pending || 0) > 0,
            continue_from: {
                status: 'pending',
                offset: 0,
                pending: Number(stats.pending || 0)
            }
        };
        sendProgress(responsePayload.success ? 'done' : 'stopped', {
            stopped_reason: responsePayload.stopped_reason,
            success: responsePayload.success,
            stats,
            can_continue: responsePayload.can_continue,
            continue_from: responsePayload.continue_from,
            errors: errors.slice(-3),
            runs_count: runs.length
        });
        if (!res.headersSent) {
            res.status(responsePayload.success ? 200 : 422).json(responsePayload);
        }
        return responsePayload;
        };

        const failMemoryMaintenanceRun = (e) => {
            console.error('Memory maintenance auto-run failed:', e);
            runState.running = false;
            runState.success = false;
            runState.finished_at = Date.now();
            runState.stopped_reason = 'error';
            runState.errors = [{ error: e.message || 'Memory maintenance failed.' }];
            sendProgress('stopped', {
                stopped_reason: 'error',
                success: false,
                errors: runState.errors,
                message: `自动总结停止：${e.message || 'error'}。`
            });
            if (!res.headersSent) {
                res.status(e.status || 500).json({ error: e.message });
            }
        };

        if (backgroundRun) {
            res.json({
                success: true,
                accepted: true,
                run: getMemoryMaintenanceRunSnapshot(runState)
            });
            enqueueBackgroundTask({
                key: `memory-maintenance:${req.user.id}`,
                dedupeKey: `memory-maintenance:${req.user.id}:${characterId}`,
                maxPending: 2,
                task: executeMemoryMaintenanceRun
            }).then((queueResult) => {
                if (queueResult?.skipped) {
                    const reason = queueResult.reason || 'queue_full';
                    sendProgress('stopped', {
                        stopped_reason: reason,
                        success: false,
                        errors: [{ error: reason }],
                        message: reason === 'duplicate'
                            ? '这个角色已有自动总结在跑。'
                            : '这个账号的自动总结队列已满。'
                    });
                }
            }).catch(failMemoryMaintenanceRun);
            return;
        }

        await executeMemoryMaintenanceRun();
    } catch (e) {
        console.error('Memory maintenance auto-run failed:', e);
        if (!res.headersSent) {
            res.status(e.status || 500).json({ error: e.message });
        }
    }
});

app.post('/api/memories/:characterId/maintenance/apply', authMiddleware, async (req, res) => {
    const db = req.db;
    const memory = req.memory;
    try {
        const characterId = req.params.characterId;
        const charObj = db.getCharacter(characterId);
        if (!charObj) return res.status(404).json({ error: 'Character not found' });
        const rawDb = typeof db.getRawDb === 'function' ? db.getRawDb() : null;
        if (!rawDb) return res.status(500).json({ error: 'Raw database handle is unavailable.' });
        const items = Array.isArray(req.body?.items) ? req.body.items : (Array.isArray(req.body) ? req.body : []);
        if (items.length === 0) {
            return res.status(400).json({ error: 'items array is required.' });
        }
        if (items.length > 100) {
            return res.status(413).json({ error: 'Too many maintenance items. Limit is 100.' });
        }
        const result = applyMemoryMaintenanceItems(rawDb, characterId, items, req.body?.source || 'small-model');
        const requestedFullRebuild = parseBooleanFlag(req.query.rebuild_index ?? req.body?.rebuild_index);
        let indexRefresh = null;
        let indexRefreshWarning = '';
        if (!requestedFullRebuild) {
            try {
                indexRefresh = await refreshMaintenanceMemoryIndex(memory, characterId, result);
            } catch (e) {
                indexRefreshWarning = e.message || 'Memory index refresh failed.';
                console.error(`[Memory Maintenance] Failed to refresh memory index for ${characterId}:`, indexRefreshWarning);
            }
        }
        let rebuiltMemoryIndex = false;
        let rebuildWarning = '';
        if (requestedFullRebuild) {
            try {
                await memory.rebuildIndex(characterId);
                rebuiltMemoryIndex = true;
            } catch (e) {
                rebuildWarning = e.message || 'Memory index rebuild failed.';
                console.error(`[Memory Maintenance] Failed to rebuild memory index for ${characterId}:`, rebuildWarning);
            }
        }
        const wsClients = getWsClients(req.user.id);
        wsClients.forEach(c => {
            if (c.readyState === 1) {
                c.send(JSON.stringify({ type: 'memory_update', characterId }));
            }
        });
        res.json({
            success: result.updated > 0,
            character: { id: charObj.id, name: charObj.name },
            updated: result.updated,
            errors: result.errors,
            indexRefresh,
            indexRefreshWarning,
            rebuiltMemoryIndex,
            rebuildWarning,
            stats: getMemoryMaintenanceStats(rawDb, characterId)
        });
    } catch (e) {
        console.error('Memory maintenance apply failed:', e);
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

        const requestedPool = req.body?.pool || req.query?.pool || 'auto';
        const sweepResult = await memory.sweepOverflowMemories(charObj, { pool: requestedPool });
        const refreshed = db.getCharacter(req.params.characterId);
        const lastError = refreshed?.sweep_last_error || '';
        const savedCount = Number(sweepResult?.savedCount || 0);
        const sweepPool = sweepResult?.pool || requestedPool || 'auto';

        if (sweepResult?.status === 'running') {
            return res.status(409).json({
                success: false,
                error: sweepResult.error || lastError || 'Another long-term memory sweep is already running.',
                savedCount,
                pool: sweepPool
            });
        }

        if (sweepResult?.status === 'cooldown') {
            return res.status(429).json({
                success: false,
                error: sweepResult.error || lastError || 'Memory sweep cooldown active.',
                savedCount,
                pool: sweepPool,
                remainingSeconds: Number(sweepResult.remainingSeconds || 0)
            });
        }

        if (savedCount > 0) {
            return res.json({
                success: true,
                savedCount,
                pool: sweepPool,
                consumedCount: Number(sweepResult?.consumedCount || 0),
                warning: lastError || '',
                message: `Long-term memory sweep completed for ${sweepPool}. Saved ${savedCount} memories.`
            });
        }

        if (lastError) {
            return res.status(400).json({
                success: false,
                error: lastError,
                savedCount,
                pool: sweepPool
            });
        }

        res.json({
            success: true,
            savedCount,
            pool: sweepPool,
            consumedCount: Number(sweepResult?.consumedCount || 0),
            message: savedCount > 0 ? `Long-term memory sweep completed for ${sweepPool}.` : `No new long-term memories were extracted for ${sweepPool}.`
        });
    } catch (e) {
        console.error('Manual sweep failed:', e);
        res.status(500).json({ error: e.message });
    }
});

// 6. Update / delete a Memory manually
app.patch('/api/memories/bulk', authMiddleware, async (req, res) => {
    const db = req.db;
    const memory = req.memory;
    const wsClients = getWsClients(req.user.id);
    try {
        const ids = normalizeMemoryIdList(req.body?.ids);
        const patch = normalizeManualMemoryPatch(req.body?.patch || req.body || {});
        const characterIds = new Set();
        const idsByCharacter = new Map();
        const previousRowsByCharacter = new Map();
        let updated = 0;
        for (const id of ids) {
            const mem = db.getMemory(id);
            if (!mem) continue;
            db.updateMemory(id, patch);
            updated += 1;
            const characterId = String(mem.character_id || '');
            characterIds.add(characterId);
            if (!idsByCharacter.has(characterId)) idsByCharacter.set(characterId, []);
            if (!previousRowsByCharacter.has(characterId)) previousRowsByCharacter.set(characterId, []);
            idsByCharacter.get(characterId).push(id);
            previousRowsByCharacter.get(characterId).push(mem);
        }
        for (const characterId of characterIds) {
            if (memory?.refreshMemoryIndexEntries) {
                await memory.refreshMemoryIndexEntries(characterId, idsByCharacter.get(characterId) || [], {
                    previousRows: previousRowsByCharacter.get(characterId) || []
                });
            } else if (memory?.rebuildIndex) {
                await memory.rebuildIndex(characterId);
            }
            wsClients.forEach(c => {
                if (c.readyState === 1) c.send(JSON.stringify({ type: 'memory_update', characterId }));
            });
        }
        res.json({ success: true, updated, ids, character_ids: Array.from(characterIds), patch });
    } catch (e) {
        res.status(e.status || 500).json({ error: e.message });
    }
});

app.patch('/api/memories/:id', authMiddleware, async (req, res) => {
    const db = req.db;
    const memory = req.memory;
    const wsClients = getWsClients(req.user.id);
    try {
        const memoryId = normalizeMemoryId(req.params.id);
        const mem = db.getMemory(memoryId);
        if (!mem) return res.status(404).json({ error: 'Memory not found' });
        const patch = normalizeManualMemoryPatch(req.body || {});
        db.updateMemory(memoryId, patch);
        if (memory?.refreshMemoryIndexEntries) {
            await memory.refreshMemoryIndexEntries(mem.character_id, [memoryId], { previousRows: [mem] });
        } else if (memory?.rebuildIndex) {
            await memory.rebuildIndex(mem.character_id);
        }
        wsClients.forEach(c => {
            if (c.readyState === 1) c.send(JSON.stringify({ type: 'memory_update', characterId: mem.character_id }));
        });
        res.json({
            success: true,
            id: memoryId,
            character_id: mem.character_id,
            patch
        });
    } catch (e) {
        res.status(e.status || 500).json({ error: e.message });
    }
});

app.delete('/api/memories/bulk', authMiddleware, async (req, res) => {
    const db = req.db;
    const memory = req.memory;
    const wsClients = getWsClients(req.user.id);
    try {
        const ids = normalizeMemoryIdList(req.body?.ids);
        const rows = ids
            .map(id => db.getMemory(id))
            .filter(Boolean);
        if (rows.length === 0) {
            return res.json({ success: true, deleted: 0, ids: [], character_ids: [], index_deleted: true });
        }
        const characterIds = new Set();
        const idsByCharacter = new Map();
        const previousRowsByCharacter = new Map();
        const indexTargetsByMemoryId = buildMemoryIndexTargets(db, rows);
        for (const mem of rows) {
            const memoryId = Number(mem.id || 0);
            const targets = indexTargetsByMemoryId.get(memoryId) || new Map();
            for (const target of targets.values()) {
                const characterId = String(target.characterId || '');
                if (!characterId) continue;
                characterIds.add(characterId);
                if (!idsByCharacter.has(characterId)) idsByCharacter.set(characterId, []);
                if (!previousRowsByCharacter.has(characterId)) previousRowsByCharacter.set(characterId, []);
                idsByCharacter.get(characterId).push(memoryId);
                previousRowsByCharacter.get(characterId).push(target.previousRow || mem);
            }
        }
        const indexResults = [];
        if (memory?.deleteMemoryIndexEntries) {
            for (const [characterId, memoryIds] of idsByCharacter.entries()) {
                const result = await memory.deleteMemoryIndexEntries(characterId, memoryIds);
                indexResults.push({ character_id: characterId, ...result });
                if (Array.isArray(result?.errors) && result.errors.length > 0) {
                    console.warn(`[Memory] Index delete warning for ${characterId}: ${result.errors.join('; ')}`);
                }
            }
        }
        let deleted = 0;
        for (const mem of rows) {
            db.deleteMemory(mem.id);
            deleted += 1;
        }
        for (const characterId of characterIds) {
            if (memory?.refreshMemoryIndexEntries) {
                const refreshResult = await memory.refreshMemoryIndexEntries(characterId, idsByCharacter.get(characterId) || [], {
                    previousRows: previousRowsByCharacter.get(characterId) || []
                });
                indexResults.push({ character_id: characterId, refresh: refreshResult });
            }
            wsClients.forEach(c => {
                if (c.readyState === 1) c.send(JSON.stringify({ type: 'memory_update', characterId }));
            });
        }
        res.json({
            success: true,
            deleted,
            ids: rows.map(row => row.id),
            character_ids: Array.from(characterIds),
            index_deleted: indexResults.every(result => !Array.isArray(result.errors) || result.errors.length === 0),
            index_results: indexResults
        });
    } catch (e) {
        res.status(e.status || 500).json({
            success: false,
            error: e.message,
            partial: e.partial || null,
            details: e.details || null
        });
    }
});

app.delete('/api/memories/:id', authMiddleware, async (req, res) => {
    const db = req.db;
    const memory = req.memory;
    const wsClients = getWsClients(req.user.id);
    try {
        const memoryId = normalizeMemoryId(req.params.id);
        const mem = db.getMemory(memoryId);
        if (!mem) return res.status(404).json({ error: 'Memory not found' });
        const indexTargets = buildMemoryIndexTargets(db, [mem]);
        const targetCharacters = Array.from((indexTargets.get(memoryId) || new Map()).values());
        const indexResults = [];
        if (memory?.deleteMemoryIndexEntries) {
            for (const target of targetCharacters) {
                const result = await memory.deleteMemoryIndexEntries(target.characterId, [memoryId]);
                indexResults.push({ character_id: target.characterId, ...result });
                if (Array.isArray(result?.errors) && result.errors.length > 0) {
                    console.warn(`[Memory] Index delete warning for ${target.characterId}: ${result.errors.join('; ')}`);
                }
            }
        }
        db.deleteMemory(memoryId);
        const refreshResults = [];
        if (memory?.refreshMemoryIndexEntries) {
            for (const target of targetCharacters) {
                const previousRow = target.previousRow || mem;
                const refreshResult = await memory.refreshMemoryIndexEntries(target.characterId, [memoryId], { previousRows: [previousRow] });
                refreshResults.push({ character_id: target.characterId, ...refreshResult });
            }
        }
        const characterIds = targetCharacters.map(target => target.characterId).filter(Boolean);
        for (const characterId of characterIds) {
            wsClients.forEach(c => {
                if (c.readyState === 1) c.send(JSON.stringify({ type: 'memory_update', characterId }));
            });
        }
        res.json({
            success: true,
            deleted: 1,
            id: memoryId,
            character_id: mem.character_id,
            character_ids: characterIds,
            index_deleted: indexResults.every(result => !Array.isArray(result.errors) || result.errors.length === 0),
            index_results: indexResults,
            index_refresh: refreshResults
        });
    } catch (e) {
        res.status(e.status || 500).json({
            success: false,
            error: e.message,
            partial: e.partial || null,
            details: e.details || null
        });
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
        const momentContent = typeof content === 'string' ? content.trim() : '';
        if (!momentContent) return res.status(400).json({ error: 'content required' });
        const imageUrl = typeof image_url === 'string' ? image_url.trim() : '';
        const id = db.addMoment('user', momentContent, imageUrl || null);
        res.json({ success: true, id });
    } catch (e) {
        res.status(e.status || 500).json({ error: e.message });
    }
});

// 7.5 Delete a Moment (user only)
app.delete('/api/moments/:id', authMiddleware, (req, res) => {
    const db = req.db;
    const engine = req.engine;
    const memory = req.memory;
    const wsClients = getWsClients(req.user.id);
    try {
        const moment = db.getMoment(req.params.id);
        if (!moment) return res.status(404).json({ error: 'Moment not found' });
        if (String(moment.character_id || '') !== 'user') {
            return res.status(403).json({ error: 'Only user moments can be deleted here.' });
        }
        const deleted = db.deleteMoment(moment.id);
        if (!deleted) return res.status(404).json({ error: 'Moment not found' });
        res.json({ success: true, deleted });
    } catch (e) {
        res.status(e.status || 500).json({ error: e.message });
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
        if (!char) return res.status(404).json({ error: 'Character not found' });
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
        const moment = db.getMoment(req.params.id);
        if (!moment) return res.status(404).json({ error: 'Moment not found' });
        const liked = db.toggleLike(moment.id, 'user');
        const likers = db.getLikesForMoment(moment.id).map(l => l.liker_id);

        // If the user liked it, potentially trigger a reaction from the AI
        if (liked) {
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
        res.status(e.status || 500).json({ error: e.message });
    }
});

// 8.6 Add a Comment on a Moment
app.post('/api/moments/:id/comment', authMiddleware, (req, res) => {
    const db = req.db;
    const engine = req.engine;
    const memory = req.memory;
    const wsClients = getWsClients(req.user.id);
    try {
        const { content } = req.body;
        const comment = String(content || '').trim();
        if (!comment) return res.status(400).json({ error: 'content required' });
        const moment = db.getMoment(req.params.id);
        if (!moment) return res.status(404).json({ error: 'Moment not found' });
        const commentId = db.addComment(moment.id, 'user', comment);

        // If the user commented, potentially trigger a reaction
        if (moment && moment.character_id !== 'user') {
            const userProfile = db.getUserProfile();
            const reactionRate = userProfile?.moments_reaction_rate ?? 30;
            if (Math.random() * 100 < reactionRate) {
                const char = db.getCharacter(moment.character_id);
                if (char && !char.is_blocked) {
                    const userName = userProfile?.name || 'User';
                    const contextContent = '[System] ' + userName + ' 刚刚评论了你的朋友圈动态：“' + moment.content.substring(0, 50) + '”，评论说：“' + comment + '”。你可以在私聊中回应。';
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

        res.json({ success: true, id: commentId });
    } catch (e) {
        res.status(e.status || 500).json({ error: e.message });
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
        if (!char) return res.status(404).json({ error: 'Character not found' });
        const diaries = db.getDiaries(req.params.characterId);
        res.json({
            isUnlocked: char.is_diary_unlocked === 1,
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
        const deleted = db.deleteDiary(req.params.id);
        if (!deleted) return res.status(404).json({ error: 'Diary not found' });
        res.json({ success: true, deleted });
    } catch (e) {
        res.status(e.status || 500).json({ error: e.message });
    }
});

// 10. Unlock Diaries for a Character (Password-lock mechanic)
app.post('/api/diaries/:characterId/unlock', authMiddleware, (req, res) => {
    const db = req.db;
    const engine = req.engine;
    const memory = req.memory;
    const wsClients = getWsClients(req.user.id);
    try {
        const character = db.getCharacter(req.params.characterId);
        if (!character) return res.status(404).json({ error: 'Character not found' });
        const password = typeof req.body?.password === 'string' ? req.body.password.trim() : '';
        if (!password) return res.status(400).json({ success: false, reason: 'No password provided.' });
        const result = db.verifyAndUnlockDiary(character.id, password);
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
// MOVED TO DLC: server/plugins/theme/index.js

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
        const engineContextWrapper = { getUserDb, getMemory, userId: req.user.id, skipBasePrivateWindow: true };

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

        const privateContextSummaries = typeof db.getPrivateContextSummaries === 'function'
            ? db.getPrivateContextSummaries(charId, 3)
            : [];

        // Calculate X (Recent Chat History - based on context_msg_limit)
        const contextLimit = character.context_msg_limit || 60;
        const allVisibleMsgs = db.getVisibleMessages(charId, 0);
        const recentMsgs = allVisibleMsgs.slice(-contextLimit);
        const liveHistoryWindowSize = recentMsgs.length;
        const liveMsgs = recentMsgs;
        const x_chat_text = liveMsgs.map(m => formatContextStatsHistoryMessage(db, character, m)).join('\n');
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
        if (privateContextSummaries.length > 0) {
            digestBlock = [
                '[Private Context Summaries]',
                ...privateContextSummaries.map((item, index) => `\n[Summary ${index + 1} / messages ${item.start_message_id}-${item.end_message_id} / ${item.message_count}条]\n${item.summary_text || ''}`)
            ].join('\n');
            finalSystemPrompt += `\n\n${digestBlock}`;
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
            content: formatContextStatsHistoryMessage(db, character, m)
        }));
        const estimatedWithCacheMessagesRaw = [
            { role: 'system', content: finalSystemPrompt },
            ...transformedHistory
        ];
        const estimatedWithoutCacheMessagesRaw = [
            { role: 'system', content: finalSystemPrompt },
            ...transformedHistory
        ];
        const useClaudePromptCacheShape = String(character.model_name || '').toLowerCase().includes('claude');
        const estimatedWithCacheMessages = useClaudePromptCacheShape
            ? buildClaudePromptCacheEstimateMessages(estimatedWithCacheMessagesRaw)
            : estimatedWithCacheMessagesRaw;
        const estimatedWithoutCacheMessages = estimatedWithoutCacheMessagesRaw;
        const estimatedWithCacheMessageStats = estimateJsonWrapperTokensForMessages(estimatedWithCacheMessages);
        const estimatedWithoutCacheMessageStats = estimateJsonWrapperTokensForMessages(estimatedWithoutCacheMessages);
        const estimatedHistoryTokens = transformedHistory.reduce((sum, msg) => sum + getTokenCount(msg.content) + 6, 0);
        const estimatedFullHistoryTokens = estimatedHistoryTokens;
        const estimatedSystemPromptTokens = getTokenCount(finalSystemPrompt);
        const estimatedSystemPromptWithoutDigestTokens = estimatedSystemPromptTokens;
        const estimatedMessageEnvelopeTokens = 8 + transformedHistory.length * 2;
        const estimatedFullMessageEnvelopeTokens = estimatedMessageEnvelopeTokens;
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

        const estimatedDigestTokens = getTokenCount(digestBlock || '');
        const estimatedTailTokens = getTokenCount(x_chat_text);
        const estimatedWithoutCacheXTokens = estimatedFullHistoryTokens;
        const estimatedWithCacheXTokens = estimatedHistoryTokens;
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
        let privateUnsummarizedCount = 0;
        let groupUnsummarizedCount = 0;
        let cityUnsummarizedCount = 0;
        if (!character.sweep_initialized && typeof db.initializeSweepBaseline === 'function' && typeof db.getGroups === 'function') {
            const groups = db.getGroups().filter(g => g.members.some(m => m.member_id === character.id));
            const groupWindows = groups.map(g => ({ groupId: g.id, windowLimit: g.inject_limit ?? 5 }));
            db.initializeSweepBaseline(charId, contextLimit, groupWindows);
        } else if (character.sweep_initialized) {
            const privateWindow = character.context_msg_limit || 60;
            privateUnsummarizedCount = typeof db.countOverflowMessages === 'function'
                ? db.countOverflowMessages(charId, privateWindow)
                : 0;

            if (typeof db.countOverflowGroupMessages === 'function' && typeof db.getGroups === 'function') {
                const groups = db.getGroups().filter(g => g.members.some(m => m.member_id === character.id));
                for (const g of groups) {
                    const groupWindow = g.inject_limit ?? 5;
                    groupUnsummarizedCount += db.countOverflowGroupMessages(g.id, groupWindow);
                }
            }
            if (db.city && typeof db.city.countOverflowCityLogs === 'function') {
                cityUnsummarizedCount = db.city.countOverflowCityLogs(charId, 0);
            }
            unsummarizedCount = privateUnsummarizedCount + groupUnsummarizedCount + cityUnsummarizedCount;
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
                  AND context_type NOT IN ('chat_intent', 'conversation_digest_update', 'private_context_summary_update')
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
                    OR context_type IN ('chat_intent', 'conversation_digest_update', 'private_context_summary_update')
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
                    MAX(updated_at) AS last_write_at,
                    MAX(end_message_id) AS last_message_id
                FROM private_context_summaries
                WHERE character_id = ?
            `).get(charId)
            : null;
        const latestPrivateContextSummary = typeof db.getLatestPrivateContextSummary === 'function'
            ? db.getLatestPrivateContextSummary(charId)
            : null;
        const summaryLastEndId = Math.max(
            Number(latestPrivateContextSummary?.end_message_id || 0),
            Number(character.private_summary_baseline_message_id || 0)
        );
        const overflowForSummary = contextLimit > 0 ? allVisibleMsgs.slice(0, Math.max(0, allVisibleMsgs.length - contextLimit)) : allVisibleMsgs;
        const privateSummaryPendingCount = overflowForSummary.filter(m => Number(m.id || 0) > summaryLastEndId).length;
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
        const latestConversationUsage = latestConversationAttemptMeta?.usage || {};
        const latestConversationPromptDetails = latestConversationUsage?.prompt_tokens_details || latestConversationUsage?.input_tokens_details || {};
        const lastConversationCachedReadTokens = Math.max(0, Number(
            latestConversationPromptDetails.cached_tokens
            || latestConversationPromptDetails.cache_read_input_tokens
            || latestConversationPromptDetails.cached_input_tokens
            || latestConversationUsage.cache_read_input_tokens
            || latestConversationUsage.cached_input_tokens
            || latestConversationUsage.input_cached_tokens
            || 0
        ) || 0);
        const lastConversationCacheCreationTokens = Math.max(0, Number(
            latestConversationPromptDetails.cached_creation_tokens
            || latestConversationPromptDetails.cache_creation_input_tokens
            || latestConversationUsage.cache_creation_input_tokens
            || latestConversationUsage.input_cache_creation_tokens
            || (
                Number(latestConversationUsage.claude_cache_creation_5_m_tokens || 0)
                + Number(latestConversationUsage.claude_cache_creation_1_h_tokens || 0)
            )
            || 0
        ) || 0);
        const lastConversationUncachedPromptTokens = Math.max(
            0,
            lastConversationPromptTokens - lastConversationCachedReadTokens - lastConversationCacheCreationTokens
        );
        const lastConversationProviderCacheHitRate = lastConversationPromptTokens > 0
            ? Math.round((lastConversationCachedReadTokens / lastConversationPromptTokens) * 100)
            : 0;
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
        const snapshotLooksLikeLegacyFullHistory = Number(latestConversationSnapshot?.estimated_full_history_tokens || 0) > Math.max(
            estimatedHistoryTokens * 3,
            estimatedHistoryTokens + 5000
        );
        const snapshotWithoutCacheTokens = Number(
            snapshotLooksLikeLegacyFullHistory
                ? estimatedWithoutCacheTokens
                : (
                    validLoggedUncachedRequestBodyTokens
                    || latestConversationSnapshot?.estimated_without_cache_tokens
                    || estimatedWithoutCacheTokens
                )
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
                w_private_unsummarized_count: privateUnsummarizedCount,
                w_group_unsummarized_count: groupUnsummarizedCount,
                w_city_unsummarized_count: cityUnsummarizedCount,
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
                digest_cache_hit_count: 0,
                digest_cache_last_hit_at: 0,
                digest_cache_last_write_at: conversationDigestRow?.last_write_at || 0,
                digest_cache_last_message_id: conversationDigestRow?.last_message_id || 0,
                digest_active: privateContextSummaries.length > 0,
                digest_live_history_window_size: liveHistoryWindowSize,
                private_summary_threshold: character.private_summary_threshold || 30,
                private_summary_pending_count: privateSummaryPendingCount,
                private_summary_active_count: privateContextSummaries.length,
                private_summary_last_error: character.private_summary_last_error || '',
                private_summary_last_run_at: character.private_summary_last_run_at || 0,
                private_summary_last_success_at: character.private_summary_last_success_at || 0,
                private_summary_baseline_message_id: character.private_summary_baseline_message_id || 0,
                last_actual_prompt_tokens: latestUsageRow?.prompt_tokens || 0,
                last_actual_completion_tokens: latestUsageRow?.completion_tokens || 0,
                last_actual_context_type: latestUsageRow?.context_type || '',
                last_actual_timestamp: latestUsageRow?.timestamp || 0,
                last_conversation_prompt_tokens: lastConversationPromptTokens,
                last_conversation_completion_tokens: latestConversationUsageRow?.completion_tokens || 0,
                last_conversation_context_type: latestConversationUsageRow?.context_type || '',
                last_conversation_timestamp: latestConversationUsageRow?.timestamp || 0,
                last_conversation_uncached_prompt_tokens: lastConversationUncachedPromptTokens,
                last_conversation_cached_read_tokens: lastConversationCachedReadTokens,
                last_conversation_cache_creation_tokens: lastConversationCacheCreationTokens,
                last_conversation_provider_cache_hit_rate_percent: lastConversationProviderCacheHitRate,
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
        if (!charToDelete) return res.status(404).json({ error: 'Character not found' });
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
        const deletedMentionMemoryRows = [];
        if (charName) {
            const allChars = db.getCharacters();
            for (const otherChar of allChars) {
                if (String(otherChar.id) === String(charId)) continue;
                // Remove memories where the deleted char's name appears in the 'people' field
                const otherMemories = db.getMemories(otherChar.id);
                for (const mem of otherMemories) {
                    if (mem.people && mem.people.includes(charName)) {
                        deletedMentionMemoryRows.push(mem);
                    }
                }
            }
        }
        const deletedMentionIndexTargets = buildMemoryIndexTargets(db, deletedMentionMemoryRows);
        const deletedMentionIdsByCharacter = new Map();
        const deletedMentionRowsByCharacter = new Map();
        for (const mem of deletedMentionMemoryRows) {
            const memoryId = Number(mem.id || 0);
            const targets = deletedMentionIndexTargets.get(memoryId) || new Map();
            for (const target of targets.values()) {
                const targetCharacterId = String(target.characterId || '').trim();
                if (!targetCharacterId) continue;
                if (!deletedMentionIdsByCharacter.has(targetCharacterId)) deletedMentionIdsByCharacter.set(targetCharacterId, []);
                if (!deletedMentionRowsByCharacter.has(targetCharacterId)) deletedMentionRowsByCharacter.set(targetCharacterId, []);
                deletedMentionIdsByCharacter.get(targetCharacterId).push(memoryId);
                deletedMentionRowsByCharacter.get(targetCharacterId).push(target.previousRow || mem);
            }
        }
        if (memory?.deleteMemoryIndexEntries) {
            for (const [targetCharacterId, memoryIds] of deletedMentionIdsByCharacter.entries()) {
                try {
                    const result = await memory.deleteMemoryIndexEntries(targetCharacterId, memoryIds);
                    if (Array.isArray(result?.errors) && result.errors.length > 0) {
                        console.warn(`[Delete] Memory index delete warning for ${targetCharacterId}: ${result.errors.join('; ')}`);
                    }
                } catch (e) {
                    console.warn(`[Delete] Failed to delete stale memory index entries for ${targetCharacterId}:`, e.message);
                }
            }
        }
        for (const mem of deletedMentionMemoryRows) {
            db.deleteMemory(mem.id);
        }
        if (memory?.refreshMemoryIndexEntries) {
            for (const [targetCharacterId, memoryIds] of deletedMentionIdsByCharacter.entries()) {
                try {
                    await memory.refreshMemoryIndexEntries(targetCharacterId, memoryIds, {
                        previousRows: deletedMentionRowsByCharacter.get(targetCharacterId) || []
                    });
                } catch (e) {
                    console.warn(`[Delete] Failed to refresh memory index entries for ${targetCharacterId}:`, e.message);
                }
            }
        }
        for (const targetCharacterId of deletedMentionIdsByCharacter.keys()) {
            wsClients.forEach(c => {
                if (c.readyState === 1) c.send(JSON.stringify({ type: 'memory_update', characterId: targetCharacterId }));
            });
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
// MOVED TO DLC: server/plugins/relationships/index.js

// Economy System (Transfers, Wallet, Red Packets) MOVED TO DLC
// See: server/plugins/economy/index.js


// Serve React Frontend (Production)
const clientDistPath = path.join(__dirname, '..', 'client', 'dist');
app.use(express.static(clientDistPath, {
    index: false,
    setHeaders: (res, filePath) => {
        if (filePath.endsWith('.html')) {
            res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
            res.setHeader('Pragma', 'no-cache');
            res.setHeader('Expires', '0');
        }
    }
}));

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


// Start listening
console.log('[Express] Attempting to listen on port 8000...');
const PORT = process.env.PORT || 8000;
server.listen(PORT, () => {
    console.log(`[Express] ChatPulse Server running on http://localhost:${PORT}`);
});

// Private background engines are now dynamically started via WS Auth

