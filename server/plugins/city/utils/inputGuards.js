const MAX_CITY_GOLD_GRANT = 1000000;
const MAX_CITY_CALORIES_GRANT = 4000;
const MAX_CITY_ITEM_QUANTITY = 100;
const MAX_CITY_TIME_SKIP_MINUTES = 1440;
const MAX_CITY_QUEST_REWARD_GOLD = 1000000;
const MAX_CITY_QUEST_REWARD_CALORIES = 4000;
const MAX_CITY_QUEST_COMPLETION_TARGET = 10;
const MAX_CITY_EVENT_DURATION_HOURS = 168;
const MAX_CITY_EVENT_CAL_BONUS = 4000;
const MAX_CITY_EVENT_MONEY_BONUS = 100000;
const MAX_CITY_EVENT_MODIFIER = 5;
const MAX_CITY_ITEM_PRICE = 1000000;
const MAX_CITY_ITEM_CAL_RESTORE = 4000;
const MAX_CITY_ITEM_STOCK = 100000;
const MAX_CITY_ITEM_SORT_ORDER = 10000;
const MAX_CITY_DISTRICT_CAL_COST = 4000;
const MAX_CITY_DISTRICT_CAL_REWARD = 4000;
const MAX_CITY_DISTRICT_MONEY_COST = 1000000;
const MAX_CITY_DISTRICT_MONEY_REWARD = 1000000;
const MAX_CITY_DISTRICT_DURATION_TICKS = 1440;
const MAX_CITY_DISTRICT_CAPACITY = 10000;
const MAX_CITY_DISTRICT_SORT_ORDER = 10000;
const MAX_CITY_CONFIG_LOG_LIMIT = 20;
const MAX_CITY_CONFIG_INTERVAL_HOURS = 168;
const MAX_CITY_CONFIG_TIME_OFFSET_DAYS = 3650;
const MAX_CITY_CONFIG_MULTIPLIER = 100;
const MAX_CITY_LOG_QUERY_LIMIT = 10000;
const MAX_CITY_ANNOUNCEMENT_QUERY_LIMIT = 200;

const BOOLEAN_CONFIG_KEYS = new Set([
    'dlc_enabled',
    'city_actions_paused',
    'mayor_enabled'
]);

const INTEGER_CONFIG_RANGES = {
    metabolism_rate: [0, MAX_CITY_CALORIES_GRANT],
    city_self_log_limit: [0, MAX_CITY_CONFIG_LOG_LIMIT],
    city_social_log_limit: [0, MAX_CITY_CONFIG_LOG_LIMIT],
    city_announcement_limit: [0, MAX_CITY_CONFIG_LOG_LIMIT],
    city_global_log_limit: [0, MAX_CITY_CONFIG_LOG_LIMIT],
    city_stranger_meet_prob: [0, 100],
    city_chat_probability: [0, 100],
    city_moment_probability: [0, 100],
    city_diary_probability: [0, 100],
    mayor_interval_hours: [1, MAX_CITY_CONFIG_INTERVAL_HOURS],
    city_time_offset_days: [-MAX_CITY_CONFIG_TIME_OFFSET_DAYS, MAX_CITY_CONFIG_TIME_OFFSET_DAYS]
};

const NUMBER_CONFIG_RANGES = {
    inflation: [0, MAX_CITY_CONFIG_MULTIPLIER],
    work_bonus: [0, MAX_CITY_CONFIG_MULTIPLIER],
    gambling_win_rate: [0, 1],
    gambling_payout: [0, MAX_CITY_CONFIG_MULTIPLIER],
    city_time_offset_hours: [0, 24]
};

function hasProvidedValue(value) {
    return value !== undefined && value !== null && String(value).trim() !== '';
}

function normalizePositiveMoney(value, max = MAX_CITY_GOLD_GRANT) {
    const amount = Number(value);
    if (!Number.isFinite(amount) || amount <= 0 || amount > max) return null;
    const rounded = +amount.toFixed(2);
    return rounded > 0 && rounded <= max ? rounded : null;
}

function normalizeBoundedInteger(value, min, max) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) return null;
    if (parsed < min || parsed > max) return null;
    return parsed;
}

function normalizeCityRowId(value) {
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed <= 0) return null;
    return parsed;
}

