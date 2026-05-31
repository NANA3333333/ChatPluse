const MEMORY_BULK_MAX_IDS = 10000;
const MEMORY_MAINTENANCE_BATCH_MIN = 10;
const MEMORY_MAINTENANCE_BATCH_MAX = 100;
const MEMORY_MAINTENANCE_TOKENS_MIN = 1000;
const MEMORY_MAINTENANCE_TOKENS_MAX = 20000;
const MEMORY_MAINTENANCE_OFFSET_MAX = Number.MAX_SAFE_INTEGER;
const MEMORY_MAINTENANCE_MAX_BATCHES_MAX = 10000;
const MEMORY_MAINTENANCE_REROLLS_MAX = 10;
const MEMORY_LIBRARY_LIMIT_PER_GROUP_MAX = 120;
const MEMORY_LIBRARY_FORGETTING_LIMIT_MAX = 160;
const MEMORY_LIBRARY_TIMELINE_LIMIT_MAX = 3000;

class MemoryInputValidationError extends Error {
    constructor(message) {
        super(message);
        this.name = 'MemoryInputValidationError';
        this.status = 400;
        this.statusCode = 400;
    }
}

function reject(message) {
    throw new MemoryInputValidationError(message);
}

function normalizePositiveSafeInteger(value, label = 'Value') {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || !Number.isSafeInteger(parsed) || parsed <= 0) {
        reject(`${label} must be a positive safe integer.`);
    }
    return parsed;
}

function normalizeMemoryId(value) {
    return normalizePositiveSafeInteger(value, 'Memory id');
}

function normalizeMemoryIdList(value, options = {}) {
    if (!Array.isArray(value)) reject('Memory ids must be an array.');
    const max = normalizePositiveSafeInteger(options.max || MEMORY_BULK_MAX_IDS, 'Memory id limit');
    if (value.length > max) reject(`Too many memory ids. Maximum is ${max}.`);
    const ids = [];
    const seen = new Set();
    for (const rawId of value) {
        const id = normalizeMemoryId(rawId);
        if (seen.has(id)) continue;
        seen.add(id);
        ids.push(id);
    }
    if (ids.length === 0) reject('No memory ids provided.');
    return ids;
}

function normalizeBoundedInteger(value, label, min, max) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || !Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
        reject(`${label} must be an integer from ${min} to ${max}.`);
    }
    return parsed;
}

function normalizeMemoryMaintenanceSettingsPatch(body = {}) {
    const patch = {};
    if (Object.prototype.hasOwnProperty.call(body, 'api_endpoint')) {
        patch.memory_maintenance_api_endpoint = String(body.api_endpoint || '').trim();
    }
    if (Object.prototype.hasOwnProperty.call(body, 'api_key')) {
        patch.memory_maintenance_api_key = String(body.api_key || '').trim();
    }
    if (Object.prototype.hasOwnProperty.call(body, 'model_name')) {
        patch.memory_maintenance_model_name = String(body.model_name || '').trim();
    }
    if (Object.prototype.hasOwnProperty.call(body, 'batch_size')) {
        patch.memory_maintenance_batch_size = normalizeBoundedInteger(
            body.batch_size,
            'batch_size',
            MEMORY_MAINTENANCE_BATCH_MIN,
            MEMORY_MAINTENANCE_BATCH_MAX
        );
    }
    if (Object.prototype.hasOwnProperty.call(body, 'max_output_tokens')) {
        patch.memory_maintenance_max_tokens = normalizeBoundedInteger(
            body.max_output_tokens,
            'max_output_tokens',
            MEMORY_MAINTENANCE_TOKENS_MIN,
            MEMORY_MAINTENANCE_TOKENS_MAX
        );
    }
    return patch;
}

function normalizeOptionalBoundedInteger(value, label, min, max) {
    if (value === undefined || value === null || String(value).trim() === '') return undefined;
    return normalizeBoundedInteger(value, label, min, max);
}

function normalizeBooleanFlag(value) {
    if (value === true) return true;
    if (value === false || value === undefined || value === null) return false;
    const text = String(value).trim().toLowerCase();
    return ['1', 'true', 'yes', 'on'].includes(text);
}

function normalizeMemoryMaintenanceBatchOptions(input = {}, defaults = {}) {
    const fallbackLimit = normalizeBoundedInteger(
        defaults.limitFallback ?? defaults.limit ?? MEMORY_MAINTENANCE_BATCH_MIN,
        'limit',
        1,
        MEMORY_MAINTENANCE_BATCH_MAX
    );
    return {
        limit: normalizeOptionalBoundedInteger(input.limit, 'limit', 1, MEMORY_MAINTENANCE_BATCH_MAX) ?? fallbackLimit,
        offset: normalizeOptionalBoundedInteger(input.offset, 'offset', 0, MEMORY_MAINTENANCE_OFFSET_MAX) ?? 0,
        after_id: normalizeOptionalBoundedInteger(input.after_id, 'after_id', 0, MEMORY_MAINTENANCE_OFFSET_MAX) ?? 0
    };
}

