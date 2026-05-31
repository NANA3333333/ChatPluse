const crypto = require('crypto');
const initMcpLabDb = require('./db');
const {
    isMcpLabValidationError,
    normalizeMcpHttpUrl,
    normalizeMcpKnowledgeListOptions,
    normalizeMcpKnowledgePayload,
    normalizeMcpKnowledgeSearchPayload,
    normalizeMcpProvider,
    normalizeMcpSearchPayload,
    normalizeMcpTaskListOptions,
    normalizeMcpTaskPayload
} = require('./inputGuards');

const WEB_SEARCH_PROVIDERS = [
    {
        id: 'serper',
        label: 'Serper / Google',
        env: 'SERPER_API_KEY',
        docs: 'https://serper.dev/'
    },
    {
        id: 'tavily',
        label: 'Tavily Search',
        env: 'TAVILY_API_KEY',
        docs: 'https://tavily.com/'
    },
    {
        id: 'brave',
        label: 'Brave Search',
        env: 'BRAVE_SEARCH_API_KEY',
        docs: 'https://brave.com/search/api/'
    },
    {
        id: 'bing',
        label: 'Bing Web Search',
        env: 'BING_SEARCH_API_KEY',
        docs: 'https://www.microsoft.com/bing/apis/bing-web-search-api'
    }
];

function nowIso() {
    return new Date().toISOString();
}

function safeText(value, maxLength = 2000) {
    return String(value || '').replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

function safeSnippet(value) {
    return safeText(value, 4000);
}

function safeParseJson(value, fallback = {}) {
    if (!value) return fallback;
    if (typeof value !== 'string') return value || fallback;
    try {
        return JSON.parse(value);
    } catch (e) {
        return fallback;
    }
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
    return normalizeMcpHttpUrl(rawUrl);
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
                snippet: safeSnippet(item.Text || ''),
                url: String(item.FirstURL || '').trim(),
                raw: item
            });
        }
    }
    return output;
}

