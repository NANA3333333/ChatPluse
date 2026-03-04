const path = require('path');
const fs = require('fs');
const { LocalIndex } = require('vectra');
const { callLLM } = require('./llm');
const { getUserDb } = require('./db');

// Dynamic import for transformers.js
let pipeline = null;
let extractionDisabled = false;

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
    // Create if not exists
    const isCreated = await index.isIndexCreated();
    if (!isCreated) {
        await index.createIndex({
            version: 1,
            deleteConfig: { enabled: false }, // Simple config
            dimension: 384 // Dimension of all-MiniLM-L6-v2
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

            const results = await index.queryItems(queryEmbedding, limit);
            // Map results back to sqlite memory rows using metadata.id
            const memories = [];
            for (const res of results) {
                // Threshold filtering (e.g., > 0.5 similarity)
                if (res.score > 0.5 && res.item.metadata && res.item.metadata.memory_id) {
                    const memRow = db.getMemory(res.item.metadata.memory_id);
                    if (memRow) {
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

        const extractionPrompt = `
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

    async function saveExtractedMemory(characterId, memoryData, groupId = null) {
        try {
            // 1. Generate embedding for the event text
            const textToEmbed = `${memoryData.event} People: ${memoryData.people || ''}. Items: ${memoryData.items || ''}.`;
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
                metadata: { memory_id: memoryId }
            });

            console.log(`[Memory] Stored new memory for ${characterId}: ${memoryData.event}`);
        } catch (e) {
            console.error(`[Memory] Save failed for ${characterId}:`, e.message);
        }
    }

    const instance = {
        wipeIndex,
        searchMemories,
        extractMemoryFromContext,
        extractHiddenState,
        saveExtractedMemory
    };

    memoryCache.set(userId, instance);
    return instance;
}

module.exports = { getMemory };