function normalizeCityListLimit(value, { fallback, max, allowAll = false } = {}) {
    const maxLimit = Number.isSafeInteger(max) && max > 0 ? max : MAX_CITY_LOG_QUERY_LIMIT;
    const fallbackLimit = Number.isSafeInteger(fallback) && fallback > 0 ? Math.min(fallback, maxLimit) : maxLimit;
    if (allowAll && String(value ?? '').trim().toLowerCase() === 'all') return 'all';
    if (!hasProvidedValue(value)) return fallbackLimit;
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed <= 0) return null;
    return Math.min(parsed, maxLimit);
}

function normalizeOptionalNonNegativeMoney(value, fallback, max) {
    const amount = hasProvidedValue(value) ? Number(value) : Number(fallback);
    if (!Number.isFinite(amount) || amount < 0 || amount > max) return null;
    const rounded = +amount.toFixed(2);
    return rounded >= 0 && rounded <= max ? rounded : null;
}

function normalizeOptionalBoundedMoney(value, fallback, min, max) {
    const amount = hasProvidedValue(value) ? Number(value) : Number(fallback);
    if (!Number.isFinite(amount) || amount < min || amount > max) return null;
    const rounded = +amount.toFixed(2);
    return rounded >= min && rounded <= max ? rounded : null;
}

function normalizeOptionalBoundedInteger(value, fallback, min, max) {
    const parsed = hasProvidedValue(value) ? Number(value) : Number(fallback);
    if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) return null;
    if (parsed < min || parsed > max) return null;
    return parsed;
}

function normalizeCityGoldAmount(value) {
    return normalizePositiveMoney(value, MAX_CITY_GOLD_GRANT);
}

function normalizeCityCalories(value) {
    return normalizeBoundedInteger(value, 1, MAX_CITY_CALORIES_GRANT);
}

function normalizeCityItemQuantity(value) {
    return normalizeBoundedInteger(value, 1, MAX_CITY_ITEM_QUANTITY);
}

function normalizeCityTimeSkipMinutes(value) {
    return normalizeBoundedInteger(value, 1, MAX_CITY_TIME_SKIP_MINUTES);
}

function normalizeStoredCityOffsetDays(value) {
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < -MAX_CITY_CONFIG_TIME_OFFSET_DAYS || parsed > MAX_CITY_CONFIG_TIME_OFFSET_DAYS) return 0;
    return parsed;
}

function normalizeStoredCityOffsetHours(value) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 0 || parsed >= 24) return 0;
    return parsed;
}

function normalizeCityQuestGoldReward(value, fallback = 50) {
    return normalizeOptionalNonNegativeMoney(value, fallback, MAX_CITY_QUEST_REWARD_GOLD);
}

function normalizeCityQuestCaloriesReward(value, fallback = 0) {
    return normalizeOptionalBoundedInteger(value, fallback, 0, MAX_CITY_QUEST_REWARD_CALORIES);
}

function normalizeCityQuestCompletionTarget(value, fallback = 2) {
    return normalizeOptionalBoundedInteger(value, fallback, 1, MAX_CITY_QUEST_COMPLETION_TARGET);
}

function normalizeCityQuestPayload(data = {}) {
    const rewardGold = normalizeCityQuestGoldReward(data.reward_gold, 50);
    const rewardCalories = normalizeCityQuestCaloriesReward(data.reward_cal, 0);
    const completionTarget = normalizeCityQuestCompletionTarget(data.completion_target, 2);
    if (rewardGold === null || rewardCalories === null || completionTarget === null) return null;
    return {
        ...data,
        reward_gold: rewardGold,
        reward_cal: rewardCalories,
        completion_target: completionTarget
    };
}

function parseEventEffect(value) {
    if (!hasProvidedValue(value)) return {};
    if (value && typeof value === 'object' && !Array.isArray(value)) return value;
    if (typeof value === 'string') {
        try {
            const parsed = JSON.parse(value);
            return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
        } catch (e) {
            return null;
        }
    }
    return null;
}

