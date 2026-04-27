function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

function normalizeNumber(value, fallback) {
    const num = Number(value);
    return Number.isFinite(num) ? num : fallback;
}

function getLegacyEmotionBridge(character = {}) {
    const mood = normalizeNumber(character.mood, 50);
    const stress = normalizeNumber(character.stress, 20);
    const socialNeed = normalizeNumber(character.social_need, 50);
    const pressure = normalizeNumber(character.pressure_level, 0);
    const ignoreStreak = normalizeNumber(character.city_ignore_streak, 0);
    const replyPending = normalizeNumber(character.city_reply_pending, 0) > 0;

    return {
        mood: clamp(Math.round(mood - pressure * 6 - ignoreStreak * 3 - (replyPending ? 2 : 0)), 0, 100),
        stress: clamp(Math.round(stress + pressure * 10 + ignoreStreak * 4 + (replyPending ? 4 : 0)), 0, 100),
        socialNeed: clamp(Math.round(socialNeed + pressure * 8 + ignoreStreak * 5), 0, 100),
        pressure,
        ignoreStreak,
        replyPending
    };
}

function analyzeUserReplyTone(content = '') {
    const text = String(content || '').trim().toLowerCase();
    let score = 0;
    if (!text) return score;

    score += 1; // any actual reply eases neglect pressure a bit

    if (/(抱抱|亲亲|想你|在乎你|喜欢你|爱你|别委屈|别生气|不气|不委屈|乖|陪你|哄你|摸摸|安慰|对不起|抱歉|我在|回你了|没忘|一直在|么么|muah)/i.test(text)) {
        score += 2;
    }
    if (/[❤❤️💕💖💗💓💞🥺😚😙😘🥰🤗😊☺]/.test(text)) {
        score += 1;
    }
    if (text.length >= 12) {
        score += 1;
    }

    return score;
}

function analyzeUserReplyEmotionEffect(content = '') {
    const text = String(content || '').trim();
    const lower = text.toLowerCase();
    const result = {
        key: 'neutral',
        label: '中性回应',
        moodDelta: 0,
        stressDelta: 0,
        socialNeedDelta: 0
    };
    if (!text) return result;

    const positiveRegex = /(抱抱|亲亲|想你|在乎你|喜欢你|爱你|别委屈|别生气|不气|陪你|哄你|摸摸|安慰|对不起|抱歉|我在|回你了|没忘|一直在|辛苦了|乖|宝|宝宝|么么|亲爱的|别难过)/i;
    const explanationRegex = /(刚刚|刚才|在忙|有事|开会|工作|处理|耽误|晚点|晚了|没看到|现在回|不是故意|解释一下)/i;
    const negativeRegex = /(滚|烦|闭嘴|别吵|有病|神经|讨厌|懒得理|不想理你|别来烦我|关你屁事|少管|你懂什么|别烦|莫名其妙)/i;
    const coldRegex = /^(哦|噢|嗯|行吧|随便|知道了|好吧|？|。。。|\.\.\.)$/i;
    const mentionOtherRegex = /(他|她|别人|另一个|grok|claude|gemini|glm|gpt)/i;

    if (negativeRegex.test(text)) {
        return {
            key: 'negative',
            label: '负面回应',
            moodDelta: -8,
            stressDelta: 9,
            socialNeedDelta: 3
        };
    }

    if (positiveRegex.test(text)) {
        return {
            key: 'soothed',
            label: '安抚回应',
            moodDelta: 8,
            stressDelta: -7,
            socialNeedDelta: -6
        };
    }

    if (explanationRegex.test(text)) {
        return {
            key: 'explained',
            label: '解释回应',
            moodDelta: 4,
            stressDelta: -5,
            socialNeedDelta: -3
        };
    }

    if (coldRegex.test(text) || text.length <= 3) {
        return {
            key: 'cold',
            label: '冷淡回应',
            moodDelta: -2,
            stressDelta: 3,
            socialNeedDelta: 1
        };
    }

    if (mentionOtherRegex.test(lower) && !positiveRegex.test(text)) {
        return {
            key: 'distracted',
            label: '转移注意',
            moodDelta: -1,
            stressDelta: 2,
            socialNeedDelta: 1
        };
    }

    if (text.length >= 12) {
        return {
            key: 'engaged',
            label: '认真回应',
            moodDelta: 3,
            stressDelta: -2,
            socialNeedDelta: -2
        };
    }

    return result;
}

