const path = require('path');
const fs = require('fs');
const { LocalIndex } = require('vectra');
const { callLLM } = require('./llm');
const { getUserDb } = require('./db');
const { buildUniversalContext } = require('./contextBuilder');

// Dynamic import for transformers.js
let pipeline = null;
let extractionDisabled = false;

let globalWsClientsResolver = null;
function setWsClientsResolver(resolver) {
    globalWsClientsResolver = resolver;
}

async function getExtractor() {
    if (extractionDisabled) return null;
    if (!pipeline) {
        try {
            const transformers = await import('@xenova/transformers');
            pipeline = await transformers.pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
        } catch (e) {
            console.error('[Memory] Xenova/ONNX initialization failed. Disabling local embeddings. Error:', e.message);
            extractionDisabled = true;
            return null;
        }
    }
    return pipeline;
}

async function getEmbedding(text) {
    const extractor = await getExtractor();
    if (!extractor) {
        // Return a zero-vector if local embeddings are broken
        return Array.from({ length: 384 }, () => 0);
    }
    const output = await extractor(text, { pooling: 'mean', normalize: true });
    return Array.from(output.data);
}

// Memory vector indices cache: UserId_CharacterID -> LocalIndex
const indices = new Map();

async function getVectorIndex(userId, characterId) {
    const key = `${userId}_${characterId}`;
    if (indices.has(key)) {
        return indices.get(key);
    }
    const dir = path.join(__dirname, '..', 'data', 'vectors', String(userId), String(characterId));
    const indexPath = path.join(dir, 'index.json');
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    if (fs.existsSync(indexPath)) {
        try {
            const stat = fs.statSync(indexPath);
            if (stat.isDirectory()) {
                const legacyIndexFile = path.join(indexPath, 'index.json');
                const tempIndexFile = path.join(dir, '__index_migrated__.json');
                if (fs.existsSync(legacyIndexFile) && fs.statSync(legacyIndexFile).isFile()) {
                    fs.copyFileSync(legacyIndexFile, tempIndexFile);
                }
                fs.rmSync(indexPath, { recursive: true, force: true });
                if (fs.existsSync(tempIndexFile)) {
                    fs.renameSync(tempIndexFile, indexPath);
                }
            }
        } catch (e) {
            try { fs.rmSync(indexPath, { recursive: true, force: true }); } catch (err) { }
        }
    }
    const index = new LocalIndex(indexPath);
    // Create if not exists OR if it exists but is corrupted
    try {
        const isCreated = await index.isIndexCreated();
        if (!isCreated) {
            await index.createIndex({
                version: 1,
                deleteConfig: { enabled: false }, // Simple config
                dimension: 384 // Dimension of all-MiniLM-L6-v2
            });
        }
    } catch (err) {
        // If it throws "Index does not exist" or "Unexpected end of JSON input", recreate it
        console.warn(`[Memory] Vector index corrupted/missing for ${characterId}, recreating...`, err.message);
        try { fs.rmSync(indexPath, { recursive: true, force: true }); } catch (e) { }
        fs.mkdirSync(dir, { recursive: true });
        await index.createIndex({
            version: 1,
            deleteConfig: { enabled: false },
            dimension: 384
        });
    }
    indices.set(key, index);
    return index;
}

const memoryCache = new Map();

function clearMemoryCache(userId) {
    if (!userId) return;
    memoryCache.delete(String(userId));
}