function normalizeCityEventEffect(value = {}) {
    const effect = parseEventEffect(value);
    if (!effect) return null;
    const normalized = {};
    const district = String(effect.district || '').trim();
    if (district) normalized.district = district;

    if (hasProvidedValue(effect.cal_bonus)) {
        const calBonus = normalizeOptionalBoundedInteger(effect.cal_bonus, 0, -MAX_CITY_EVENT_CAL_BONUS, MAX_CITY_EVENT_CAL_BONUS);
        if (calBonus === null) return null;
        normalized.cal_bonus = calBonus;
    }
    if (hasProvidedValue(effect.money_bonus)) {
        const moneyBonus = normalizeOptionalBoundedMoney(effect.money_bonus, 0, -MAX_CITY_EVENT_MONEY_BONUS, MAX_CITY_EVENT_MONEY_BONUS);
        if (moneyBonus === null) return null;
        normalized.money_bonus = moneyBonus;
    }
    if (hasProvidedValue(effect.price_modifier)) {
        const priceModifier = normalizeOptionalBoundedMoney(effect.price_modifier, 1, 0.1, MAX_CITY_EVENT_MODIFIER);
        if (priceModifier === null) return null;
        normalized.price_modifier = priceModifier;
    }
    if (hasProvidedValue(effect.cal_modifier)) {
        const calModifier = normalizeOptionalBoundedMoney(effect.cal_modifier, 1, 0.1, MAX_CITY_EVENT_MODIFIER);
        if (calModifier === null) return null;
        normalized.cal_modifier = calModifier;
    }
    return normalized;
}

function normalizeCityEventPayload(data = {}) {
    const durationHours = normalizeOptionalBoundedInteger(data.duration_hours, 24, 1, MAX_CITY_EVENT_DURATION_HOURS);
    const effect = normalizeCityEventEffect(data.effect ?? data.effect_json ?? {});
    if (durationHours === null || effect === null) return null;
    return {
        ...data,
        effect,
        target_district: String(data.target_district || effect.district || '').trim(),
        duration_hours: durationHours
    };
}

function normalizeCityItemStock(value, fallback = -1) {
    const parsed = hasProvidedValue(value) ? Number(value) : Number(fallback);
    if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) return null;
    if (parsed !== -1 && (parsed < 0 || parsed > MAX_CITY_ITEM_STOCK)) return null;
    return parsed;
}

function normalizeCityCatalogItemPayload(data = {}) {
    const buyPrice = normalizeOptionalNonNegativeMoney(data.buy_price, 10, MAX_CITY_ITEM_PRICE);
    const sellPrice = normalizeOptionalNonNegativeMoney(data.sell_price, 0, MAX_CITY_ITEM_PRICE);
    const calRestore = normalizeOptionalBoundedInteger(data.cal_restore, 0, 0, MAX_CITY_ITEM_CAL_RESTORE);
    const stock = normalizeCityItemStock(data.stock, -1);
    const sortOrder = normalizeOptionalBoundedInteger(data.sort_order, 0, -MAX_CITY_ITEM_SORT_ORDER, MAX_CITY_ITEM_SORT_ORDER);
    if (buyPrice === null || sellPrice === null || calRestore === null || stock === null || sortOrder === null) return null;
    return {
        ...data,
        buy_price: buyPrice,
        sell_price: sellPrice,
        cal_restore: calRestore,
        is_available: Number(data.is_available ?? 1) === 1 ? 1 : 0,
        sort_order: sortOrder,
        stock
    };
}

function normalizeCityDistrictPayload(data = {}) {
    const calCost = normalizeOptionalBoundedInteger(data.cal_cost, 0, 0, MAX_CITY_DISTRICT_CAL_COST);
    const calReward = normalizeOptionalBoundedInteger(data.cal_reward, 0, 0, MAX_CITY_DISTRICT_CAL_REWARD);
    const moneyCost = normalizeOptionalNonNegativeMoney(data.money_cost, 0, MAX_CITY_DISTRICT_MONEY_COST);
    const moneyReward = normalizeOptionalNonNegativeMoney(data.money_reward, 0, MAX_CITY_DISTRICT_MONEY_REWARD);
    const durationTicks = normalizeOptionalBoundedInteger(data.duration_ticks, 1, 1, MAX_CITY_DISTRICT_DURATION_TICKS);
    const capacity = normalizeOptionalBoundedInteger(data.capacity, 0, 0, MAX_CITY_DISTRICT_CAPACITY);
    const sortOrder = normalizeOptionalBoundedInteger(data.sort_order, 0, -MAX_CITY_DISTRICT_SORT_ORDER, MAX_CITY_DISTRICT_SORT_ORDER);
    if (
        calCost === null ||
        calReward === null ||
        moneyCost === null ||
        moneyReward === null ||
        durationTicks === null ||
        capacity === null ||
        sortOrder === null
    ) return null;
    return {
        ...data,
        cal_cost: calCost,
        cal_reward: calReward,
        money_cost: moneyCost,
        money_reward: moneyReward,
        duration_ticks: durationTicks,
        capacity,
        is_enabled: Number(data.is_enabled ?? 1) === 1 ? 1 : 0,
        sort_order: sortOrder
    };
}

