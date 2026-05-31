const MAX_COURSE_SORT_ORDER = 10000;
const MAX_COURSE_TEXT_LENGTH = 2000;

class CityGrowthValidationError extends Error {
    constructor(message) {
        super(message);
        this.name = 'CityGrowthValidationError';
        this.statusCode = 400;
    }
}

function reject(message) {
    throw new CityGrowthValidationError(message);
}

function cleanText(value, fallback = '', maxLength = MAX_COURSE_TEXT_LENGTH) {
    const text = String(value ?? fallback).trim();
    return text.slice(0, maxLength);
}

function normalizeInteger(value, label, fallback, min, max) {
    const raw = value === undefined || value === null || String(value).trim() === '' ? fallback : value;
    const parsed = Number(raw);
    if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
        reject(`${label}无效`);
    }
    return parsed;
}

function normalizeBooleanFlag(value, fallback = 1) {
    const raw = value === undefined || value === null || String(value).trim() === '' ? fallback : value;
    const text = String(raw).trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(text)) return 1;
    if (['0', 'false', 'no', 'off'].includes(text)) return 0;
    reject('启用状态无效');
}

function normalizeCourseId(value) {
    const id = String(value || '').trim().toLowerCase().replace(/\s+/g, '_');
    if (!id || id.length > 64 || id.includes('\0') || /[/?#\\]/.test(id)) {
        reject('课程 id 无效');
    }
    return id;
}

function normalizeCityGrowthCourseId(value) {
    return normalizeCourseId(value);
}

function normalizeCityGrowthMasteryGain(value) {
    return normalizeInteger(value, '课程熟练度增量', 0, 0, 100);
}

function normalizeCityGrowthCoursePayload(payload = {}) {
    const id = normalizeCityGrowthCourseId(payload.id);
    const name = cleanText(payload.name, '', 80);
    if (!name) reject('课程名称不能为空');
    return {
        id,
        name,
        emoji: cleanText(payload.emoji, '📘', 8) || '📘',
        description: cleanText(payload.description, ''),
        category: cleanText(payload.category, 'general', 64) || 'general',
        prompt_effect_basic: cleanText(payload.prompt_effect_basic, ''),
        prompt_effect_advanced: cleanText(payload.prompt_effect_advanced, ''),
        sort_order: normalizeInteger(payload.sort_order, '课程排序', 0, -MAX_COURSE_SORT_ORDER, MAX_COURSE_SORT_ORDER),
        is_enabled: normalizeBooleanFlag(payload.is_enabled, 1)
    };
}

module.exports = {
    CityGrowthValidationError,
    MAX_COURSE_SORT_ORDER,
    isCityGrowthValidationError: (error) => error instanceof CityGrowthValidationError || error?.statusCode === 400,
    normalizeCityGrowthCourseId,
    normalizeCityGrowthMasteryGain,
    normalizeCityGrowthCoursePayload
};
