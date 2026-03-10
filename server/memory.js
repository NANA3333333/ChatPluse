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
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    const index = new LocalIndex(path.join(dir, 'index.json'));
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
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { }
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

function getMemory(userId) {
    if (memoryCache.has(userId)) return memoryCache.get(userId);

    // Instantiates this user's specific sqlite DB instance
    const db = getUserDb(userId);

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
                // Threshold filtering (e.g., > 0.5 original similarity)
                if (res.score > 0.68 && res.item.metadata && res.item.metadata.memory_id) {
                    const memRow = db.getMemory(res.item.metadata.memory_id);
                    if (memRow) {
                        memRow._search_score = res.finalScore.toFixed(3);
                        memories.push(memRow);
                    }
                }
            }
            return memories;
        } catch (e) {
            console.error(`[Memory] Search failed for ${characterId}:`, e.message);
            return [];
        }
    }

    async function extractMemoryFromContext(character, recentMessages, groupId = null) {
        if (!character.memory_api_endpoint || !character.memory_api_key || !character.memory_model_name) {
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
            const responseText = await callLLM({
                endpoint: character.memory_api_endpoint,
                key: character.memory_api_key,
                model: character.memory_model_name,
                messages: [
                    { role: 'system', content: 'You extract structured JSON facts from conversations. You lean toward extracting memories rather than returning none.' },
                    { role: 'user', content: extractionPrompt }
                ],
                maxTokens: 300,
                temperature: 0.3
            });

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
        if (!character.memory_api_endpoint || !character.memory_api_key || !character.memory_model_name) {
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
            const responseText = await callLLM({
                endpoint: character.memory_api_endpoint,
                key: character.memory_api_key,
                model: character.memory_model_name,
                messages: [
                    { role: 'system', content: 'You are an internal mood analyzer. You output ONLY the summarized first-person mindset.' },
                    { role: 'user', content: extractionPrompt }
                ],
                maxTokens: 100,
                temperature: 0.3
            });

            const hiddenState = responseText.trim();
            if (hiddenState && hiddenState.length > 0 && hiddenState.length < 200) {
                db.updateCharacterHiddenState(character.id, hiddenState);
                console.log(`[Memory] Extracted hidden state for ${character.name}: ${hiddenState}`);
                return hiddenState;
            }
        } catch (e) {
            console.error(`[Memory] Hidden state extraction failed for ${character.id}:`, e.message);
        }
        return null;
    }

    async function aggregateDailyMemories(character, hoursAgo = 24) {
        if (!character.memory_api_endpoint || !character.memory_api_key || !character.memory_model_name) {
            return 0;
        }

        const sinceMs = Date.now() - hoursAgo * 60 * 60 * 1000;

        // 1. Private messages
        const privateMsgs = db.getVisibleMessagesSince(character.id, sinceMs);
        let privateText = privateMsgs.length > 0 ? privateMsgs.map(m => `${m.role === 'user' ? 'User' : character.name}: ${m.content}`).join('\n') : 'No private messages.';

        // 2. Group messages
        const groups = db.getGroups().filter(g => g.members.some(m => m.member_id === character.id));
        let groupText = '';
        for (const g of groups) {
            const msgs = db.getVisibleGroupMessages(g.id, 1000, sinceMs);
            if (msgs.length > 0) {
                groupText += `== Group: ${g.name} ==\n`;
                groupText += msgs.map(m => {
                    const sName = m.sender_id === 'user' ? 'User' : (m.sender_name || 'Unknown');
                    return `${sName}: ${m.content}`;
                }).join('\n') + '\n';
            }
        }
        if (!groupText) groupText = 'No group messages.';

        // 3. Moments
        const moments = db.getMomentsSince(character.id, sinceMs);
        let momentText = '';
        if (moments.length > 0) {
            momentText += moments.map(m => {
                const author = m.character_id === 'user' ? 'User' : (db.getCharacter(m.character_id)?.name || m.character_id);
                return `[Moment by ${author}] ${m.content}`;
            }).join('\n');
        } else {
            momentText = 'No new moments.';
        }

        // 4. City Logs
        let cityText = 'No city activities.';
        try {
            const initCityDb = require('./plugins/city/cityDb');
            const cityDb = initCityDb(typeof db.getRawDb === 'function' ? db.getRawDb() : db);
            if (cityDb) {
                const logs = cityDb.getCharacterTodayLogs(character.id, 100);
                if (logs && logs.length > 0) {
                    const recentLogs = logs.filter(l => l.timestamp >= sinceMs);
                    if (recentLogs.length > 0) {
                        cityText = recentLogs.map(l => `- ${l.message}`).join('\n');
                    }
                }
            }
        } catch (e) { /* ignore */ }

        if (privateMsgs.length === 0 && !groupText.includes('==') && moments.length === 0 && cityText === 'No city activities.') {
            return 0; // Nothing happened
        }

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
            const responseText = await callLLM({
                endpoint: character.memory_api_endpoint,
                key: character.memory_api_key,
                model: character.memory_model_name,
                messages: [
                    { role: 'system', content: 'You extract structured JSON arrays of facts from diverse daily logs. Lean toward extracting memories.' },
                    { role: 'user', content: extractionPrompt }
                ],
                maxTokens: 1500,
                temperature: 0.3
            });

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
        if (!character.memory_api_endpoint || !character.memory_api_key || !character.memory_model_name) return 0;

        // Only summarize messages older than 3 hours (well outside typical sliding window)
        const olderThanMs = Date.now() - (3 * 60 * 60 * 1000);

        // Fetch up to W (sweep_limit) messages. Fallback to 30.
        const sweepLimit = character.sweep_limit || 30;

        const privateMsgs = db.getUnsummarizedMessages(character.id, olderThanMs, sweepLimit);
        let groupText = '';
        let groupMsgIds = [];
        const groups = db.getGroups().filter(g => g.members.some(m => m.member_id === character.id));
        for (const g of groups) {
            const msgs = db.getUnsummarizedGroupMessages(g.id, olderThanMs, sweepLimit);
            if (msgs.length > 0) {
                groupMsgIds.push(...msgs.map(m => m.id));
                groupText += `== Group: ${g.name} ==\n` + msgs.map(m => {
                    const sName = m.sender_id === 'user' ? 'User' : (m.sender_name || 'Unknown');
                    return `${sName}: ${m.content}`;
                }).join('\n') + '\n';
            }
        }

        if (privateMsgs.length === 0 && groupMsgIds.length === 0) return 0;

        let privateText = privateMsgs.length > 0 ? privateMsgs.map(m => `${m.role === 'user' ? 'User' : character.name}: ${m.content}`).join('\n') : 'No private messages.';

        const extractionPrompt = `You are a memory aggregation assistant. Analyze the following overflowed chat logs of ${character.name}.
Identify noteworthy events, facts, relationship developments, or emotional shifts.
Return a structured JSON ARRAY of memory objects.

CRITICAL: Score each memory on a "surprise" factor from 1 to 10.
- Surprise 1-3: Routine, completely expected.
- Surprise 4-6: Mildly interesting, personal details.
- Surprise 7-8: Emotional, unexpected events.
- Surprise 9-10: Mind-blowing, life-changing completely unexpected twists.

Activities:
---
[Private Chats]
${privateText}

[Group Chats]
${groupText || 'No group messages.'}
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

        try {
            const responseText = await callLLM({
                endpoint: character.memory_api_endpoint,
                key: character.memory_api_key,
                model: character.memory_model_name,
                messages: [
                    { role: 'system', content: 'You extract structured JSON arrays of facts from chat logs, including a surprise_score.' },
                    { role: 'user', content: extractionPrompt }
                ],
                maxTokens: 1500,
                temperature: 0.3
            });
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
                            mem.surprise_score = mem.surprise_score || 5;
                            await saveExtractedMemory(character.id, mem, null);
                            savedCount++;
                        }
                    }
                }

                // Mark as summarized
                if (privateMsgs.length > 0) db.markMessagesSummarized(privateMsgs.map(m => m.id));
                if (groupMsgIds.length > 0) db.markGroupMessagesSummarized(groupMsgIds);

                console.log(`[Memory] Sweep completed for ${character.name}, saved ${savedCount} memories.`);
                return savedCount;
            }
        } catch (e) {
            console.error(`[Memory] Sweep failed for ${character.id}:`, e.message);
        }
        return 0;
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
            const memoryId = db.addMemory(characterId, memoryData, groupId);

            // 3. Save to Vectra store
            const index = await getVectorIndex(userId, characterId);
            await index.insertItem({
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
        searchMemories,
        extractMemoryFromContext,
        extractHiddenState,
        aggregateDailyMemories,
        sweepOverflowMemories,
        saveExtractedMemory
    };

    memoryCache.set(userId, instance);
    return instance;
}
module.exports = { getMemory, setWsClientsResolver };
