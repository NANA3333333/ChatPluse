const MAX_SOCIAL_HOUSING_MONEY = 1000000;
const MAX_SOCIAL_HOUSING_SCORE = 100;
const MAX_SOCIAL_HOUSING_CLASS_BIAS = 100;
const MAX_SOCIAL_HOUSING_SORT_ORDER = 10000;
const MAX_SOCIAL_HOUSING_RENT_DUE_DAY = 30;
const MAX_SOCIAL_HOUSING_MISSED_RENT_COUNT = 365;
const MAX_SOCIAL_HOUSING_AGENCY_INTERVAL_HOURS = 168;
const DEFAULT_SOCIAL_HOUSING_AGENCY_INTERVAL_HOURS = 6;

class SocialHousingValidationError extends Error {
    constructor(message) {
        super(message);
        this.name = 'SocialHousingValidationError';
        this.statusCode = 400;
    }
}

function hasValue(payload, key) {
    if (!payload || !Object.prototype.hasOwnProperty.call(payload, key)) return false;
    const value = payload[key];
    return value !== undefined && value !== null && String(value).trim() !== '';
}

function reject(message) {
    throw new SocialHousingValidationError(message);
}

function normalizeMoney(value, label, max = MAX_SOCIAL_HOUSING_MONEY) {
    const amount = Number(value ?? 0);
    if (!Number.isFinite(amount) || amount < 0 || amount > max) reject(`${label}无效`);
    return +amount.toFixed(2);
}

function normalizeBoundedNumber(value, label, min, max, fallback = 0) {
    const parsed = Number(value ?? fallback);
    if (!Number.isFinite(parsed) || parsed < min || parsed > max) reject(`${label}无效`);
    return parsed;
}

function normalizeBoundedInteger(value, label, min, max, fallback = 0) {
    const parsed = Number(value ?? fallback);
    if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < min || parsed > max) {
        reject(`${label}无效`);
    }
    return parsed;
}

function normalizeHousingPayload(payload = {}) {
    return {
        ...payload,
        weekly_rent: normalizeMoney(payload.weekly_rent, '每周租金'),
        deposit: normalizeMoney(payload.deposit, '押金'),
        sale_price: normalizeMoney(payload.sale_price, '售价'),
        comfort: normalizeBoundedNumber(payload.comfort, '舒适度', 0, MAX_SOCIAL_HOUSING_SCORE),
        prestige: normalizeBoundedNumber(payload.prestige, '体面值', 0, MAX_SOCIAL_HOUSING_SCORE),
        privacy: normalizeBoundedNumber(payload.privacy, '隐私值', 0, MAX_SOCIAL_HOUSING_SCORE),
        is_enabled: Number(payload.is_enabled ?? 1) === 1 ? 1 : 0,
        sort_order: normalizeBoundedInteger(payload.sort_order, '排序', -MAX_SOCIAL_HOUSING_SORT_ORDER, MAX_SOCIAL_HOUSING_SORT_ORDER)
    };
}

function normalizeSocialClassPayload(payload = {}) {
    const name = String(payload.name || '').trim();
    if (!name) reject('缺少阶级名称');
    return {
        ...payload,
        name,
        work_bias: normalizeBoundedInteger(payload.work_bias, '工作倾向', -MAX_SOCIAL_HOUSING_CLASS_BIAS, MAX_SOCIAL_HOUSING_CLASS_BIAS),
        consumption_bias: normalizeBoundedInteger(payload.consumption_bias, '消费倾向', -MAX_SOCIAL_HOUSING_CLASS_BIAS, MAX_SOCIAL_HOUSING_CLASS_BIAS),
        prestige_bias: normalizeBoundedInteger(payload.prestige_bias, '体面倾向', -MAX_SOCIAL_HOUSING_CLASS_BIAS, MAX_SOCIAL_HOUSING_CLASS_BIAS),
        social_barrier: normalizeBoundedInteger(payload.social_barrier, '社交门槛', -MAX_SOCIAL_HOUSING_CLASS_BIAS, MAX_SOCIAL_HOUSING_CLASS_BIAS),
        is_enabled: Number(payload.is_enabled ?? 1) === 1 ? 1 : 0,
        sort_order: normalizeBoundedInteger(payload.sort_order, '排序', -MAX_SOCIAL_HOUSING_SORT_ORDER, MAX_SOCIAL_HOUSING_SORT_ORDER)
    };
}

function normalizeBindingRentWeekly(payload = {}, home = null) {
    if (hasValue(payload, 'rent_weekly')) {
        const amount = normalizeMoney(payload.rent_weekly, '绑定租金');
        if (amount > 0) return amount;
    }
    return normalizeMoney(home?.weekly_rent ?? 0, '默认租金');
}