function getUserReplyReliefPatch(character = {}, content = '') {
    const pressure = normalizeNumber(character.pressure_level, 0);
    const jealousy = normalizeNumber(character.jealousy_level, 0);
    if (pressure <= 0 && jealousy <= 0) return null;

    const toneScore = analyzeUserReplyTone(content);
    const pressureDrop = Math.min(pressure, Math.max(1, toneScore));
    const jealousyDrop = toneScore >= 3 ? 20 : 0;
    const patch = {};

    if (pressure > 0) {
        patch.pressure_level = Math.max(0, pressure - pressureDrop);
    }
    if (jealousy > 0 && jealousyDrop > 0) {
        const nextJealousy = Math.max(0, jealousy - jealousyDrop);
        patch.jealousy_level = nextJealousy;
        if (nextJealousy === 0) {
            patch.jealousy_target = '';
        }
    }

    return Object.keys(patch).length > 0 ? patch : null;
}

function getUserReplyEmotionPatch(character = {}, content = '', options = {}) {
    const mood = normalizeNumber(character.mood, 50);
    const stress = normalizeNumber(character.stress, 20);
    const socialNeed = normalizeNumber(character.social_need, 50);
    const pressure = normalizeNumber(character.pressure_level, 0);
    const waitMinutes = Math.max(0, normalizeNumber(options.waitMinutes, 0));
    const effect = analyzeUserReplyEmotionEffect(content);

    let moodDelta = 1;
    let stressDelta = -1;
    let socialNeedDelta = -1;

    moodDelta += effect.moodDelta;
    stressDelta += effect.stressDelta;
    socialNeedDelta += effect.socialNeedDelta;

    if (waitMinutes >= 30) {
        stressDelta -= 1;
    }
    if (waitMinutes >= 180) {
        stressDelta -= 1;
        moodDelta += 1;
    }
    if (pressure >= 2 && ['soothed', 'explained', 'engaged'].includes(effect.key)) {
        moodDelta += 2;
        stressDelta -= 2;
    }

    return {
        patch: {
            mood: clamp(Math.round(mood + moodDelta), 0, 100),
            stress: clamp(Math.round(stress + stressDelta), 0, 100),
            social_need: clamp(Math.round(socialNeed + socialNeedDelta), 0, 100)
        },
        effect
    };
}

function buildEmotionLogEntry(before = {}, after = {}, source, reason = '') {
    const beforeEmotion = deriveEmotion(before);
    const afterEmotion = deriveEmotion(after);
    const fieldsChanged =
        String(before.explicit_emotion_state || '') !== String(after.explicit_emotion_state || '') ||
        (before.mood ?? null) !== (after.mood ?? null) ||
        (before.stress ?? null) !== (after.stress ?? null) ||
        (before.social_need ?? null) !== (after.social_need ?? null) ||
        (before.pressure_level ?? null) !== (after.pressure_level ?? null) ||
        (before.jealousy_level ?? null) !== (after.jealousy_level ?? null) ||
        beforeEmotion.state !== afterEmotion.state;

    if (!fieldsChanged || !after.id) return null;

    return {
        character_id: after.id,
        source,
        reason,
        old_state: beforeEmotion.state,
        new_state: afterEmotion.state,
        old_mood: before.mood ?? null,
        new_mood: after.mood ?? null,
        old_stress: before.stress ?? null,
        new_stress: after.stress ?? null,
        old_social_need: before.social_need ?? null,
        new_social_need: after.social_need ?? null,
        old_pressure: before.pressure_level ?? null,
        new_pressure: after.pressure_level ?? null,
        old_jealousy: before.jealousy_level ?? null,
        new_jealousy: after.jealousy_level ?? null
    };
}

