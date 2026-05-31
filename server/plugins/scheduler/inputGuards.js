const SCHEDULER_ACTION_TYPES = new Set(['chat', 'moment', 'diary', 'memory_aggregation']);
const MAX_SCHEDULER_PROMPT_LENGTH = 2000;

class SchedulerValidationError extends Error {
    constructor(message) {
        super(message);
        this.name = 'SchedulerValidationError';
        this.statusCode = 400;
    }
}

function reject(message) {
    throw new SchedulerValidationError(message);
}

function hasValue(value) {
    return value !== undefined && value !== null && String(value).trim() !== '';
}

function normalizeSchedulerBoolean(value, fallback = 1) {
    if (!hasValue(value)) return fallback ? 1 : 0;
    const text = String(value).trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(text)) return 1;
    if (['0', 'false', 'no', 'off'].includes(text)) return 0;
    reject('Invalid scheduler enabled flag');
}

function normalizeSchedulerBatchSize(value, fallback = 80) {
    if (!hasValue(value)) return fallback;
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < 10 || parsed > 500) {
        reject('Invalid scheduler batch size');
    }
    return parsed;
}

function normalizeSchedulerCron(value) {
    const cron = String(value || '').trim();
    if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(cron)) {
        reject('Invalid scheduler time');
    }
    return cron;
}

function normalizeSchedulerActionType(value) {
    const actionType = String(value || '').trim();
    if (!SCHEDULER_ACTION_TYPES.has(actionType)) {
        reject('Invalid scheduler action type');
    }
    return actionType;
}

function normalizeSchedulerTaskId(value) {
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed <= 0) {
        reject('Invalid scheduler task id');
    }
    return parsed;
}

function normalizeSchedulerTaskPayload(payload = {}) {
    const characterId = String(payload.character_id || '').trim();
    if (!characterId) reject('Missing scheduler character');
    const actionType = normalizeSchedulerActionType(payload.action_type);
    return {
        character_id: characterId,
        cron_expr: normalizeSchedulerCron(payload.cron_expr),
        task_prompt: String(payload.task_prompt || '').trim().slice(0, MAX_SCHEDULER_PROMPT_LENGTH),
        action_type: actionType,
        is_enabled: normalizeSchedulerBoolean(payload.is_enabled, 1),
        batch_size: actionType === 'memory_aggregation'
            ? normalizeSchedulerBatchSize(payload.batch_size, 80)
            : 80
    };
}

module.exports = {
    SchedulerValidationError,
    SCHEDULER_ACTION_TYPES,
    isSchedulerValidationError: (error) => error instanceof SchedulerValidationError || error?.statusCode === 400,
    normalizeSchedulerBatchSize,
    normalizeSchedulerTaskId,
    normalizeSchedulerTaskPayload
};