function normalizeOptionalMemoryId(value, label = 'Memory id') {
    if (value === undefined || value === null || String(value).trim() === '') return 0;
    if (String(value).trim() === '0') return 0;
    return normalizePositiveSafeInteger(value, label);
}

function normalizeMemoryMaintenanceAutoRunControls(input = {}, defaults = {}) {
    const batch = normalizeMemoryMaintenanceBatchOptions(input, {
        limitFallback: defaults.limitFallback ?? defaults.limit ?? MEMORY_MAINTENANCE_BATCH_MIN
    });
    const rawMaxBatches = input.max_batches;
    const maxBatchesText = rawMaxBatches === undefined || rawMaxBatches === null
        ? ''
        : String(rawMaxBatches).trim().toLowerCase();
    const missingMaxBatches = rawMaxBatches === undefined || rawMaxBatches === null || maxBatchesText === '';
    const runUntilEmpty = normalizeBooleanFlag(input.run_until_empty)
        || maxBatchesText === 'all'
        || (missingMaxBatches && defaults.missingMaxBatchesMeansAll === true);
    const fallbackMaxBatches = normalizeBoundedInteger(
        defaults.maxBatchesFallback ?? 1,
        'max_batches',
        1,
        defaults.maxBatchesMax ?? MEMORY_MAINTENANCE_MAX_BATCHES_MAX
    );
    const maxBatches = runUntilEmpty
        ? null
        : (normalizeOptionalBoundedInteger(
            rawMaxBatches,
            'max_batches',
            1,
            defaults.maxBatchesMax ?? MEMORY_MAINTENANCE_MAX_BATCHES_MAX
        ) ?? fallbackMaxBatches);
    return {
        ...batch,
        max_batches: maxBatches,
        run_until_empty: runUntilEmpty,
        max_rerolls: normalizeOptionalBoundedInteger(
            input.max_rerolls,
            'max_rerolls',
            0,
            defaults.maxRerollsMax ?? MEMORY_MAINTENANCE_REROLLS_MAX
        ) ?? (defaults.maxRerollsFallback ?? 3)
    };
}

function normalizeMemoryMaintenanceLibraryOptions(query = {}) {
    const options = {
        character_id: String(query.character_id || '').trim(),
        all: query.all,
        source: query.source || 'new',
        temporal_filter: query.temporal_filter,
        timeline_filter: query.timeline_filter || 'strong_time_bound',
        timeline_all: query.timeline_all
    };
    const limitPerGroup = normalizeOptionalBoundedInteger(
        query.limit_per_group,
        'limit_per_group',
        1,
        MEMORY_LIBRARY_LIMIT_PER_GROUP_MAX
    );
    const forgettingLimit = normalizeOptionalBoundedInteger(
        query.forgetting_limit,
        'forgetting_limit',
        1,
        MEMORY_LIBRARY_FORGETTING_LIMIT_MAX
    );
    const timelineLimit = normalizeOptionalBoundedInteger(
        query.timeline_limit,
        'timeline_limit',
        1,
        MEMORY_LIBRARY_TIMELINE_LIMIT_MAX
    );
    if (limitPerGroup !== undefined) options.limit_per_group = limitPerGroup;
    if (forgettingLimit !== undefined) options.forgetting_limit = forgettingLimit;
    if (timelineLimit !== undefined) options.timeline_limit = timelineLimit;
    return options;
}

function isMemoryInputValidationError(error) {
    return error instanceof MemoryInputValidationError || error?.name === 'MemoryInputValidationError';
}

module.exports = {
    MEMORY_BULK_MAX_IDS,
    MEMORY_MAINTENANCE_BATCH_MIN,
    MEMORY_MAINTENANCE_BATCH_MAX,
    MEMORY_MAINTENANCE_MAX_BATCHES_MAX,
    MEMORY_MAINTENANCE_OFFSET_MAX,
    MEMORY_MAINTENANCE_REROLLS_MAX,
    MEMORY_MAINTENANCE_TOKENS_MIN,
    MEMORY_MAINTENANCE_TOKENS_MAX,
    MEMORY_LIBRARY_FORGETTING_LIMIT_MAX,
    MEMORY_LIBRARY_LIMIT_PER_GROUP_MAX,
    MEMORY_LIBRARY_TIMELINE_LIMIT_MAX,
    MemoryInputValidationError,
    isMemoryInputValidationError,
    normalizeMemoryId,
    normalizeMemoryIdList,
    normalizeMemoryMaintenanceAutoRunControls,
    normalizeMemoryMaintenanceBatchOptions,
    normalizeMemoryMaintenanceLibraryOptions,
    normalizeMemoryMaintenanceSettingsPatch,
    normalizeOptionalMemoryId,
    normalizePositiveSafeInteger
};