function getEmotionByState(requestedState = '') {
    const normalizedState = String(requestedState || '').trim().toLowerCase();
    switch (normalizedState) {
        case 'jealous':
        case '吃醋':
            return { state: 'jealous', label: '吃醋', emoji: '😾', color: '#d81b60' };
        case 'hurt':
        case '委屈':
            return { state: 'hurt', label: '委屈', emoji: '🥺', color: '#fb8c00' };
        case 'angry':
        case '生气':
            return { state: 'angry', label: '生气', emoji: '😤', color: '#e53935' };
        case 'lonely':
        case '寂寞':
            return { state: 'lonely', label: '寂寞', emoji: '🫥', color: '#00897b' };
        case 'happy':
        case '开心':
            return { state: 'happy', label: '开心', emoji: '😄', color: '#43a047' };
        case 'sad':
        case '伤心':
            return { state: 'sad', label: '伤心', emoji: '😞', color: '#546e7a' };
        case 'cautious':
        case '谨慎':
            return { state: 'cautious', label: '谨慎', emoji: '🫣', color: '#6d4c41' };
        case 'guarded':
        case '防备':
            return { state: 'guarded', label: '防备', emoji: '🛡️', color: '#455a64' };
        case 'shy':
        case '害羞':
            return { state: 'shy', label: '害羞', emoji: '🙈', color: '#ec407a' };
        case 'hopeful':
        case '期待':
            return { state: 'hopeful', label: '期待', emoji: '🌤️', color: '#26a69a' };
        case 'playful':
        case '调皮':
            return { state: 'playful', label: '调皮', emoji: '😼', color: '#8e24aa' };
        case 'disappointed':
        case '失望':
            return { state: 'disappointed', label: '失望', emoji: '😒', color: '#757575' };
        case 'relieved':
        case '松一口气':
            return { state: 'relieved', label: '松一口气', emoji: '😮‍💨', color: '#26c6da' };
        case 'affectionate':
        case '依恋':
            return { state: 'affectionate', label: '依恋', emoji: '🥰', color: '#ef5350' };
        case 'reassured':
        case '安心':
            return { state: 'reassured', label: '安心', emoji: '🤍', color: '#42a5f5' };
        case 'yearning':
        case '想念':
            return { state: 'yearning', label: '想念', emoji: '💭', color: '#7e57c2' };
        case 'flustered':
        case '慌乱':
            return { state: 'flustered', label: '慌乱', emoji: '😵', color: '#ff7043' };
        case 'guilty':
        case '内疚':
            return { state: 'guilty', label: '内疚', emoji: '😔', color: '#8d6e63' };
        case 'frustrated':
        case '挫败':
            return { state: 'frustrated', label: '挫败', emoji: '😮‍💨', color: '#6d4c41' };
        case 'wistful':
        case '怅然':
            return { state: 'wistful', label: '怅然', emoji: '🌫️', color: '#78909c' };
        case 'proud':
        case '得意':
            return { state: 'proud', label: '得意', emoji: '😏', color: '#ab47bc' };
        case 'secure':
        case '笃定':
            return { state: 'secure', label: '笃定', emoji: '🪨', color: '#5c6bc0' };
        case 'tender':
        case '温柔':
            return { state: 'tender', label: '温柔', emoji: '🫶', color: '#f48fb1' };
        case 'helpless':
        case '无奈':
            return { state: 'helpless', label: '无奈', emoji: '😑', color: '#90a4ae' };
        case 'tense':
        case '烦躁':
            return { state: 'tense', label: '烦躁', emoji: '😣', color: '#f4511e' };
        case 'calm':
        case '平静':
            return { state: 'calm', label: '平静', emoji: '🙂', color: '#1e88e5' };
        default:
            return null;
    }
}

function getExplicitEmotionStatePatch(character = {}, requestedState = '') {
    const emotion = getEmotionByState(requestedState);
    if (!emotion) return null;
    return { explicit_emotion_state: emotion.state };
}

