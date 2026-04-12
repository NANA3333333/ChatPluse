function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

function getSchoolTier(mastery) {
    const value = Number(mastery || 0);
    if (value >= 85) return 'mastered';
    if (value >= 70) return 'advanced';
    if (value >= 40) return 'basic';
    if (value > 0) return 'intro';
    return 'none';
}

function buildCharacterSchoolSummary(growthDb, charId) {
    const rows = (growthDb.getCharacterCourseProgress(charId) || []).map((row) => ({
        ...row,
        mastery: Number(row.mastery || 0),
        last_studied_at: Number(row.last_studied_at || 0),
    }));
    const studied = rows.filter((row) => row.mastery > 0);
    const strongest = studied
        .slice()
        .sort((a, b) => {
            const masteryDelta = Number(b.mastery || 0) - Number(a.mastery || 0);
            if (masteryDelta !== 0) return masteryDelta;
            return Number(b.last_studied_at || 0) - Number(a.last_studied_at || 0);
        })[0] || null;
    const totalMastery = studied.reduce((sum, row) => sum + Number(row.mastery || 0), 0);
    const averageMastery = studied.length > 0 ? Math.round(totalMastery / studied.length) : 0;
    const tierCounts = studied.reduce((acc, row) => {
        const tier = getSchoolTier(row.mastery);
        acc[tier] = (acc[tier] || 0) + 1;
        return acc;
    }, { intro: 0, basic: 0, advanced: 0, mastered: 0 });

    return {
        studied_count: studied.length,
        average_mastery: averageMastery,
        strongest_course_id: strongest?.course_id || '',
        strongest_course_name: strongest?.name || '',
        strongest_course_emoji: strongest?.emoji || '',
        strongest_mastery: Number(strongest?.mastery || 0),
        strongest_tier: getSchoolTier(strongest?.mastery || 0),
        latest_studied_at: studied.reduce((max, row) => Math.max(max, Number(row.last_studied_at || 0)), 0),
        tier_counts: tierCounts,
    };
}

function getCharacterSchoolProfile(growthDb, charId) {
    const progressRows = growthDb.getCharacterCourseProgress(charId) || [];
    const map = Object.fromEntries(progressRows.map((row) => [row.course_id, row]));
    const masteryOf = (courseId) => Number(map[courseId]?.mastery || 0);
    return {
        rows: progressRows,
        map,
        masteryOf,
        psychology: masteryOf('psychology'),
        vocational: masteryOf('vocational'),
        social: masteryOf('social'),
        lifeManagement: masteryOf('life_management'),
    };
}

function normalizePromptEffectText(text) {
    return String(text || '').trim().replace(/\r\n/g, '\n');
}

function getBuiltInPromptEffect(courseId, mastery) {
    if (courseId === 'psychology' && mastery >= 70) return '心理课熟练：在难受、烦躁或委屈时，更会主动安抚自己、换环境、休息，先把情绪稳住。';
    if (courseId === 'psychology' && mastery >= 40) return '心理课入门：在难受、烦躁或委屈时，更容易先找能让自己缓下来的做法。';
    if (courseId === 'vocational' && mastery >= 70) return '职业课熟练：做事更稳，工作时更敢接活，也更容易给人靠谱的感觉。';
    if (courseId === 'vocational' && mastery >= 40) return '职业课入门：工作时更有流程感和把握感，不容易因为一点压力就乱掉。';
    if (courseId === 'life_management' && mastery >= 70) return '生活管理课熟练：更会自然安排吃饭、休息和花钱，不容易把自己拖垮。';
    if (courseId === 'life_management' && mastery >= 40) return '生活管理课入门：更会照顾身体节奏和消费，不容易把自己搞得太糟。';
    if (courseId === 'social' && mastery >= 70) return '社交课熟练：更会读空气，也更知道什么时候该接住场面。';
    if (courseId === 'social' && mastery >= 40) return '社交课入门：更会读空气，知道什么时候该靠近、什么时候该收一点。';
    return '';
}

function getCoursePromptEffect(row) {
    const mastery = Number(row?.mastery || 0);
    const configuredAdvanced = normalizePromptEffectText(row?.prompt_effect_advanced);
    const configuredBasic = normalizePromptEffectText(row?.prompt_effect_basic);
    if (mastery >= 70 && configuredAdvanced) return configuredAdvanced;
    if (mastery >= 40 && configuredBasic) return configuredBasic;
    return getBuiltInPromptEffect(row?.course_id, mastery);
}

function buildSchoolPromptBlock(growthDb, char) {
    const profile = getCharacterSchoolProfile(growthDb, char.id);
    if (!profile.rows.length) return '';

    const learned = profile.rows
        .map((row) => `${row.emoji || '📘'}${row.name} ${row.mastery}/100`)
        .join(' / ');
    const lines = [`[学校成长] 已修课程：${learned}`];

    for (const row of profile.rows) {
        const effect = getCoursePromptEffect(row);
        if (!effect) continue;
        lines.push(`- ${row.emoji || '📘'}${row.name}：${effect}`);
    }

    return lines.join('\n');
}