async function runWebSearch(query, options = {}) {
    const q = safeText(query, 300);
    if (!q) throw new Error('Query is required.');
    const provider = String(options.provider || '').trim();
    const apiKey = String(options.apiKey || options.serperKey || '').trim();
    let result = null;
    if (provider === 'serper' && apiKey) {
        result = await runSerperSearch(q, apiKey);
    } else if (provider === 'tavily' && apiKey) {
        result = await runTavilySearch(q, apiKey);
    } else if (provider === 'brave' && apiKey) {
        result = await runBraveSearch(q, apiKey);
    } else if (provider === 'bing' && apiKey) {
        result = await runBingSearch(q, apiKey);
    } else {
        const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(q)}&format=json&no_redirect=1&no_html=1`;
        const response = await fetchWithTimeout(url, { timeoutMs: 12000 });
        if (!response.ok) throw new Error(`Search failed with HTTP ${response.status}`);
        const data = await response.json();
        const results = [];
        if (data.AbstractText || data.AbstractURL) {
            results.push({
                title: safeText(data.Heading || q, 140),
                snippet: safeSnippet(data.AbstractText || ''),
                url: String(data.AbstractURL || '').trim(),
                raw: {
                    Heading: data.Heading,
                    AbstractText: data.AbstractText,
                    AbstractURL: data.AbstractURL,
                    AbstractSource: data.AbstractSource,
                    Abstract: data.Abstract
                }
            });
        }
        flattenDuckDuckGoTopics(data.RelatedTopics, results);
        result = {
            query: q,
            source: 'duckduckgo_instant_answer',
            results: results.filter(item => item.snippet || item.url).slice(0, 3),
            fetched_at: nowIso(),
            raw_response: data
        };
    }
    if (options.fetchPages) {
        return enrichSearchResultPages(result, {
            limit: options.fetchPageLimit,
            textLength: options.fetchPageTextLength
        });
    }
    return result;
}

function normalizeSearchResults(query, source, results, extra = {}) {
    return {
        query,
        source,
        results: (Array.isArray(results) ? results : [])
            .map(item => ({
                title: safeText(item.title || item.name || item.url || 'Result', 180),
                snippet: safeSnippet(item.snippet || item.description || item.content || ''),
                url: String(item.url || item.link || '').trim(),
                raw: item.raw || item
            }))
            .filter(item => item.snippet || item.url)
            .slice(0, 3),
        fetched_at: nowIso(),
        ...extra
    };
}

async function runSerperSearch(query, apiKey) {
    const q = safeText(query, 300);
    const key = String(apiKey || '').trim();
    if (!q) throw new Error('Query is required.');
    if (!key) throw new Error('Serper API key is required.');
    const response = await fetchWithTimeout('https://google.serper.dev/search', {
        method: 'POST',
        timeoutMs: 12000,
        headers: {
            'X-API-KEY': key,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            q,
            num: 3,
            hl: 'zh-cn',
            gl: 'cn'
        })
    });
    const text = await response.text();
    let data = null;
    try {
        data = text ? JSON.parse(text) : null;
    } catch (e) {
        data = null;
    }
    if (!response.ok) {
        const message = data?.message || data?.error || text || `Serper search failed with HTTP ${response.status}`;
        throw new Error(message);
    }
    const results = [];
    const answerBox = data?.answerBox;
    if (answerBox) {
        results.push({
            title: safeText(answerBox.title || answerBox.answer || 'Answer Box', 140),
            snippet: safeSnippet(answerBox.answer || answerBox.snippet || answerBox.snippetHighlighted?.join(' ') || ''),
            url: String(answerBox.link || '').trim(),
            raw: answerBox
        });
    }
    const knowledgeGraph = data?.knowledgeGraph;
    if (knowledgeGraph?.title || knowledgeGraph?.description) {
        results.push({
            title: safeText(knowledgeGraph.title || q, 140),
            snippet: safeSnippet(knowledgeGraph.description || knowledgeGraph.descriptionSource || ''),
            url: String(knowledgeGraph.website || '').trim(),
            raw: knowledgeGraph
        });
    }
    for (const item of Array.isArray(data?.organic) ? data.organic : []) {
        results.push({
            title: safeText(item.title || item.link || 'Result', 160),
            snippet: safeSnippet(item.snippet || ''),
            url: String(item.link || '').trim(),
            raw: item
        });
    }
    for (const item of Array.isArray(data?.news) ? data.news : []) {
        results.push({
            title: safeText(item.title || item.link || 'News', 160),
            snippet: safeSnippet(item.snippet || item.date || ''),
            url: String(item.link || '').trim(),
            raw: item
        });
    }
    return normalizeSearchResults(q, 'serper_google_search', results, { raw_response: data });
}

async function runTavilySearch(query, apiKey) {
    const q = safeText(query, 300);
    const response = await fetchWithTimeout('https://api.tavily.com/search', {
        method: 'POST',
        timeoutMs: 15000,
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            api_key: apiKey,
            query: q,
            search_depth: 'basic',
            max_results: 3,
            include_answer: true
        })
    });
    const text = await response.text();
    const data = text ? JSON.parse(text) : {};
    if (!response.ok) throw new Error(data?.detail || data?.error || text || `Tavily search failed with HTTP ${response.status}`);
    const results = [];
    if (data.answer) results.push({ title: 'Tavily Answer', snippet: data.answer, url: '', raw: { answer: data.answer } });
    for (const item of Array.isArray(data.results) ? data.results : []) {
        results.push({ title: item.title, snippet: item.content || item.snippet, url: item.url, raw: item });
    }
    return normalizeSearchResults(q, 'tavily_search', results, { raw_response: data });
}

async function runBraveSearch(query, apiKey) {
    const q = safeText(query, 300);
    const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(q)}&count=3&country=CN&search_lang=zh-hans`;
    const response = await fetchWithTimeout(url, {
        timeoutMs: 12000,
        headers: {
            'X-Subscription-Token': apiKey,
            accept: 'application/json'
        }
    });
    const text = await response.text();
    const data = text ? JSON.parse(text) : {};
    if (!response.ok) throw new Error(data?.message || data?.error || text || `Brave search failed with HTTP ${response.status}`);
    const results = (data?.web?.results || []).map(item => ({
        title: item.title,
        snippet: item.description || item.extra_snippets?.join(' '),
        url: item.url,
        raw: item
    }));
    return normalizeSearchResults(q, 'brave_search', results, { raw_response: data });
}