function deriveEmotion(character = {}) {
    const explicitEmotion = getEmotionByState(character.explicit_emotion_state);
    if (explicitEmotion) return explicitEmotion;

    const bridged = getLegacyEmotionBridge(character);
    const mood = bridged.mood;
    const stress = bridged.stress;
    const socialNeed = bridged.socialNeed;
    const pressure = bridged.pressure;
    const jealousy = normalizeNumber(character.jealousy_level, 0);
    const replyPending = bridged.replyPending;
    const ignoreStreak = bridged.ignoreStreak;
    const jealousyTarget = String(character.jealousy_target || '').trim();

    if (jealousy >= 60 && jealousyTarget) return { state: 'jealous', label: '吃醋', emoji: '😾', color: '#d81b60' };
    if (mood >= 70 && stress <= 40 && !(jealousy >= 45 && jealousyTarget)) return { state: 'happy', label: '开心', emoji: '😄', color: '#43a047' };
    if ((pressure >= 2 || (replyPending && ignoreStreak >= 1)) && !(mood >= 78 && stress <= 25)) return { state: 'hurt', label: '委屈', emoji: '🥺', color: '#fb8c00' };
    if (stress >= 68 && mood <= 45) return { state: 'angry', label: '生气', emoji: '😤', color: '#e53935' };
    if (socialNeed >= 70 && mood <= 55) return { state: 'lonely', label: '寂寞', emoji: '🫥', color: '#00897b' };
    if (mood <= 38) return { state: 'sad', label: '伤心', emoji: '😞', color: '#546e7a' };
    if (stress >= 55) return { state: 'tense', label: '烦躁', emoji: '😣', color: '#f4511e' };
    return { state: 'calm', label: '平静', emoji: '🙂', color: '#1e88e5' };
}

function derivePhysicalState(character = {}) {
    const sleepDebt = normalizeNumber(character.sleep_debt, 0);
    const health = normalizeNumber(character.health, 100);
    const satiety = normalizeNumber(character.satiety, 60);
    const stomachLoad = normalizeNumber(character.stomach_load, 0);
    const energy = normalizeNumber(character.energy, 70);
    const calories = normalizeNumber(character.calories, 3000);
    const cityStatus = String(character.city_status || '').trim();

    if (cityStatus === 'coma' || health <= 25) return { state: 'severe_unwell', label: '明显不适', emoji: '🤒', color: '#8e24aa' };
    if (cityStatus === 'medical' || health <= 45) return { state: 'unwell', label: '不适', emoji: '🤒', color: '#8e24aa' };
    if (cityStatus === 'sleeping' || sleepDebt >= 72) return { state: 'sleepy', label: '困倦', emoji: '😪', color: '#3949ab' };
    if (cityStatus === 'hungry' || satiety <= 20 || calories <= 900) return { state: 'hungry', label: '饥饿', emoji: '🍽️', color: '#ef6c00' };
    if (stomachLoad >= 75) return { state: 'overfull', label: '胃负担重', emoji: '😵‍💫', color: '#6d4c41' };
    if (energy <= 25 || sleepDebt >= 55) return { state: 'fatigued', label: '疲惫', emoji: '😮‍💨', color: '#546e7a' };
    return { state: 'stable', label: '稳定', emoji: '🙂', color: '#1e88e5' };
}

