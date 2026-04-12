const DEFAULT_QDRANT_URL = process.env.QDRANT_URL || 'http://127.0.0.1:6333';
const DEFAULT_COLLECTION_PREFIX = process.env.QDRANT_COLLECTION_PREFIX || 'chatpulse_memories';
const DEFAULT_VECTOR_SIZE = Number(process.env.LOCAL_EMBEDDING_DIM || 1024);

function sanitizeCollectionPart(value) {
    return String(value || 'default').replace(/[^a-zA-Z0-9_-]/g, '_');
}

function normalizePointId(value) {
    const numeric = Number(value);
    if (Number.isInteger(numeric) && numeric >= 0) {
        return numeric;
    }
    return String(value || '');
}

function getCollectionName(userId) {
    return `${DEFAULT_COLLECTION_PREFIX}_${sanitizeCollectionPart(userId)}`;
}

function hasFetchSupport() {
    return typeof fetch === 'function';
}

function getQdrantConfig() {
    return {
        url: DEFAULT_QDRANT_URL.replace(/\/+$/, ''),
        apiKey: process.env.QDRANT_API_KEY || '',
        enabled: process.env.QDRANT_ENABLED === '0' ? false : true
    };
}

async function qdrantRequest(path, options = {}) {
    if (!hasFetchSupport()) {
        throw new Error('Global fetch is not available in this Node runtime.');
    }
    const config = getQdrantConfig();
    if (!config.enabled) {
        throw new Error('Qdrant is disabled by QDRANT_ENABLED=0');
    }
    const headers = {
        'Content-Type': 'application/json',
        ...(options.headers || {})
    };
    if (config.apiKey) {
        headers['api-key'] = config.apiKey;
    }
    const response = await fetch(`${config.url}${path}`, {
        method: options.method || 'GET',
        headers,
        body: options.body ? JSON.stringify(options.body) : undefined
    });
    const text = await response.text();
    let json = null;
    try {
        json = text ? JSON.parse(text) : null;
    } catch (e) {
        json = null;
    }
    if (!response.ok) {
        const message = json?.status?.error || json?.message || text || `HTTP ${response.status}`;
        throw new Error(message);
    }
    return json;
}

const ensuredCollections = new Set();
const pendingCollectionEnsures = new Map();

function isAlreadyExistsError(error) {
    const message = String(error?.message || '').toLowerCase();
    return message.includes('already exists');
}

async function ensureCollection(userId, vectorSize = DEFAULT_VECTOR_SIZE) {
    const collectionName = getCollectionName(userId);
    if (ensuredCollections.has(collectionName)) return collectionName;
    if (pendingCollectionEnsures.has(collectionName)) {
        return pendingCollectionEnsures.get(collectionName);
    }

    const ensurePromise = (async () => {
        try {
            const existing = await qdrantRequest(`/collections/${collectionName}`);
            const existingSize = Number(
                existing?.result?.config?.params?.vectors?.size
                || existing?.result?.config?.params?.vectors?.default?.size
                || 0
            );
            if (existingSize && existingSize !== Number(vectorSize)) {
                console.warn(`[Qdrant] Collection ${collectionName} dimension mismatch (${existingSize} != ${vectorSize}). Recreating...`);
                await qdrantRequest(`/collections/${collectionName}`, {
                    method: 'DELETE'
                });
            } else {
                ensuredCollections.add(collectionName);
                return collectionName;
            }
        } catch (e) {
            // continue to create when missing/unreachable details aren't available yet
        }

        try {
            await qdrantRequest(`/collections/${collectionName}`, {
                method: 'PUT',
                body: {
                    vectors: {
                        size: vectorSize,
                        distance: 'Cosine'
                    },
                    optimizers_config: {
                        default_segment_number: 2
                    }
                }
            });
        } catch (e) {
            if (!isAlreadyExistsError(e)) {
                throw e;
            }
        }

        // Create payload indexes when possible. If they already exist, Qdrant will reject; ignore those failures.
        const indexFields = [
            { field_name: 'character_id', field_schema: 'keyword' },
            { field_name: 'group_id', field_schema: 'keyword' },
            { field_name: 'memory_type', field_schema: 'keyword' },
            { field_name: 'memory_tier', field_schema: 'keyword' },
            { field_name: 'memory_focus', field_schema: 'keyword' },
            { field_name: 'is_archived', field_schema: 'integer' },
            { field_name: 'created_at', field_schema: 'integer' },
            { field_name: 'importance', field_schema: 'integer' },
            { field_name: 'source_started_at', field_schema: 'integer' },
            { field_name: 'source_ended_at', field_schema: 'integer' }
        ];
        for (const field of indexFields) {
            try {
                await qdrantRequest(`/collections/${collectionName}/index`, {
                    method: 'PUT',
                    body: field
                });
            } catch (e) { }
        }

        ensuredCollections.add(collectionName);
        return collectionName;
    })();

    pendingCollectionEnsures.set(collectionName, ensurePromise);
    try {
        return await ensurePromise;
    } finally {
        pendingCollectionEnsures.delete(collectionName);
    }
}

async function upsertMemoryPoint(userId, point) {
    const collectionName = await ensureCollection(userId, point.vector.length || DEFAULT_VECTOR_SIZE);
    await qdrantRequest(`/collections/${collectionName}/points`, {
        method: 'PUT',
        body: {
            points: [{
                ...point,
                id: normalizePointId(point.id)
            }]
        }
    });
}

async function searchMemoryPoints(userId, queryVector, filter, limit = 5) {
    const collectionName = await ensureCollection(userId, queryVector.length || DEFAULT_VECTOR_SIZE);
    const response = await qdrantRequest(`/collections/${collectionName}/points/search`, {
        method: 'POST',
        body: {
            vector: queryVector,
            filter,
            limit,
            with_payload: true,
            with_vector: false,
            score_threshold: 0.2
        }
    });
    return Array.isArray(response?.result) ? response.result : [];
}

async function deleteMemoryPoint(userId, pointId) {
    const collectionName = await ensureCollection(userId);
    await qdrantRequest(`/collections/${collectionName}/points/delete`, {
        method: 'POST',
        body: {
            points: [normalizePointId(pointId)]
        }
    });
}

async function deleteCharacterPoints(userId, characterId) {
    const collectionName = await ensureCollection(userId);
    await qdrantRequest(`/collections/${collectionName}/points/delete`, {
        method: 'POST',
        body: {
            filter: {
                must: [
                    {
                        key: 'character_id',
                        match: { value: String(characterId) }
                    }
                ]
            }
        }
    });
}

async function deleteUserCollection(userId) {
    const collectionName = getCollectionName(userId);
    try {
        await qdrantRequest(`/collections/${collectionName}`, {
            method: 'DELETE'
        });
    } finally {
        ensuredCollections.delete(collectionName);
        pendingCollectionEnsures.delete(collectionName);
    }
}

async function healthcheck() {
    try {
        await qdrantRequest('/collections');
        return true;
    } catch (e) {
        return false;
    }
}

async function listCollections() {
    const response = await qdrantRequest('/collections');
    return Array.isArray(response?.result?.collections) ? response.result.collections : [];
}

async function getCollectionInfo(collectionName) {
    const response = await qdrantRequest(`/collections/${collectionName}`);
    return response?.result || null;
}

module.exports = {
    DEFAULT_VECTOR_SIZE,
    deleteCharacterPoints,
    deleteUserCollection,
    deleteMemoryPoint,
    ensureCollection,
    getCollectionInfo,
    getCollectionName,
    getQdrantConfig,
    healthcheck,
    listCollections,
    searchMemoryPoints,
    upsertMemoryPoint
};
