const crypto = require('crypto');
const initMcpLabDb = require('./db');

const tasksByUser = new Map();

function nowIso() {
    return new Date().toISOString();
}

function getUserTasks(userId) {
    const key = String(userId || 'default');
    if (!tasksByUser.has(key)) tasksByUser.set(key, []);
    return tasksByUser.get(key);
}

function safeText(value, maxLength = 2000) {
    return String(value || '').replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

function makeId() {
    return crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function ensureMcpLabDb(db) {
    if (!db.mcpLab) {
        const rawDb = typeof db.getRawDb === 'function' ? db.getRawDb() : db;
        db.mcpLab = initMcpLabDb(rawDb);
    }
    return db.mcpLab;
}

function assertHttpUrl(rawUrl) {
    const url = new URL(String(rawUrl || '').trim());
    if (!['http:', 'https:'].includes(url.protocol)) {
        throw new Error('Only http/https URLs are allowed.');
    }
    return url.toString();
}

async function fetchWithTimeout(url, options = {}) {
    const timeoutMs = Math.max(1000, Math.min(20000, Number(options.timeoutMs || 10000)));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await fetch(url, {
            ...options,
            signal: controller.signal,
            headers: {
                'user-agent': 'ChatPluse-MCP-Lab/0.1',
                accept: 'text/html,application/json,text/plain;q=0.9,*/*;q=0.8',
                ...(options.headers || {})
            }
        });
    } finally {
        clearTimeout(timer);
    }
}

function stripHtml(html, maxLength = 12000) {
    return String(html || '')
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
        .replace(/<\/(p|div|section|article|li|h[1-6]|br)>/gi, '\n')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .replace(/[ \t]{2,}/g, ' ')
        .trim()
        .slice(0, maxLength);
}

function flattenDuckDuckGoTopics(items, output = []) {
    for (const item of Array.isArray(items) ? items : []) {
        if (item?.Topics) {
            flattenDuckDuckGoTopics(item.Topics, output);
            continue;
        }
        if (item?.Text || item?.FirstURL) {
            output.push({
                title: safeText(item.Text || item.FirstURL, 140),
                snippet: safeText(item.Text || '', 320),
                url: String(item.FirstURL || '').trim()
            });
        }
    }
    return output;
}

async function runWebSearch(query) {
    const q = safeText(query, 300);
    if (!q) throw new Error('Query is required.');
    const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(q)}&format=json&no_redirect=1&no_html=1`;
    const response = await fetchWithTimeout(url, { timeoutMs: 12000 });
    if (!response.ok) throw new Error(`Search failed with HTTP ${response.status}`);
    const data = await response.json();
    const results = [];
    if (data.AbstractText || data.AbstractURL) {
        results.push({
            title: safeText(data.Heading || q, 140),
            snippet: safeText(data.AbstractText || '', 500),
            url: String(data.AbstractURL || '').trim()
        });
    }
    flattenDuckDuckGoTopics(data.RelatedTopics, results);
    return {
        query: q,
        source: 'duckduckgo_instant_answer',
        results: results.filter(item => item.snippet || item.url).slice(0, 8),
        fetched_at: nowIso()
    };
}

async function runFetchUrl(rawUrl) {
    const url = assertHttpUrl(rawUrl);
    const response = await fetchWithTimeout(url, { timeoutMs: 15000 });
    const contentType = String(response.headers.get('content-type') || '');
    const body = await response.text();
    if (!response.ok) throw new Error(`Fetch failed with HTTP ${response.status}`);
    return {
        url,
        status: response.status,
        content_type: contentType,
        text: contentType.includes('html') ? stripHtml(body) : safeText(body, 12000),
        fetched_at: nowIso()
    };
}

async function runTask(task) {
    const input = task.input || {};
    task.status = 'running';
    task.started_at = nowIso();
    task.error = '';
    try {
        if (task.kind === 'web_search') {
            task.output = await runWebSearch(input.query || task.title);
        } else if (task.kind === 'fetch_url') {
            task.output = await runFetchUrl(input.url);
        } else {
            throw new Error(`Unsupported task kind: ${task.kind}`);
        }
        task.status = 'done';
        task.finished_at = nowIso();
    } catch (e) {
        task.status = 'error';
        task.error = e.message;
        task.finished_at = nowIso();
    }
    return task;
}

function inspectContext(db, characterId) {
    const character = db.getCharacter?.(characterId);
    if (!character) throw new Error('Character not found.');
    const privateLimit = Math.max(0, Number(character.context_msg_limit || 60) || 60);
    const privateMessages = db.getVisibleMessages?.(character.id, privateLimit) || [];
    const latestUser = [...privateMessages].reverse().find(msg => msg.role === 'user') || null;
    const cityLogs = db.city?.getCharacterRecentLogs?.(character.id, 8) || [];
    const llmDebug = db.getLlmDebugLogs?.(character.id, 8) || [];
    const groups = (db.getGroups?.() || []).filter(group => {
        const members = Array.isArray(group.members) ? group.members : [];
        return members.some(member => String(member?.member_id || member) === String(character.id));
    });
    const externalDocs = ensureMcpLabDb(db).listExternalKnowledgeDocs({ character_id: character.id, limit: 8 });

    return {
        character: {
            id: character.id,
            name: character.name,
            location: character.location || '',
            city_status: character.city_status || '',
            context_msg_limit: privateLimit
        },
        private_window: {
            count: privateMessages.length,
            latest_user_message: latestUser ? {
                id: latestUser.id,
                timestamp: latestUser.timestamp,
                content: latestUser.content
            } : null,
            tail: privateMessages.slice(-8).map(msg => ({
                id: msg.id,
                role: msg.role,
                timestamp: msg.timestamp,
                content: safeText(msg.content, 260),
                metadata: msg.metadata || null
            }))
        },
        city: {
            recent_logs: cityLogs.map(log => ({
                id: log.id,
                action_type: log.action_type,
                location: log.location,
                message: safeText(log.message, 320),
                timestamp: log.timestamp
            }))
        },
        group_context: {
            groups: groups.map(group => ({
                id: group.id,
                name: group.name,
                member_count: Array.isArray(group.members) ? group.members.length : 0,
                inject_limit: group.inject_limit
            }))
        },
        external_knowledge: {
            docs: externalDocs.map(doc => ({
                id: doc.id,
                title: doc.title,
                source_url: doc.source_url,
                source_type: doc.source_type,
                trust_level: doc.trust_level,
                tags: doc.tags,
                updated_at: doc.updated_at
            }))
        },
        recent_llm_debug: llmDebug.map(entry => ({
            id: entry.id,
            direction: entry.direction,
            context_type: entry.context_type,
            timestamp: entry.timestamp,
            payload_preview: safeText(entry.payload, 360),
            meta: entry.meta || null
        }))
    };
}

module.exports = function initMcpLab(app, context) {
    const { authMiddleware } = context;

    app.get('/api/mcp-lab/status', authMiddleware, (req, res) => {
        res.json({
            success: true,
            name: 'mcpLab',
            stage: 'experimental',
            tools: [
                { id: 'web_search', label: 'Web Search', input_schema: { query: 'string' } },
                { id: 'fetch_url', label: 'Fetch URL', input_schema: { url: 'string' } },
                { id: 'knowledge.save_note', label: 'Save External Knowledge', input_schema: { title: 'string', content: 'string', source_url: 'string' } },
                { id: 'knowledge.search', label: 'Search External Knowledge', input_schema: { query: 'string' } },
                { id: 'context.inspect', label: 'Inspect Character Context', input_schema: { character_id: 'string' } }
            ],
            note: 'Experimental DLC tool layer. Character auto-tool calls are not enabled yet.'
        });
    });

    app.get('/api/mcp-lab/context/:characterId', authMiddleware, (req, res) => {
        try {
            if (!req.db.city) {
                try {
                    const initCityDb = require('../city/cityDb');
                    req.db.city = initCityDb(typeof req.db.getRawDb === 'function' ? req.db.getRawDb() : req.db);
                } catch (e) { }
            }
            res.json({ success: true, context: inspectContext(req.db, req.params.characterId) });
        } catch (e) {
            res.status(500).json({ success: false, error: e.message });
        }
    });

    app.post('/api/mcp-lab/search', authMiddleware, async (req, res) => {
        try {
            res.json({ success: true, result: await runWebSearch(req.body?.query) });
        } catch (e) {
            res.status(500).json({ success: false, error: e.message });
        }
    });

    app.post('/api/mcp-lab/fetch', authMiddleware, async (req, res) => {
        try {
            res.json({ success: true, result: await runFetchUrl(req.body?.url) });
        } catch (e) {
            res.status(500).json({ success: false, error: e.message });
        }
    });

    app.get('/api/mcp-lab/tasks', authMiddleware, (req, res) => {
        res.json({ success: true, tasks: getUserTasks(req.user?.id) });
    });

    app.post('/api/mcp-lab/tasks', authMiddleware, async (req, res) => {
        try {
            const kind = String(req.body?.kind || 'web_search').trim();
            const task = {
                id: makeId(),
                title: safeText(req.body?.title || req.body?.input?.query || req.body?.input?.url || kind, 160),
                kind,
                input: req.body?.input || {},
                status: 'queued',
                output: null,
                error: '',
                created_at: nowIso(),
                started_at: '',
                finished_at: ''
            };
            getUserTasks(req.user?.id).unshift(task);
            if (req.body?.run_now !== false) await runTask(task);
            res.json({ success: true, task });
        } catch (e) {
            res.status(500).json({ success: false, error: e.message });
        }
    });

    app.post('/api/mcp-lab/tasks/:id/run', authMiddleware, async (req, res) => {
        try {
            const task = getUserTasks(req.user?.id).find(item => item.id === req.params.id);
            if (!task) return res.status(404).json({ success: false, error: 'Task not found.' });
            res.json({ success: true, task: await runTask(task) });
        } catch (e) {
            res.status(500).json({ success: false, error: e.message });
        }
    });

    app.delete('/api/mcp-lab/tasks/:id', authMiddleware, (req, res) => {
        const tasks = getUserTasks(req.user?.id);
        const next = tasks.filter(item => item.id !== req.params.id);
        tasks.splice(0, tasks.length, ...next);
        res.json({ success: true });
    });

    app.get('/api/mcp-lab/knowledge', authMiddleware, (req, res) => {
        try {
            const labDb = ensureMcpLabDb(req.db);
            res.json({
                success: true,
                docs: labDb.listExternalKnowledgeDocs({
                    character_id: req.query.character_id || '',
                    limit: req.query.limit || 30
                })
            });
        } catch (e) {
            res.status(500).json({ success: false, error: e.message });
        }
    });

    app.post('/api/mcp-lab/knowledge', authMiddleware, (req, res) => {
        try {
            const content = String(req.body?.content || '').trim();
            const title = safeText(req.body?.title || req.body?.source_url || 'External note', 240);
            const labDb = ensureMcpLabDb(req.db);
            const doc = labDb.saveExternalKnowledge({
                owner_id: req.user?.id || '',
                character_id: req.body?.character_id || '',
                title,
                content,
                source_url: req.body?.source_url || '',
                source_type: req.body?.source_type || 'note',
                trust_level: req.body?.trust_level || 'raw',
                tags: req.body?.tags || []
            }, labDb.chunkText(content), makeId);
            res.json({ success: true, doc });
        } catch (e) {
            res.status(500).json({ success: false, error: e.message });
        }
    });

    app.post('/api/mcp-lab/knowledge/search', authMiddleware, (req, res) => {
        try {
            const labDb = ensureMcpLabDb(req.db);
            res.json({
                success: true,
                results: labDb.searchExternalKnowledge(req.body?.query || '', {
                    character_id: req.body?.character_id || '',
                    limit: req.body?.limit || 8
                })
            });
        } catch (e) {
            res.status(500).json({ success: false, error: e.message });
        }
    });

    console.log('[MCP Lab DLC] Experimental web tools registered.');
};