function getEmotionFeelingText(state) {
    switch (state) {
        case 'angry':
            return '胸口、喉咙和颈肩区域有紧绷感，心率略快，呼吸变浅，手指或下颌容易不自觉用力。注意力更容易被冒犯、打断、不公平感吸引。';
        case 'hurt':
            return '喉咙发紧，胸口有压迫感，眼眶可能发酸，身体有轻微收缩感。注意力容易反复回到“是不是被忽视、是不是不被在意”上。';
        case 'happy':
            return '胸口和面部更放松，呼吸轻快，身体活动意愿上升。注意力更容易落在积极细节和想分享的内容上。';
        case 'lonely':
            return '胸口有空落感，身体容易停在等待和张望的状态里。注意力更容易被回应、陪伴、有没有人看见自己牵引。';
        case 'jealous':
            return '胸口发闷，胃部或喉咙有堵塞感，身体处在轻微警觉里。注意力反复回到比较、替代感和对方注意力去了哪里。';
        case 'sad':
            return '胸口沉，肩背容易下坠，呼吸幅度变小，身体活动意愿下降。注意力更容易停在失落和无力感上。';
        case 'cautious':
            return '身体保持轻微戒备，呼吸和动作都更克制，注意力会先扫风险和边界，再决定要不要靠近或表态。';
        case 'guarded':
            return '肩颈和表情都会更收，身体像先把门掩上一半。注意力优先盯着对方会不会越界、会不会让自己吃亏。';
        case 'shy':
            return '脸和胸口有发热感，动作会变得轻一点、慢一点，注意力既想靠近又怕被看得太清楚。';
        case 'hopeful':
            return '胸口是微微提起的，呼吸会更轻快一些，注意力停在“也许会变好”“也许对方会给回应”这种可能性上。';
        case 'playful':
            return '身体是松的，嘴角和语气都更容易带钩子。注意力更多放在逗弄、试探反应和制造互动感上。';
        case 'disappointed':
            return '胸口往下沉，表情和动作会收掉一点，注意力停在“原来不是我想的那样”以及落空感上。';
        case 'relieved':
            return '肩背会松下来，呼吸变长，身体从绷着的状态退开一点。注意力从风险转回到“终于不用再防着了”。';
        case 'affectionate':
            return '胸口是软的，靠近和触碰的意愿上升，注意力自然落在亲近、照顾和回应对方的小动作上。';
        case 'reassured':
            return '身体慢慢松下来，原本悬着的那口气落回去了。注意力不再反复确认风险，而是开始相信眼前这件事是稳的。';
        case 'yearning':
            return '胸口像被轻轻往远处牵着，注意力总会回到那个人、那段互动，或者还没说出口的话上。';
        case 'flustered':
            return '呼吸和思路都会乱一下，动作容易快半拍，注意力在“怎么会这样”“现在该怎么接”之间来回跳。';
        case 'guilty':
            return '胸口有一点往里缩，视线和动作都会收一点，注意力更容易停在“是不是让对方难受了”“要不要补偿”上。';
        case 'frustrated':
            return '身体里有一种使不上力的闷感，想推进但推不动。注意力会卡在阻碍、误解和没法顺利达成的地方。';
        case 'wistful':
            return '情绪像一层薄雾铺开，不是很尖锐，但一直在。注意力会被旧片段、错过的可能性和说不清的遗憾牵走。';
        case 'proud':
            return '下巴和视线都会微微抬一点，身体更愿意展示自己。注意力放在“我做到了”“你应该看见我这一面”上。';
        case 'secure':
            return '身体是稳的，不急着抢答或确认。注意力更多放在怎么把事情说清、把边界站稳，而不是担心被带跑。';
        case 'tender':
            return '动作和语气都会轻下来，身体更愿意靠近也更怕弄疼对方。注意力自然落在照顾、安抚和细小回应上。';
        case 'helpless':
            return '身体不会很炸，但会有一种拿这件事没办法的松垮感。注意力停在“我知道问题在哪，可一时也改不了”上。';
        case 'tense':
            return '心率上升，呼吸变浅，肩颈和胃部发紧，身体维持在过度警觉里。注意力集中但容易被小刺激打断。';
        default:
            return '呼吸和肌肉张力相对平稳，情绪没有明显推高或压低。注意力主要按当前对话和现实处境自然流动。';
    }
}

function getPhysicalFeelingText(state) {
    switch (state) {
        case 'severe_unwell':
            return '身体发虚，意识和注意力容易断续，头部或四肢有沉重感。维持清晰思考会明显费力。';
        case 'unwell':
            return '身体局部有钝痛、压迫、发冷或发热感，注意力容易被身体信号打断。耐受力和恢复速度下降。';
        case 'sleepy':
            return '眼睑沉重，视线容易发散，注意力维持困难，反应速度下降，头部有轻微钝胀或迟滞感。';
        case 'hungry':
            return '胃部有空腹感或收缩感，身体能量供应不足时可能出现轻微心慌、烦躁和注意力不稳。';
        case 'overfull':
            return '胃部胀满，身体更多资源被消化牵引，动作意愿下降，思考速度可能变慢。';
        case 'fatigued':
            return '四肢有沉重感，肌肉力量下降，动作意愿降低，持续思考会更快消耗精力。';
        default:
            return '呼吸平稳，肌肉负担较轻，注意力和动作反应维持在正常水平。';
    }
}