async function runBingSearch(query, apiKey) {
    const q = safeText(query, 300);
    const url = `https://api.bing.microsoft.com/v7.0/search?q=${encodeURIComponent(q)}&count=3&mkt=zh-CN`;
    const response = await fetchWithTimeout(url, {
        timeoutMs: 12000,
        headers: {
            'Ocp-Apim-Subscription-Key': apiKey,
            accept: 'application/json'
        }
    });
    const text = await response.text();
    const data = text ? JSON.parse(text) : {};
    if (!response.ok) throw new Error(data?.message || data?.error?.message || text || `Bing search failed with HTTP ${response.status}`);
    const results = (data?.webPages?.value || []).map(item => ({
        title: item.name,
        snippet: item.snippet,
        url: item.url,
        raw: item
    }));
    return normalizeSearchResults(q, 'bing_web_search', results, { raw_response: data });
}

function getWebSearchConfig(db) {
    const profile = db?.getUserProfile?.() || {};
    const storedKeys = safeParseJson(profile.web_search_keys_json, {});
    if (!storedKeys.serper && profile.serper_api_key) storedKeys.serper = profile.serper_api_key;
    const provider = String(profile.web_search_provider || 'auto').trim() || 'auto';
    const providers = WEB_SEARCH_PROVIDERS.map(item => {
        const profileKey = String(storedKeys[item.id] || '').trim();
        const envKey = String(process.env[item.env] || '').trim();
        const key = profileKey || envKey;
        return {
            ...item,
            has_key: !!key,
            masked: maskSecret(key),
            source: profileKey ? 'user_profile' : (envKey ? 'env' : 'none')
        };
    });
    return { provider, providers, keys: storedKeys };
}

function resolveSearchProvider(db, preferredProvider = '') {
    const config = getWebSearchConfig(db);
    const requested = String(preferredProvider || config.provider || 'auto').trim();
    if (requested === 'duckduckgo' || requested === 'duckduckgo_instant_answer') {
        return { id: 'duckduckgo', label: 'DuckDuckGo Instant Answer', key: '', config };
    }
    const orderedIds = requested && requested !== 'auto'
        ? [requested, ...WEB_SEARCH_PROVIDERS.map(item => item.id).filter(id => id !== requested)]
        : WEB_SEARCH_PROVIDERS.map(item => item.id);
    for (const id of orderedIds) {
        const provider = config.providers.find(item => item.id === id);
        const key = String(config.keys[id] || process.env[provider?.env] || '').trim();
        if (provider && key) return { id, label: provider.label, key, config };
    }
    return { id: 'duckduckgo', label: 'DuckDuckGo Instant Answer', key: '', config };
}

function getSerperApiKey(db) {
    const resolved = resolveSearchProvider(db, 'serper');
    return resolved.id === 'serper' ? resolved.key : '';
}

