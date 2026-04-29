function safeParseJson(value, fallback) {
    if (!value) return fallback;
    if (typeof value !== 'string') return value;
    try {
        return JSON.parse(value);
    } catch (e) {
        return fallback;
    }
}

function stringifyJson(value, fallback = '[]') {
    try {
        return JSON.stringify(value);
    } catch (e) {
        return fallback;
    }
}

function normalizeTags(value) {
    if (Array.isArray(value)) return value.map(v => String(v || '').trim()).filter(Boolean);
    return String(value || '')
        .split(/[,，、\n]/)
        .map(v => v.trim())
        .filter(Boolean);
}

function chunkText(text, maxLength = 1400, overlap = 160) {
    const normalized = String(text || '').replace(/\r\n/g, '\n').trim();
    if (!normalized) return [];
    const chunks = [];
    let start = 0;
    while (start < normalized.length) {
        const end = Math.min(normalized.length, start + maxLength);
        chunks.push(normalized.slice(start, end).trim());
        if (end >= normalized.length) break;
        start = Math.max(0, end - overlap);
    }
    return chunks.filter(Boolean);
}

function initMcpLabDb(rawDb) {
    rawDb.exec(`
        CREATE TABLE IF NOT EXISTS external_knowledge_docs (
            id TEXT PRIMARY KEY,
            owner_id TEXT DEFAULT '',
            character_id TEXT DEFAULT '',
            title TEXT NOT NULL,
            source_url TEXT DEFAULT '',
            source_type TEXT DEFAULT 'note',
            trust_level TEXT DEFAULT 'raw',
            tags_json TEXT DEFAULT '[]',
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS external_knowledge_chunks (
            id TEXT PRIMARY KEY,
            doc_id TEXT NOT NULL,
            chunk_index INTEGER NOT NULL,
            content TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            FOREIGN KEY (doc_id) REFERENCES external_knowledge_docs(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_external_knowledge_docs_character
            ON external_knowledge_docs(character_id, updated_at);
        CREATE INDEX IF NOT EXISTS idx_external_knowledge_chunks_doc
            ON external_knowledge_chunks(doc_id, chunk_index);
    `);

    const createDocStmt = rawDb.prepare(`
        INSERT INTO external_knowledge_docs
            (id, owner_id, character_id, title, source_url, source_type, trust_level, tags_json, created_at, updated_at)
        VALUES
            (@id, @owner_id, @character_id, @title, @source_url, @source_type, @trust_level, @tags_json, @created_at, @updated_at)
    `);
    const createChunkStmt = rawDb.prepare(`
        INSERT INTO external_knowledge_chunks
            (id, doc_id, chunk_index, content, created_at)
        VALUES
            (@id, @doc_id, @chunk_index, @content, @created_at)
    `);

    function saveExternalKnowledge(doc, chunks, makeId) {
        const now = Date.now();
        const docId = doc.id || makeId();
        const normalizedChunks = Array.isArray(chunks) && chunks.length > 0
            ? chunks
            : chunkText(doc.content || '');
        if (normalizedChunks.length === 0) throw new Error('External knowledge content is empty.');

        const tx = rawDb.transaction(() => {
            createDocStmt.run({
                id: docId,
                owner_id: String(doc.owner_id || ''),
                character_id: String(doc.character_id || ''),
                title: String(doc.title || 'Untitled external note').slice(0, 240),
                source_url: String(doc.source_url || ''),
                source_type: String(doc.source_type || 'note').slice(0, 80),
                trust_level: String(doc.trust_level || 'raw').slice(0, 40),
                tags_json: stringifyJson(normalizeTags(doc.tags)),
                created_at: now,
                updated_at: now
            });
            normalizedChunks.forEach((content, index) => {
                createChunkStmt.run({
                    id: makeId(),
                    doc_id: docId,
                    chunk_index: index,
                    content: String(content || '').trim(),
                    created_at: now
                });
            });
        });
        tx();
        return getExternalKnowledgeDoc(docId);
    }

    function getExternalKnowledgeDoc(docId) {
        const doc = rawDb.prepare('SELECT * FROM external_knowledge_docs WHERE id = ?').get(docId);
        if (!doc) return null;
        const chunks = rawDb.prepare('SELECT * FROM external_knowledge_chunks WHERE doc_id = ? ORDER BY chunk_index ASC').all(docId);
        return {
            ...doc,
            tags: safeParseJson(doc.tags_json, []),
            chunks
        };
    }

    function searchExternalKnowledge(query, options = {}) {
        const q = String(query || '').trim();
        if (!q) return [];
        const terms = q.split(/\s+/).map(v => v.trim()).filter(Boolean).slice(0, 8);
        const characterId = String(options.character_id || '');
        const limit = Math.max(1, Math.min(30, Number(options.limit || 8) || 8));
        const rows = rawDb.prepare(`
            SELECT
                c.id AS chunk_id,
                c.doc_id,
                c.chunk_index,
                c.content,
                d.title,
                d.source_url,
                d.source_type,
                d.trust_level,
                d.tags_json,
                d.character_id,
                d.updated_at
            FROM external_knowledge_chunks c
            JOIN external_knowledge_docs d ON d.id = c.doc_id
            WHERE (? = '' OR d.character_id = '' OR d.character_id = ?)
            ORDER BY d.updated_at DESC, c.chunk_index ASC
            LIMIT 300
        `).all(characterId, characterId);

        return rows
            .map(row => {
                const haystack = `${row.title}\n${row.content}\n${row.source_url}`.toLowerCase();
                const score = terms.reduce((sum, term) => {
                    const needle = term.toLowerCase();
                    if (!needle) return sum;
                    let count = 0;
                    let pos = haystack.indexOf(needle);
                    while (pos !== -1 && count < 8) {
                        count += 1;
                        pos = haystack.indexOf(needle, pos + needle.length);
                    }
                    return sum + count;
                }, 0);
                return { ...row, score };
            })
            .filter(row => row.score > 0 || terms.some(term => row.content.includes(term)))
            .sort((a, b) => b.score - a.score || b.updated_at - a.updated_at)
            .slice(0, limit)
            .map(row => ({
                chunk_id: row.chunk_id,
                doc_id: row.doc_id,
                title: row.title,
                source_url: row.source_url,
                source_type: row.source_type,
                trust_level: row.trust_level,
                tags: safeParseJson(row.tags_json, []),
                character_id: row.character_id,
                chunk_index: row.chunk_index,
                content: row.content,
                score: row.score
            }));
    }

    function listExternalKnowledgeDocs(options = {}) {
        const characterId = String(options.character_id || '');
        const limit = Math.max(1, Math.min(100, Number(options.limit || 30) || 30));
        return rawDb.prepare(`
            SELECT * FROM external_knowledge_docs
            WHERE (? = '' OR character_id = '' OR character_id = ?)
            ORDER BY updated_at DESC
            LIMIT ?
        `).all(characterId, characterId, limit).map(row => ({
            ...row,
            tags: safeParseJson(row.tags_json, [])
        }));
    }

    return {
        saveExternalKnowledge,
        getExternalKnowledgeDoc,
        searchExternalKnowledge,
        listExternalKnowledgeDocs,
        chunkText
    };
}

module.exports = initMcpLabDb;