function getSchoolActionEffects(growthDb, char, district, currentState) {
    if (district.type !== 'education') return null;
    const courses = growthDb.getEnabledSchoolCourses();
    if (!courses.length) return null;

    const profile = getCharacterSchoolProfile(growthDb, char.id);
    const deficits = {
        psychology: Math.max(0, (currentState.stress || 0) - 35) + Math.max(0, 45 - (currentState.mood || 50)),
        vocational: Math.max(0, 55 - (char.stat_int ?? 50)) + Math.max(0, 55 - (char.stat_sta ?? 50)),
        social: Math.max(0, (currentState.social_need || 50) - 45) + Math.max(0, 55 - (char.stat_cha ?? 50)),
        life_management: Math.max(0, 35 - (currentState.energy || 50)) + Math.max(0, (currentState.stomach_load || 0) - 35) + Math.max(0, 35 - (currentState.satiety || 50)),
    };

    const weighted = courses.map((course) => {
        const currentMastery = profile.masteryOf(course.id);
        const catchUp = Math.max(0, 100 - currentMastery);
        const situational = deficits[course.id] || 0;
        return { course, weight: 10 + catchUp * 0.3 + situational };
    });

    const totalWeight = weighted.reduce((sum, entry) => sum + entry.weight, 0);
    let roll = Math.random() * Math.max(1, totalWeight);
    let chosen = weighted[0]?.course || courses[0];
    for (const entry of weighted) {
        roll -= entry.weight;
        if (roll <= 0) {
            chosen = entry.course;
            break;
        }
    }

    const beforeMastery = profile.masteryOf(chosen.id);
    const gain = clamp(8 + Math.round(Math.random() * 6) + Math.max(0, Math.floor((100 - beforeMastery) / 18)), 6, 18);
    const afterMastery = clamp(beforeMastery + gain, 0, 100);
    const unlockedTier = beforeMastery < 40 && afterMastery >= 40
        ? 'basic'
        : beforeMastery < 70 && afterMastery >= 70
            ? 'advanced'
            : '';

    return { course: chosen, gain, beforeMastery, afterMastery, unlockedTier };
}

function applySchoolPerksToState(district, stateEffects, schoolProfile, currentState) {
    const next = { ...stateEffects };
    if (!schoolProfile) return next;

    if ((district.type === 'rest' || district.type === 'leisure' || district.type === 'wander') && schoolProfile.psychology >= 40) {
        next.stress -= schoolProfile.psychology >= 70 ? 4 : 2;
        next.mood += schoolProfile.psychology >= 70 ? 4 : 2;
        if ((currentState.stress || 0) >= 60 || (currentState.mood || 50) <= 40) {
            next.energy += schoolProfile.psychology >= 70 ? 3 : 1;
        }
    }

    if ((district.type === 'food' || district.type === 'shopping' || district.type === 'rest') && schoolProfile.lifeManagement >= 40) {
        next.stress -= 1;
        if (district.type === 'food') {
            next.stomach_load -= schoolProfile.lifeManagement >= 70 ? 3 : 1;
            next.sleep_debt -= schoolProfile.lifeManagement >= 70 ? 2 : 1;
        }
    }

    if ((district.type === 'leisure' || district.type === 'wander') && schoolProfile.social >= 40) {
        next.mood += schoolProfile.social >= 70 ? 3 : 1;
        next.social_need -= schoolProfile.social >= 70 ? 6 : 3;
    }

    return next;
}

function describeSchoolUnlock(courseId, tier) {
    if (!tier) return '';
    if (courseId === 'psychology') return tier === 'basic' ? ' 现在情绪起伏时，会开始先想办法让自己稳下来。' : ' 现在就算低落，也更会主动找回节奏和安抚自己。';
    if (courseId === 'vocational') return tier === 'basic' ? ' 现在做事开始更有章法，工作时没那么容易慌。' : ' 现在打工会更稳，也更容易给人靠谱的感觉。';
    if (courseId === 'social') return tier === 'basic' ? ' 现在在人群里开始更会拿捏距离感。' : ' 现在更会读空气，也更知道怎么把场面接住。';
    if (courseId === 'life_management') return tier === 'basic' ? ' 现在开始更会照顾自己的节奏，不容易把日子过乱。' : ' 现在会更自然地安排吃饭、休息和花钱，不容易把自己拖垮。';
    return '';
}

module.exports = {
    getCharacterSchoolProfile,
    getSchoolTier,
    buildCharacterSchoolSummary,
    buildSchoolPromptBlock,
    getSchoolActionEffects,
    applySchoolPerksToState,
    describeSchoolUnlock,
};