function normalizeBooleanConfigValue(value) {
    const text = String(value ?? '').trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(text)) return '1';
    if (['0', 'false', 'no', 'off'].includes(text)) return '0';
    return null;
}

function normalizeCityConfigValue(key, value) {
    const cleanKey = String(key || '').trim();
    if (!cleanKey) return null;
    if (BOOLEAN_CONFIG_KEYS.has(cleanKey)) return normalizeBooleanConfigValue(value);
    if (Object.prototype.hasOwnProperty.call(INTEGER_CONFIG_RANGES, cleanKey)) {
        const [min, max] = INTEGER_CONFIG_RANGES[cleanKey];
        const parsed = normalizeOptionalBoundedInteger(value, undefined, min, max);
        return parsed === null ? null : String(parsed);
    }
    if (Object.prototype.hasOwnProperty.call(NUMBER_CONFIG_RANGES, cleanKey)) {
        const [min, max] = NUMBER_CONFIG_RANGES[cleanKey];
        const parsed = Number(value);
        if (!Number.isFinite(parsed) || parsed < min || parsed > max) return null;
        if (cleanKey === 'city_time_offset_hours' && parsed >= 24) return null;
        return String(parsed);
    }
    if (cleanKey === 'mayor_last_run_at') {
        const parsed = normalizeOptionalBoundedInteger(value, 0, 0, Number.MAX_SAFE_INTEGER);
        return parsed === null ? null : String(parsed);
    }
    return String(value ?? '');
}

module.exports = {
    MAX_CITY_GOLD_GRANT,
    MAX_CITY_CALORIES_GRANT,
    MAX_CITY_ITEM_QUANTITY,
    MAX_CITY_TIME_SKIP_MINUTES,
    MAX_CITY_QUEST_REWARD_GOLD,
    MAX_CITY_QUEST_REWARD_CALORIES,
    MAX_CITY_QUEST_COMPLETION_TARGET,
    MAX_CITY_EVENT_DURATION_HOURS,
    MAX_CITY_EVENT_CAL_BONUS,
    MAX_CITY_EVENT_MONEY_BONUS,
    MAX_CITY_EVENT_MODIFIER,
    MAX_CITY_ITEM_PRICE,
    MAX_CITY_ITEM_CAL_RESTORE,
    MAX_CITY_ITEM_STOCK,
    MAX_CITY_ITEM_SORT_ORDER,
    MAX_CITY_DISTRICT_CAL_COST,
    MAX_CITY_DISTRICT_CAL_REWARD,
    MAX_CITY_DISTRICT_MONEY_COST,
    MAX_CITY_DISTRICT_MONEY_REWARD,
    MAX_CITY_DISTRICT_DURATION_TICKS,
    MAX_CITY_DISTRICT_CAPACITY,
    MAX_CITY_DISTRICT_SORT_ORDER,
    MAX_CITY_CONFIG_LOG_LIMIT,
    MAX_CITY_CONFIG_INTERVAL_HOURS,
    MAX_CITY_CONFIG_TIME_OFFSET_DAYS,
    MAX_CITY_CONFIG_MULTIPLIER,
    MAX_CITY_LOG_QUERY_LIMIT,
    MAX_CITY_ANNOUNCEMENT_QUERY_LIMIT,
    normalizeCityRowId,
    normalizeCityListLimit,
    normalizeCityGoldAmount,
    normalizeCityCalories,
    normalizeCityItemQuantity,
    normalizeCityTimeSkipMinutes,
    normalizeStoredCityOffsetDays,
    normalizeStoredCityOffsetHours,
    normalizeCityQuestGoldReward,
    normalizeCityQuestCaloriesReward,
    normalizeCityQuestCompletionTarget,
    normalizeCityQuestPayload,
    normalizeCityEventEffect,
    normalizeCityEventPayload,
    normalizeCityCatalogItemPayload,
    normalizeCityDistrictPayload,
    normalizeCityConfigValue
};