function normalizeHousingBindingPayload(payload = {}, current = null, home = null) {
    const nextHousingId = String(payload.housing_id || '').trim();
    const housingChanged = String(nextHousingId || '') !== String(current?.housing_id || '');
    return {
        ...payload,
        housing_id: nextHousingId,
        rent_weekly: normalizeBindingRentWeekly(payload, home),
        rent_due_day: normalizeBoundedInteger(
            hasValue(payload, 'rent_due_day') ? payload.rent_due_day : current?.rent_due_day ?? 7,
            '缴租周期',
            1,
            MAX_SOCIAL_HOUSING_RENT_DUE_DAY,
            7
        ),
        rent_last_paid_at: normalizeBoundedInteger(
            payload.rent_last_paid_at ?? current?.rent_last_paid_at ?? 0,
            '上次缴租时间',
            0,
            Number.MAX_SAFE_INTEGER
        ),
        rent_due_at: normalizeBoundedInteger(
            payload.rent_due_at ?? current?.rent_due_at ?? 0,
            '下次缴租时间',
            0,
            Number.MAX_SAFE_INTEGER
        ),
        deposit_paid: normalizeMoney(payload.deposit_paid ?? current?.deposit_paid ?? 0, '已付押金'),
        missed_rent_count: normalizeBoundedInteger(
            payload.missed_rent_count ?? (housingChanged ? 0 : current?.missed_rent_count) ?? 0,
            '欠租次数',
            0,
            MAX_SOCIAL_HOUSING_MISSED_RENT_COUNT
        )
    };
}

function normalizeTimestamp(value, label, fallback = 0) {
    const parsed = Number(value ?? fallback);
    if (!Number.isFinite(parsed) || parsed < 0 || parsed > Number.MAX_SAFE_INTEGER) reject(`${label}无效`);
    return Math.floor(parsed);
}

function normalizeAgencyDecisionIntervalHours(value, fallback = DEFAULT_SOCIAL_HOUSING_AGENCY_INTERVAL_HOURS) {
    return normalizeBoundedNumber(
        value ?? fallback,
        '中介调度间隔',
        1,
        MAX_SOCIAL_HOUSING_AGENCY_INTERVAL_HOURS,
        fallback
    );
}

function normalizeAgencyIntervalMinutes(value, fallback = DEFAULT_SOCIAL_HOUSING_AGENCY_INTERVAL_HOURS) {
    return Math.round(normalizeAgencyDecisionIntervalHours(value, fallback) * 60);
}

function normalizeStoredAgencyDecisionIntervalHours(value, fallback = DEFAULT_SOCIAL_HOUSING_AGENCY_INTERVAL_HOURS) {
    try {
        return normalizeAgencyDecisionIntervalHours(value, fallback);
    } catch (_err) {
        return fallback;
    }
}

function normalizeStoredAgencyIntervalMinutes(value, fallback = DEFAULT_SOCIAL_HOUSING_AGENCY_INTERVAL_HOURS) {
    return Math.round(normalizeStoredAgencyDecisionIntervalHours(value, fallback) * 60);
}

function normalizeStoredAgencyTimestamp(value, fallback = 0) {
    try {
        return normalizeTimestamp(value, '存储时间', fallback);
    } catch (_err) {
        return fallback;
    }
}

function normalizeAgencyConfigPayload(payload = {}, current = {}) {
    const decisionIntervalHours = normalizeAgencyDecisionIntervalHours(
        payload.decision_interval_hours ?? current?.decision_interval_hours ?? 6,
        6
    );
    const intervalMinutes = normalizeAgencyIntervalMinutes(decisionIntervalHours);
    const enabled = Number(payload.enabled ?? current?.enabled ?? 1) === 1 ? 1 : 0;
    const adEnabled = Number(payload.ad_enabled ?? payload.enabled ?? current?.ad_enabled ?? enabled) === 1 ? 1 : 0;
    return {
        ...payload,
        enabled,
        ad_enabled: adEnabled,
        ad_min_interval_minutes: intervalMinutes,
        ad_max_interval_minutes: intervalMinutes,
        decision_interval_hours: decisionIntervalHours,
        last_ad_at: normalizeTimestamp(payload.last_ad_at ?? current?.last_ad_at ?? 0, '上次广告时间'),
        next_ad_at: normalizeTimestamp(payload.next_ad_at ?? current?.next_ad_at ?? 0, '下次广告时间'),
        last_error_at: normalizeTimestamp(payload.last_error_at ?? current?.last_error_at ?? 0, '上次错误时间')
    };
}

function isSocialHousingValidationError(error) {
    return error instanceof SocialHousingValidationError || error?.name === 'SocialHousingValidationError';
}

module.exports = {
    MAX_SOCIAL_HOUSING_MONEY,
    MAX_SOCIAL_HOUSING_SCORE,
    MAX_SOCIAL_HOUSING_CLASS_BIAS,
    MAX_SOCIAL_HOUSING_RENT_DUE_DAY,
    MAX_SOCIAL_HOUSING_MISSED_RENT_COUNT,
    MAX_SOCIAL_HOUSING_AGENCY_INTERVAL_HOURS,
    DEFAULT_SOCIAL_HOUSING_AGENCY_INTERVAL_HOURS,
    SocialHousingValidationError,
    isSocialHousingValidationError,
    normalizeSocialClassPayload,
    normalizeHousingPayload,
    normalizeHousingBindingPayload,
    normalizeAgencyDecisionIntervalHours,
    normalizeAgencyIntervalMinutes,
    normalizeStoredAgencyDecisionIntervalHours,
    normalizeStoredAgencyIntervalMinutes,
    normalizeStoredAgencyTimestamp,
    normalizeAgencyConfigPayload
};