function getMemory(userId) {
    const cacheKey = String(userId);
    if (memoryCache.has(cacheKey)) return memoryCache.get(cacheKey);

    const getDb = () => getUserDb(userId);

    function resolveMemoryModelConfig(character) {
        return {
            endpoint: character.memory_api_endpoint || '',
            key: character.memory_api_key || '',
            model: character.memory_model_name || ''
        };
    }

    function updateSweepStatus(characterId, patch = {}) {
        const db = getDb();
        if (!characterId || typeof db.rawRun !== 'function') return;
        const fields = [];
        const values = [];
        if (Object.prototype.hasOwnProperty.call(patch, 'sweep_last_error')) {
            fields.push('sweep_last_error = ?');
            values.push(patch.sweep_last_error || '');
        }
        if (Object.prototype.hasOwnProperty.call(patch, 'sweep_last_run_at')) {
            fields.push('sweep_last_run_at = ?');
            values.push(patch.sweep_last_run_at || 0);
        }
        if (Object.prototype.hasOwnProperty.call(patch, 'sweep_last_success_at')) {
            fields.push('sweep_last_success_at = ?');
            values.push(patch.sweep_last_success_at || 0);
        }
        if (Object.prototype.hasOwnProperty.call(patch, 'sweep_last_saved_count')) {
            fields.push('sweep_last_saved_count = ?');
            values.push(patch.sweep_last_saved_count || 0);
        }
        if (fields.length === 0) return;
        values.push(characterId);
        db.rawRun(`UPDATE characters SET ${fields.join(', ')} WHERE id = ?`, values);
    }

    function recordMemoryTokenUsage(characterId, contextType, usage) {
        const db = getDb();
        if (!usage || !characterId || !db?.addTokenUsage) return;
        db.addTokenUsage(characterId, contextType, usage.prompt_tokens || 0, usage.completion_tokens || 0);
    }

    async function wipeIndex(characterId) {
        const key = `${userId}_${characterId}`;
        indices.delete(key);
        const dir = path.join(__dirname, '..', 'data', 'vectors', String(userId), String(characterId));
        if (fs.existsSync(dir)) {
            try {
                fs.rmSync(dir, { recursive: true, force: true });
            } catch (e) {
                console.error(`[Memory] Failed to physically wipe vector dir for ${characterId}:`, e.message);
            }
        }
    }

    async function rebuildIndex(characterId) {
        await wipeIndex(characterId);
        const db = getDb();
        const rows = db.getMemories ? db.getMemories(characterId) : [];
        if (!rows || rows.length === 0) return;

        const index = await getVectorIndex(userId, characterId);
        for (const mem of rows) {
            const textToEmbed = `${mem.event || ''} People: ${mem.people || ''}.Items: ${mem.items || ''}.`;
            const embeddingArray = await getEmbedding(textToEmbed);
            await index.insertItem({
                id: String(mem.id),
                vector: embeddingArray,
                metadata: { memory_id: mem.id, surprise_score: mem.surprise_score || 5 }
            });
        }
    }

    async function searchMemories(characterId, queryText, limit = 5) {
        try {
            const index = await getVectorIndex(userId, characterId);
            const queryEmbedding = await getEmbedding(queryText);

            // Fetch more items to allow for re-ranking based on surprise factor
            const results = await index.queryItems(queryEmbedding, limit * 3);

            // Apply surprise_score weighting
            const weightedResults = results.map(res => {
                const surpriseScore = (res.item.metadata && res.item.metadata.surprise_score) ? res.item.metadata.surprise_score : 5;
                // Weight formula: base_similarity * (1 + surprise_score * 0.05)
                // e.g. surprise 10 gives a 50% boost to similarity score.
                const finalScore = res.score * (1 + surpriseScore * 0.05);
                return { ...res, finalScore };
            });

            // Re-sort by finalScore descending
            weightedResults.sort((a, b) => b.finalScore - a.finalScore);

            // Map results back to sqlite memory rows using metadata.memory_id
            const memories = [];
            for (const res of weightedResults.slice(0, limit)) {
                // Threshold filtering
                if (res.score > 0.35 && res.item.metadata && res.item.metadata.memory_id) {
                    const db = getDb();
                    const memRow = db.getMemory(res.item.metadata.memory_id);
                    if (memRow) {
                        memRow._search_score = res.finalScore.toFixed(3);
                        memories.push(memRow);
                    }
                }
            }
            const db = getDb();
            if (memories.length > 0 && db.markMemoriesRetrieved) {
                db.markMemoriesRetrieved(memories.map(m => m.id));
            }
            return memories;
        } catch (e) {
            console.error(`[Memory] Search failed for ${characterId}:`, e.message);
            return [];
        }
    }

    async function extractMemoryFromContext(character, recentMessages, groupId = null) {
        const memoryConfig = resolveMemoryModelConfig(character);
        if (!memoryConfig.endpoint || !memoryConfig.key || !memoryConfig.model) {
            // Skip memory extraction if memory AI is not configured
            return null;
        }

        const contextText = recentMessages.map(m => `${m.role === 'user' ? 'User' : character.name}: ${m.content}`).join('\n');
        const engineContextWrapper = { getUserDb, getMemory: () => getMemory(userId) };
        const universalResult = await buildUniversalContext(engineContextWrapper, character, '', !!groupId);

        const extractionPrompt = `[全局世界观与前情提要]
${universalResult?.preamble || ''}

[当前特殊任务]：
You are a memory extraction assistant. Analyze the following recent conversation snippet between User and ${character.name}.
Identify if there are any noteworthy facts, events, preferences, emotions, or relationship changes worth remembering.
Return a structured JSON object. Focus on extracting WHAT happened, WHEN, WHERE, and WHO.

IMPORTANT: You should lean toward extracting memories rather than skipping. Even these count as valid memories:
- User or character expressing a preference (food, music, hobbies, etc.)
- Daily activities or plans mentioned
- Emotional expressions (happiness, sadness, anger, affection)
- New information shared about themselves
- Jokes, teasing, or playful moments that define the relationship
- Any shift in tone or relationship dynamics

Importance scale:
- 1-3: Casual preferences, small talk, routine activities
- 4-6: Personal events, expressed emotions, shared plans
- 7-8: Deep emotional moments, confessions, conflicts
- 9-10: Life-changing events, major relationship shifts

If importance >= 3, use "action": "add". Only use "action": "none" if the conversation is truly empty or purely system messages.

Conversation:
---
${contextText}
---

Output exactly in this JSON format (and nothing else):
{
    "action": "add" | "update" | "none",
    "time": "...",
    "location": "...",
    "people": "...",
    "event": "...",
    "relationships": "...",
    "items": "...",
    "importance": <number 1-10>
}
`;

        try {
            const { content: responseText, usage } = await callLLM({
                endpoint: memoryConfig.endpoint,
                key: memoryConfig.key,
                model: memoryConfig.model,
                messages: [
                    { role: 'system', content: 'You extract structured JSON facts from conversations. You lean toward extracting memories rather than returning none.' },
                    { role: 'user', content: extractionPrompt }
                ],
                maxTokens: 300,
                temperature: 0.3,
                returnUsage: true
            });
            recordMemoryTokenUsage(character.id, 'memory_extract', usage);

            // Parse JSON safely
            const startIdx = responseText.indexOf('{');
            const endIdx = responseText.lastIndexOf('}');
            if (startIdx !== -1 && endIdx !== -1) {
                const jsonText = responseText.slice(startIdx, endIdx + 1);
                const parsed = JSON.parse(jsonText);

                if (parsed.action === 'add' || parsed.action === 'update') {
                    await saveExtractedMemory(character.id, parsed, groupId);
                    return parsed;
                }
            }
        } catch (e) {
            console.error(`[Memory] Extraction failed for ${character.id}:`, e.message);
        }
        return null;
    }

    async function extractHiddenState(character, recentMessages) {
        const memoryConfig = resolveMemoryModelConfig(character);
        if (!memoryConfig.endpoint || !memoryConfig.key || !memoryConfig.model) {
            return null;
        }

        const contextText = recentMessages.map(m => `${m.role === 'user' ? 'User' : character.name}: ${m.content}`).join('\n');

        const extractionPrompt = `
You are analyzing a private chat between User and ${character.name}.
Based ONLY on these recent messages, summarize what ${character.name}'s current hidden mood, secret thought, or unspoken attitude towards User is right now.
Keep it under 30 words, and write it in the FIRST PERSON perspective of ${character.name}.
Example: "I am secretly happy that User remembered my preference, but I want to pretend I don't care."

Private Chat:
---
${contextText}
---

Output only the summary sentence, without quotes or extra explanation.
`;

        try {
            const { content: responseText, usage } = await callLLM({
                endpoint: memoryConfig.endpoint,
                key: memoryConfig.key,
                model: memoryConfig.model,
                messages: [
                    { role: 'system', content: 'You are an internal mood analyzer. You output ONLY the summarized first-person mindset.' },
                    { role: 'user', content: extractionPrompt }
                ],
                maxTokens: 100,
                temperature: 0.3,
                returnUsage: true
            });
            recordMemoryTokenUsage(character.id, 'memory_hidden_state', usage);

            const hiddenState = responseText.trim();
            if (hiddenState && hiddenState.length > 0 && hiddenState.length < 200) {
                const db = getDb();
                db.updateCharacterHiddenState(character.id, hiddenState);
                console.log(`[Memory] Extracted hidden state for ${character.name}: ${hiddenState}`);
                return hiddenState;
            }
        } catch (e) {
            console.error(`[Memory] Hidden state extraction failed for ${character.id}:`, e.message);
        }
        return null;
    }

    function parseMemoryArrayFromResponse(responseText) {
        const startIdx = responseText.indexOf('[');
        const endIdx = responseText.lastIndexOf(']');
        if (startIdx === -1 || endIdx === -1 || endIdx <= startIdx) return [];
        try {
            const parsed = JSON.parse(responseText.slice(startIdx, endIdx + 1));
            return Array.isArray(parsed) ? parsed : [];
        } catch (e) {
            return [];
        }
    }

    async function aggregateDailyMemoriesChunked(character, hoursAgo = 24, options = {}) {
        const memoryConfig = resolveMemoryModelConfig(character);
        if (!memoryConfig.endpoint || !memoryConfig.key || !memoryConfig.model) {
            return 0;
        }

        const sinceMs = Date.now() - hoursAgo * 60 * 60 * 1000;
        const batchSize = Math.max(10, Math.min(500, Number(options.batchSize) || 80));
        const activityEntries = [];
        const db = getDb();

        const privateMsgs = db.getVisibleMessagesSince(character.id, sinceMs);
        privateMsgs.forEach((m) => {
            activityEntries.push({
                timestamp: m.timestamp || 0,
                text: `[Private Chat] ${m.role === 'user' ? 'User' : character.name}: ${m.content}`
            });
        });

        const groups = db.getGroups().filter(g => g.members.some(m => m.member_id === character.id));
        for (const g of groups) {
            const msgs = db.getVisibleGroupMessages(g.id, 1000, sinceMs);
            msgs.forEach((m) => {
                const sName = m.sender_id === 'user' ? 'User' : (m.sender_name || 'Unknown');
                activityEntries.push({
                    timestamp: m.timestamp || 0,
                    text: `[Group Chat: ${g.name}] ${sName}: ${m.content}`
                });
            });
        }

        const moments = db.getMomentsSince(character.id, sinceMs);
        moments.forEach((m) => {
            const author = m.character_id === 'user' ? 'User' : (db.getCharacter(m.character_id)?.name || m.character_id);
            activityEntries.push({
                timestamp: m.created_at || m.timestamp || 0,
                text: `[Moment by ${author}] ${m.content}`
            });
        });

        try {
            const initCityDb = require('./plugins/city/cityDb');
            const cityDb = initCityDb(typeof db.getRawDb === 'function' ? db.getRawDb() : db);
            if (cityDb) {
                const logs = cityDb.getCharacterTodayLogs(character.id, 100);
                const recentLogs = (logs || []).filter((l) => l.timestamp >= sinceMs);
                recentLogs.forEach((l) => {
                    activityEntries.push({
                        timestamp: l.timestamp || 0,
                        text: `[City Activity] ${l.message}`
                    });
                });
            }
        } catch (e) { /* ignore */ }

        if (activityEntries.length === 0) return 0;

        activityEntries.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));

        const engineContextWrapper = { getUserDb, getMemory: () => getMemory(userId) };
        const universalResult = await buildUniversalContext(engineContextWrapper, character, '', false);
        const totalBatches = Math.ceil(activityEntries.length / batchSize);
        let savedCount = 0;

        for (let batchIndex = 0; batchIndex < totalBatches; batchIndex++) {
            const batchEntries = activityEntries.slice(batchIndex * batchSize, (batchIndex + 1) * batchSize);
            const batchText = batchEntries.map((entry) => entry.text).join('\n');
            const extractionPrompt = `[Global Context]
${universalResult?.preamble || ''}

[Current Task]
You are a memory aggregation assistant. Analyze batch ${batchIndex + 1} of ${totalBatches} from ${character.name}'s daily activity log over the past ${hoursAgo} hours.
This chunk may include private chats with User, group chats, social media moments, and city activities.
Identify noteworthy events, facts, relationship developments, preferences, plans, emotional shifts, or recurring themes worth remembering long-term.
Return a structured JSON ARRAY of memory objects.

IMPORTANT:
- Process only this chunk.
- If importance >= 3, include it.
- If nothing meaningful happened in this chunk, return [].
- Do not explain your answer outside the JSON array.

Importance scale:
- 1-3: Casual preferences, routine activities
- 4-6: Personal events, expressed emotions, shared plans
- 7-8: Deep emotional moments, conflicts
- 9-10: Life-changing events, major relationship shifts

Chunk Activities:
---
${batchText}
---

Output exactly in this JSON format (and nothing else):
[
  {
    "time": "e.g. today",
    "location": "...",
    "people": "...",
    "event": "...",
    "relationships": "...",
    "items": "...",
    "importance": <number 1-10>
  }
]`;

            try {
                const { content: responseText, usage } = await callLLM({
                    endpoint: memoryConfig.endpoint,
                    key: memoryConfig.key,
                    model: memoryConfig.model,
                    messages: [
                        { role: 'system', content: 'You extract structured JSON arrays of facts from diverse daily logs. Lean toward extracting memories.' },
                        { role: 'user', content: extractionPrompt }
                    ],
                    maxTokens: 1500,
                    temperature: 0.3,
                    returnUsage: true
                });
                recordMemoryTokenUsage(character.id, 'memory_daily_aggregate', usage);

                const parsed = parseMemoryArrayFromResponse(responseText);
                if (Array.isArray(parsed)) {
                    for (const mem of parsed) {
                        if (mem.importance >= 3 && mem.event) {
                            await saveExtractedMemory(character.id, mem, null);
                            savedCount++;
                        }
                    }
                }
            } catch (e) {
                console.error(`[Memory] Daily aggregation batch ${batchIndex + 1}/${totalBatches} failed for ${character.id}:`, e.message);
            }
        }

        console.log(`[Memory] Daily aggregation completed for ${character.name}, saved ${savedCount} memories across ${totalBatches} batch(es).`);
        return savedCount;
    }

    async function aggregateDailyMemories(character, hoursAgo = 24, options = {}) {
        const memoryConfig = resolveMemoryModelConfig(character);
        if (!memoryConfig.endpoint || !memoryConfig.key || !memoryConfig.model) {
            return 0;
        }

        return aggregateDailyMemoriesChunked(character, hoursAgo, options);

        const sinceMs = Date.now() - hoursAgo * 60 * 60 * 1000;
        const batchSize = Math.max(10, Math.min(500, Number(options.batchSize) || 80));
        const db = getDb();

        // 1. Private messages
        const privateMsgs = db.getVisibleMessagesSince(character.id, sinceMs);
        const activityEntries = privateMsgs.map((m) => ({
            timestamp: m.timestamp || 0,
            text: `[Private Chat] ${m.role === 'user' ? 'User' : character.name}: ${m.content}`
        }));

        // 2. Group messages
        const groups = db.getGroups().filter(g => g.members.some(m => m.member_id === character.id));
        for (const g of groups) {
            const msgs = db.getVisibleGroupMessages(g.id, 1000, sinceMs);
            if (msgs.length > 0) {
                msgs.forEach((m) => {
                    const sName = m.sender_id === 'user' ? 'User' : (m.sender_name || 'Unknown');
                    activityEntries.push({
                        timestamp: m.timestamp || 0,
                        text: `[Group Chat: ${g.name}] ${sName}: ${m.content}`
                    });
                });
            }
        }

        // 3. Moments
        const moments = db.getMomentsSince(character.id, sinceMs);
        if (moments.length > 0) {
            moments.forEach((m) => {
                const author = m.character_id === 'user' ? 'User' : (db.getCharacter(m.character_id)?.name || m.character_id);
                activityEntries.push({
                    timestamp: m.created_at || m.timestamp || 0,
                    text: `[Moment by ${author}] ${m.content}`
                });
            });
        }

        // 4. City Logs
        try {
            const initCityDb = require('./plugins/city/cityDb');
            const cityDb = initCityDb(typeof db.getRawDb === 'function' ? db.getRawDb() : db);
            if (cityDb) {
                const logs = cityDb.getCharacterTodayLogs(character.id, 100);
                if (logs && logs.length > 0) {
                    const recentLogs = logs.filter(l => l.timestamp >= sinceMs);
                    if (recentLogs.length > 0) {
                        recentLogs.forEach((l) => {
                            activityEntries.push({
                                timestamp: l.timestamp || 0,
                                text: `[City Activity] ${l.message}`
                            });
                        });
                    }
                }
            }
        } catch (e) { /* ignore */ }

        if (activityEntries.length === 0) {
            return 0; // Nothing happened
        }

        activityEntries.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));

        const engineContextWrapper = { getUserDb, getMemory: () => getMemory(userId) };
        const universalResult = await buildUniversalContext(engineContextWrapper, character, '', false);

        const extractionPrompt = `[全局世界观与前情提要]
${universalResult?.preamble || ''}

[当前特殊任务]：
You are a memory aggregation assistant. Analyze the following daily activity log of ${character.name} from the past ${hoursAgo} hours.
This includes private chats with User, group chats, social media moments, and personal city activities.
Identify noteworthy events, facts, relationship developments, or emotional shifts worth remembering long-term.
Return a structured JSON ARRAY of memory objects.

IMPORTANT: Even these count as valid memories:
- Preferences expressed
- Daily activities or plans mentioned
- Emotional expressions
- New information shared
- Jokes, teasing, or tone shifts

Importance scale:
- 1-3: Casual preferences, routine activities
- 4-6: Personal events, expressed emotions, shared plans
- 7-8: Deep emotional moments, conflicts
- 9-10: Life-changing events, major relationship shifts

If importance >= 3, include it in the array. If nothing happened or it's pure noise, return an empty array [].

Activities:
---
[Private Chats with User]
${privateText}

[Group Chats]
${groupText}

[Moments (Social Media)]
${momentText}

[City Activities]
${cityText}
---

Output exactly in this JSON format (and nothing else):
[
  {
    "time": "e.g. today",
    "location": "...",
    "people": "...",
    "event": "...",
    "relationships": "...",
    "items": "...",
    "importance": <number 1-10>
  }
]
`;

        try {
            const { content: responseText, usage } = await callLLM({
                endpoint: memoryConfig.endpoint,
                key: memoryConfig.key,
                model: memoryConfig.model,
                messages: [
                    { role: 'system', content: 'You extract structured JSON arrays of facts from diverse daily logs. Lean toward extracting memories.' },
                    { role: 'user', content: extractionPrompt }
                ],
                maxTokens: 1500,
                temperature: 0.3,
                returnUsage: true
            });
            recordMemoryTokenUsage(character.id, 'memory_daily_aggregate', usage);

            const startIdx = responseText.indexOf('[');
            const endIdx = responseText.lastIndexOf(']');
            if (startIdx !== -1 && endIdx !== -1) {
                const jsonText = responseText.slice(startIdx, endIdx + 1);
                let parsed = [];
                try { parsed = JSON.parse(jsonText); } catch (e) { }

                let savedCount = 0;
                if (Array.isArray(parsed)) {
                    for (const mem of parsed) {
                        if (mem.importance >= 3 && mem.event) {
                            await saveExtractedMemory(character.id, mem, null);
                            savedCount++;
                        }
                    }
                }
                console.log(`[Memory] Daily aggregation completed for ${character.name}, saved ${savedCount} memories.`);
                return savedCount;
            }
        } catch (e) {
            console.error(`[Memory] Daily aggregation failed for ${character.id}:`, e.message);
        }
        return 0;
    }

    async function sweepOverflowMemories(character) {
        const memoryConfig = resolveMemoryModelConfig(character);
        const now = Date.now();
        updateSweepStatus(character.id, {
            sweep_last_run_at: now,
            sweep_last_error: '',
            sweep_last_saved_count: 0
        });
        if (!memoryConfig.endpoint || !memoryConfig.key || !memoryConfig.model) {
            updateSweepStatus(character.id, {
                sweep_last_error: '????????????????????',
                sweep_last_saved_count: 0
            });
            return 0;
        }

        const sweepLimit = character.sweep_limit || 30;
        const privateWindow = character.context_msg_limit || 60;
        const db = getDb();
        const privateMsgs = db.getOverflowMessages(character.id, privateWindow, sweepLimit);
        let groupText = '';
        const groupMsgIds = [];
        const groups = db.getGroups().filter(g => g.members.some(m => m.member_id === character.id));
        for (const g of groups) {
            const groupWindow = g.inject_limit ?? 5;
            const msgs = db.getOverflowGroupMessages(g.id, groupWindow, sweepLimit);
            if (msgs.length > 0) {
                groupMsgIds.push(...msgs.map(m => m.id));
                groupText += `== Group: ${g.name} ==\n` + msgs.map(m => {
                    const sName = m.sender_id === 'user' ? 'User' : (m.sender_name || 'Unknown');
                    return `${sName}: ${m.content}`;
                }).join('\n') + '\n';
            }
        }

        if (privateMsgs.length === 0 && groupMsgIds.length === 0) {
            updateSweepStatus(character.id, {
                sweep_last_error: '',
                sweep_last_saved_count: 0
            });
            return 0;
        }

        const activityEntries = [];
        privateMsgs.forEach((m) => {
            activityEntries.push({
                kind: 'private',
                text: `${m.role === 'user' ? 'User' : character.name}: ${m.content}`
            });
        });
        if (groupText) {
            activityEntries.push({ kind: 'group', text: groupText.trim() });
        }

        const batchSize = Math.max(12, Math.min(30, Math.ceil(sweepLimit / 3)));
        const totalBatches = Math.ceil(activityEntries.length / batchSize);
        const parsedMemories = [];

        try {
            for (let batchIndex = 0; batchIndex < totalBatches; batchIndex++) {
                const batchEntries = activityEntries.slice(batchIndex * batchSize, (batchIndex + 1) * batchSize);
                const batchPrivateText = batchEntries
                    .filter(entry => entry.kind === 'private')
                    .map(entry => entry.text)
                    .join('\n') || 'No private messages.';
                const batchGroupText = batchEntries
                    .filter(entry => entry.kind === 'group')
                    .map(entry => entry.text)
                    .join('\n\n') || 'No group messages.';

                const extractionPrompt = `You are a memory aggregation assistant. Analyze batch ${batchIndex + 1} of ${totalBatches} from ${character.name}'s overflowed chat logs.
Identify noteworthy events, facts, relationship developments, or emotional shifts.
Return a structured JSON ARRAY of memory objects.

CRITICAL:
- Output only valid JSON.
- Prefer 0 to 4 strong memories for this batch, not an exhaustive list.
- Score each memory on a "surprise" factor from 1 to 10.
- Surprise 1-3: Routine, completely expected.
- Surprise 4-6: Mildly interesting, personal details.
- Surprise 7-8: Emotional, unexpected events.
- Surprise 9-10: Mind-blowing, life-changing completely unexpected twists.

Activities:
---
[Private Chats]
${batchPrivateText}

[Group Chats]
${batchGroupText}
---

Output exactly in this JSON format (and nothing else):
[
  {
    "time": "recent past",
    "location": "chat",
    "people": "...",
    "event": "...",
    "relationships": "...",
    "items": "...",
    "importance": <number 1-10>,
    "surprise_score": <number 1-10>
  }
]
`;

                const { content: responseText, usage } = await callLLM({
                    endpoint: memoryConfig.endpoint,
                    key: memoryConfig.key,
                    model: memoryConfig.model,
                    messages: [
                        { role: 'system', content: 'You extract structured JSON arrays of facts from chat logs, including a surprise_score.' },
                        { role: 'user', content: extractionPrompt }
                    ],
                    maxTokens: 2200,
                    temperature: 0.2,
                    returnUsage: true
                });
                recordMemoryTokenUsage(character.id, 'memory_sweep', usage);

                const startIdx = responseText.indexOf('[');
                const endIdx = responseText.lastIndexOf(']');
                if (startIdx === -1 || endIdx === -1 || endIdx <= startIdx) {
                    updateSweepStatus(character.id, {
                        sweep_last_error: `???? ${batchIndex + 1}/${totalBatches} ????????????????????`,
                        sweep_last_saved_count: 0
                    });
                    return 0;
                }

                let parsed = [];
                try {
                    parsed = JSON.parse(responseText.slice(startIdx, endIdx + 1));
                } catch (e) {
                    updateSweepStatus(character.id, {
                        sweep_last_error: `???? ${batchIndex + 1}/${totalBatches} ???????? JSON???????????`,
                        sweep_last_saved_count: 0
                    });
                    return 0;
                }

                if (Array.isArray(parsed)) {
                    parsedMemories.push(...parsed);
                }
            }

            let savedCount = 0;
            for (const mem of parsedMemories) {
                if (mem && mem.importance >= 3 && mem.event) {
                    mem.surprise_score = mem.surprise_score || 5;
                    await saveExtractedMemory(character.id, mem, null);
                    savedCount++;
                }
            }

            if (privateMsgs.length > 0) db.markMessagesSummarized(privateMsgs.map(m => m.id));
            if (groupMsgIds.length > 0) db.markGroupMessagesSummarized(groupMsgIds);

            updateSweepStatus(character.id, {
                sweep_last_error: savedCount > 0 ? '' : '???????????????',
                sweep_last_success_at: savedCount > 0 ? Date.now() : character.sweep_last_success_at || 0,
                sweep_last_saved_count: savedCount
            });
            console.log(`[Memory] Sweep completed for ${character.name}, saved ${savedCount} memories across ${totalBatches} batch(es).`);
            return savedCount;
        } catch (e) {
            updateSweepStatus(character.id, {
                sweep_last_error: e.message || '?????????',
                sweep_last_saved_count: 0
            });
            console.error(`[Memory] Sweep failed for ${character.id}:`, e.message);
            return 0;
        }
    }

    async function saveExtractedMemory(characterId, memoryData, groupId = null) {
        try {
            // 1. Generate embedding for the event text
            const textToEmbed = `${memoryData.event} People: ${memoryData.people || ''}.Items: ${memoryData.items || ''}.`;
            const embeddingArray = await getEmbedding(textToEmbed);

            // Convert JS array to Buffer for SQLite storage (optional, vectra uses its own file)
            const embeddingBuffer = Buffer.from(new Float32Array(embeddingArray).buffer);
            memoryData.embedding = embeddingBuffer;

            // 2. Save to SQLite (with optional group_id for cleanup)
            const db = getDb();
            const memoryId = db.addMemory(characterId, memoryData, groupId);

            // 3. Save to Vectra store
            const index = await getVectorIndex(userId, characterId);
            await index.insertItem({
                id: String(memoryId),
                vector: embeddingArray,
                metadata: { memory_id: memoryId, surprise_score: memoryData.surprise_score || 5 }
            });

            console.log(`[Memory] Stored new memory for ${characterId}: ${memoryData.event} `);

            // Broadcast real-time update to connected clients
            if (globalWsClientsResolver) {
                const wsClients = globalWsClientsResolver(userId);
                if (wsClients) {
                    const eventPayload = JSON.stringify({ type: 'memory_update', characterId: characterId });
                    wsClients.forEach(c => {
                        if (c.readyState === 1) c.send(eventPayload);
                    });
                }
            }
        } catch (e) {
            console.error(`[Memory] Save failed for ${characterId}: `, e.message);
        }
    }

    const instance = {
        wipeIndex,
        rebuildIndex,
        searchMemories,
        extractMemoryFromContext,
        extractHiddenState,
        aggregateDailyMemories,
        sweepOverflowMemories,
        saveExtractedMemory
    };

    memoryCache.set(cacheKey, instance);
    return instance;
}
module.exports = { getMemory, clearMemoryCache, setWsClientsResolver };