function maskSecret(value) {
    const text = String(value || '').trim();
    if (!text) return '';
    if (text.length <= 8) return '*'.repeat(text.length);
    return `${text.slice(0, 4)}...${text.slice(-4)}`;
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

async function enrichSearchResultPages(searchResult, options = {}) {
    const limit = Math.max(0, Math.min(5, Number(options.limit || 3) || 3));
    if (!searchResult || limit <= 0 || !Array.isArray(searchResult.results)) return searchResult;
    const textLength = Math.max(1000, Math.min(20000, Number(options.textLength || 8000) || 8000));
    const next = {
        ...searchResult,
        page_fetch: {
            enabled: true,
            limit,
            fetched_at: nowIso()
        },
        results: searchResult.results.map(item => ({ ...item }))
    };
    const targets = next.results
        .map((item, index) => ({ item, index, url: String(item.url || '').trim() }))
        .filter(entry => /^https?:\/\//i.test(entry.url))
        .slice(0, limit);
    const settled = await Promise.allSettled(targets.map(entry => runFetchUrl(entry.url)));
    settled.forEach((outcome, index) => {
        const target = targets[index];
        if (!target) return;
        if (outcome.status === 'fulfilled') {
            const page = outcome.value || {};
            target.item.page_text = safeText(page.text || '', textLength);
            target.item.page = {
                url: page.url || target.url,
                status: page.status || 0,
                content_type: page.content_type || '',
                fetched_at: page.fetched_at || nowIso()
            };
        } else {
            target.item.page_error = String(outcome.reason?.message || outcome.reason || 'fetch failed').slice(0, 300);
        }
    });
    return next;
}

async function runTask(task, context = {}) {
    const input = task.input || {};
    task.status = 'running';
    task.started_at = nowIso();
    task.error = '';
    if (context.db) ensureMcpLabDb(context.db).saveTask(task);
    try {
        if (task.kind === 'web_search' || task.kind === 'private_web_search' || task.kind === 'city_web_search') {
            const resolved = resolveSearchProvider(context.db, input.provider);
            task.output = await runWebSearch(input.query || task.title, {
                provider: resolved.id,
                apiKey: resolved.key,
                fetchPages: input.fetch_pages !== false,
                fetchPageLimit: input.fetch_page_limit || 3
            });
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
    if (context.db) ensureMcpLabDb(context.db).saveTask(task);
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

function initMcpLab(app, context) {
    const { authMiddleware } = context;

    app.get('/api/mcp-lab/status', authMiddleware, (req, res) => {
        const resolved = resolveSearchProvider(req.db);
        const config = getWebSearchConfig(req.db);
        res.json({
            success: true,
            name: 'mcpLab',
            stage: 'experimental',
            search_provider: resolved.id,
            search_provider_label: resolved.label,
            preferred_search_provider: config.provider,
            web_search_providers: config.providers.map(({ id, label, env, docs, has_key, masked, source }) => ({ id, label, env, docs, has_key, masked, source })),
            has_serper_key: !!getSerperApiKey(req.db),
            serper_key_masked: maskSecret(getSerperApiKey(req.db)),
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
            res.status(e.message === 'Character not found.' ? 404 : 500).json({ success: false, error: e.message });
        }
    });

    app.post('/api/mcp-lab/search', authMiddleware, async (req, res) => {
        let task = null;
        let labDb = null;
        try {
            const payload = normalizeMcpSearchPayload(req.body || {});
            const resolved = resolveSearchProvider(req.db, payload.provider);
            labDb = ensureMcpLabDb(req.db);
            const query = payload.query;
            task = labDb.saveTask({
                id: makeId(),
                owner_id: req.user?.id || '',
                title: safeText(query || 'Web search', 160),
                kind: 'web_search',
                input: { query, provider: payload.provider || resolved.id, fetch_pages: payload.fetch_pages, fetch_page_limit: payload.fetch_page_limit },
                status: 'running',
                output: null,
                error: '',
                created_at: nowIso(),
                started_at: nowIso(),
                finished_at: ''
            });
            task.output = await runWebSearch(query, {
                provider: resolved.id,
                apiKey: resolved.key,
                fetchPages: payload.fetch_pages,
                fetchPageLimit: payload.fetch_page_limit
            });
            task.status = 'done';
            task.finished_at = nowIso();
            labDb.saveTask(task);
            res.json({
                success: true,
                result: task.output,
                task
            });
        } catch (e) {
            if (task && labDb) {
                task.status = 'error';
                task.error = e.message;
                task.finished_at = nowIso();
                labDb.saveTask(task);
            }
            res.status(isMcpLabValidationError(e) ? 400 : 500).json({ success: false, error: e.message });
        }
    });

    app.get('/api/mcp-lab/serper-config', authMiddleware, (req, res) => {
        try {
            const config = getWebSearchConfig(req.db);
            const serper = config.providers.find(item => item.id === 'serper') || {};
            res.json({
                success: true,
                has_key: !!serper.has_key,
                source: serper.source || 'none',
                masked: serper.masked || ''
            });
        } catch (e) {
            res.status(500).json({ success: false, error: e.message });
        }
    });

    app.put('/api/mcp-lab/serper-config', authMiddleware, (req, res) => {
        try {
            const nextKey = String(req.body?.serper_api_key || '').trim();
            const profile = req.db.getUserProfile?.() || {};
            const keys = safeParseJson(profile.web_search_keys_json, {});
            keys.serper = nextKey;
            req.db.updateUserProfile?.({
                serper_api_key: nextKey,
                web_search_keys_json: JSON.stringify(keys),
                web_search_provider: nextKey ? 'serper' : (profile.web_search_provider || 'auto')
            });
            const config = getWebSearchConfig(req.db);
            const serper = config.providers.find(item => item.id === 'serper') || {};
            res.json({
                success: true,
                has_key: !!serper.has_key,
                source: serper.source || 'none',
                masked: serper.masked || ''
            });
        } catch (e) {
            res.status(500).json({ success: false, error: e.message });
        }
    });

    app.get('/api/mcp-lab/web-config', authMiddleware, (req, res) => {
        try {
            const config = getWebSearchConfig(req.db);
            const resolved = resolveSearchProvider(req.db);
            res.json({
                success: true,
                preferred_provider: config.provider,
                active_provider: resolved.id,
                active_provider_label: resolved.label,
                saved_key_count: Object.values(config.keys || {}).filter(value => String(value || '').trim()).length,
                providers: config.providers.map(({ id, label, env, docs, has_key, masked, source }) => ({ id, label, env, docs, has_key, masked, source }))
            });
        } catch (e) {
            res.status(500).json({ success: false, error: e.message });
        }
    });

    app.put('/api/mcp-lab/web-config', authMiddleware, (req, res) => {
        try {
            const profile = req.db.getUserProfile?.() || {};
            const keys = safeParseJson(profile.web_search_keys_json, {});
            const incomingKeys = req.body?.keys || {};
            const clearIds = new Set(Array.isArray(req.body?.clear_ids) ? req.body.clear_ids.map(String) : []);
            for (const provider of WEB_SEARCH_PROVIDERS) {
                if (clearIds.has(provider.id)) {
                    delete keys[provider.id];
                    continue;
                }
                if (Object.prototype.hasOwnProperty.call(incomingKeys, provider.id)) {
                    const value = String(incomingKeys[provider.id] || '').trim();
                    if (value) keys[provider.id] = value;
                }
            }
            const validProvider = normalizeMcpProvider(req.body?.preferred_provider || profile.web_search_provider || 'auto');
            req.db.updateUserProfile?.({
                serper_api_key: String(keys.serper || ''),
                web_search_keys_json: JSON.stringify(keys),
                web_search_provider: validProvider
            });
            const config = getWebSearchConfig(req.db);
            const resolved = resolveSearchProvider(req.db);
            res.json({
                success: true,
                preferred_provider: config.provider,
                active_provider: resolved.id,
                active_provider_label: resolved.label,
                saved_key_count: Object.values(config.keys || {}).filter(value => String(value || '').trim()).length,
                providers: config.providers.map(({ id, label, env, docs, has_key, masked, source }) => ({ id, label, env, docs, has_key, masked, source }))
            });
        } catch (e) {
            res.status(isMcpLabValidationError(e) ? 400 : 500).json({ success: false, error: e.message });
        }
    });

    app.post('/api/mcp-lab/fetch', authMiddleware, async (req, res) => {
        let task = null;
        let labDb = null;
        try {
            labDb = ensureMcpLabDb(req.db);
            const url = normalizeMcpHttpUrl(req.body?.url);
            task = labDb.saveTask({
                id: makeId(),
                owner_id: req.user?.id || '',
                title: safeText(url || 'Fetch URL', 160),
                kind: 'fetch_url',
                input: { url },
                status: 'running',
                output: null,
                error: '',
                created_at: nowIso(),
                started_at: nowIso(),
                finished_at: ''
            });
            task.output = await runFetchUrl(url);
            task.status = 'done';
            task.finished_at = nowIso();
            labDb.saveTask(task);
            res.json({ success: true, result: task.output, task });
        } catch (e) {
            if (task && labDb) {
                task.status = 'error';
                task.error = e.message;
                task.finished_at = nowIso();
                labDb.saveTask(task);
            }
            res.status(isMcpLabValidationError(e) ? 400 : 500).json({ success: false, error: e.message });
        }
    });

    app.get('/api/mcp-lab/tasks', authMiddleware, (req, res) => {
        try {
            const options = normalizeMcpTaskListOptions(req.query || {});
            res.json({ success: true, tasks: ensureMcpLabDb(req.db).listTasks(req.user?.id || '', options.limit) });
        } catch (e) {
            res.status(isMcpLabValidationError(e) ? 400 : 500).json({ success: false, error: e.message });
        }
    });

    app.post('/api/mcp-lab/tasks', authMiddleware, async (req, res) => {
        try {
            const payload = normalizeMcpTaskPayload(req.body || {});
            const task = {
                id: makeId(),
                title: payload.title,
                kind: payload.kind,
                input: payload.input,
                status: 'queued',
                output: null,
                error: '',
                created_at: nowIso(),
                started_at: '',
                finished_at: ''
            };
            task.owner_id = req.user?.id || '';
            const labDb = ensureMcpLabDb(req.db);
            labDb.saveTask(task);
            if (req.body?.run_now !== false) await runTask(task, { db: req.db });
            res.json({ success: true, task: labDb.getTask(task.id, req.user?.id || '') || task });
        } catch (e) {
            res.status(isMcpLabValidationError(e) ? 400 : 500).json({ success: false, error: e.message });
        }
    });

    app.post('/api/mcp-lab/tasks/:id/run', authMiddleware, async (req, res) => {
        try {
            const labDb = ensureMcpLabDb(req.db);
            const task = labDb.getTask(req.params.id, req.user?.id || '');
            if (!task) return res.status(404).json({ success: false, error: 'Task not found.' });
            res.json({ success: true, task: await runTask(task, { db: req.db }) });
        } catch (e) {
            res.status(500).json({ success: false, error: e.message });
        }
    });

    app.delete('/api/mcp-lab/tasks/:id', authMiddleware, (req, res) => {
        try {
            const deleted = ensureMcpLabDb(req.db).deleteTask(req.params.id, req.user?.id || '');
            if (!deleted) return res.status(404).json({ success: false, error: 'Task not found.' });
            res.json({ success: true, deleted });
        } catch (e) {
            res.status(500).json({ success: false, error: e.message });
        }
    });

    app.get('/api/mcp-lab/knowledge', authMiddleware, (req, res) => {
        try {
            const options = normalizeMcpKnowledgeListOptions(req.query || {});
            if (options.character_id && !req.db.getCharacter?.(options.character_id)) {
                return res.status(404).json({ success: false, error: 'Character not found.' });
            }
            const labDb = ensureMcpLabDb(req.db);
            res.json({
                success: true,
                docs: labDb.listExternalKnowledgeDocs(options)
            });
        } catch (e) {
            res.status(isMcpLabValidationError(e) ? 400 : 500).json({ success: false, error: e.message });
        }
    });

    app.post('/api/mcp-lab/knowledge', authMiddleware, (req, res) => {
        try {
            const payload = normalizeMcpKnowledgePayload(req.body || {});
            if (payload.character_id && !req.db.getCharacter?.(payload.character_id)) {
                return res.status(404).json({ success: false, error: 'Character not found.' });
            }
            const labDb = ensureMcpLabDb(req.db);
            const doc = labDb.saveExternalKnowledge({
                owner_id: req.user?.id || '',
                character_id: payload.character_id,
                title: payload.title,
                content: payload.content,
                source_url: payload.source_url,
                source_type: payload.source_type,
                trust_level: payload.trust_level,
                tags: payload.tags
            }, labDb.chunkText(payload.content), makeId);
            res.json({ success: true, doc });
        } catch (e) {
            res.status(isMcpLabValidationError(e) ? 400 : 500).json({ success: false, error: e.message });
        }
    });

    app.post('/api/mcp-lab/knowledge/search', authMiddleware, (req, res) => {
        try {
            const payload = normalizeMcpKnowledgeSearchPayload(req.body || {});
            if (payload.character_id && !req.db.getCharacter?.(payload.character_id)) {
                return res.status(404).json({ success: false, error: 'Character not found.' });
            }
            const labDb = ensureMcpLabDb(req.db);
            res.json({
                success: true,
                results: labDb.searchExternalKnowledge(payload.query, payload)
            });
        } catch (e) {
            res.status(isMcpLabValidationError(e) ? 400 : 500).json({ success: false, error: e.message });
        }
    });

    console.log('[MCP Lab DLC] Experimental web tools registered.');
}

module.exports = initMcpLab;
module.exports.WEB_SEARCH_PROVIDERS = WEB_SEARCH_PROVIDERS;
module.exports.ensureMcpLabDb = ensureMcpLabDb;
module.exports.getWebSearchConfig = getWebSearchConfig;
module.exports.resolveSearchProvider = resolveSearchProvider;
module.exports.runWebSearch = runWebSearch;
module.exports.runFetchUrl = runFetchUrl;
module.exports.safeText = safeText;
module.exports.makeId = makeId;