function getEmotionFeelingGuidance(character = {}) {
    const emotion = deriveEmotion(character);
    return {
        emotion,
        feeling: getEmotionFeelingText(emotion.state)
    };
}

function getPhysicalFeelingGuidance(character = {}) {
    const physical = derivePhysicalState(character);
    return {
        physical,
        feeling: getPhysicalFeelingText(physical.state)
    };
}

function getEmotionBehaviorGuidance(character = {}) {
    const { emotion, feeling } = getEmotionFeelingGuidance(character);
    switch (emotion.state) {
        case 'angry':
            return {
                emotion,
                privateChat: feeling,
                groupChat: feeling,
                cityAction: feeling
            };
        case 'hurt':
            return {
                emotion,
                privateChat: feeling,
                groupChat: feeling,
                cityAction: feeling
            };
        case 'happy':
            return {
                emotion,
                privateChat: feeling,
                groupChat: feeling,
                cityAction: feeling
            };
        case 'lonely':
            return {
                emotion,
                privateChat: feeling,
                groupChat: feeling,
                cityAction: feeling
            };
        case 'jealous':
            return {
                emotion,
                privateChat: feeling,
                groupChat: feeling,
                cityAction: feeling
            };
        case 'sad':
            return {
                emotion,
                privateChat: feeling,
                groupChat: feeling,
                cityAction: feeling
            };
        case 'tense':
            return {
                emotion,
                privateChat: feeling,
                groupChat: feeling,
                cityAction: feeling
            };
        default:
            return {
                emotion,
                privateChat: feeling,
                groupChat: feeling,
                cityAction: feeling
            };
    }
}

function applyEmotionEvent(character = {}, eventType, options = {}) {
    const mood = normalizeNumber(character.mood, 50);
    const stress = normalizeNumber(character.stress, 20);
    const socialNeed = normalizeNumber(character.social_need, 50);
    const pressure = normalizeNumber(character.pressure_level, 0);
    const waitMinutes = Math.max(0, normalizeNumber(options.waitMinutes, 0));

    let moodDelta = 0;
    let stressDelta = 0;
    let socialNeedDelta = 0;

    switch (eventType) {
        case 'private_user_message_received': {
            moodDelta += 1;
            stressDelta -= 1;
            socialNeedDelta -= 1;
            break;
        }
        case 'private_character_reply_sent': {
            moodDelta += 3;
            stressDelta -= 4;
            socialNeedDelta -= 5;
            break;
        }
        case 'group_user_message_received': {
            moodDelta += 2;
            stressDelta -= 1;
            socialNeedDelta -= 3;
            if (options.isMentioned) {
                moodDelta += 5;
                stressDelta -= 2;
                socialNeedDelta -= 8;
            } else if (options.isAtAll) {
                moodDelta += 3;
                socialNeedDelta -= 5;
            }
            break;
        }
        case 'group_character_message_sent': {
            moodDelta += 3;
            stressDelta -= 2;
            socialNeedDelta -= 4;
            break;
        }
        case 'city_social_event': {
            moodDelta += 5;
            stressDelta -= 3;
            socialNeedDelta -= 7;
            break;
        }
        default:
            return null;
    }

    return {
        mood: clamp(Math.round(mood + moodDelta), 0, 100),
        stress: clamp(Math.round(stress + stressDelta), 0, 100),
        social_need: clamp(Math.round(socialNeed + socialNeedDelta), 0, 100)
    };
}

module.exports = {
    deriveEmotion,
    derivePhysicalState,
    applyEmotionEvent,
    getEmotionBehaviorGuidance,
    getEmotionFeelingGuidance,
    getPhysicalFeelingGuidance,
    getUserReplyEmotionPatch,
    getUserReplyReliefPatch,
    buildEmotionLogEntry,
    getExplicitEmotionStatePatch
};
