function getEmotionByState(state = '') {
    switch (String(state || '').trim().toLowerCase()) {
        case 'jealous':
        case '吃醋':
            return { key: 'jealous', label: '吃醋', emoji: '😾', color: '#d81b60' };
        case 'hurt':
        case '委屈':
            return { key: 'hurt', label: '委屈', emoji: '🥺', color: '#fb8c00' };
        case 'angry':
        case '生气':
            return { key: 'angry', label: '生气', emoji: '😤', color: '#e53935' };
        case 'lonely':
        case '寂寞':
            return { key: 'lonely', label: '寂寞', emoji: '🫥', color: '#00897b' };
        case 'happy':
        case '开心':
            return { key: 'happy', label: '开心', emoji: '😄', color: '#43a047' };
        case 'sad':
        case '伤心':
            return { key: 'sad', label: '伤心', emoji: '😞', color: '#546e7a' };
        case 'cautious':
        case '谨慎':
            return { key: 'cautious', label: '谨慎', emoji: '🫣', color: '#6d4c41' };
        case 'guarded':
        case '防备':
            return { key: 'guarded', label: '防备', emoji: '🛡️', color: '#455a64' };
        case 'shy':
        case '害羞':
            return { key: 'shy', label: '害羞', emoji: '🙈', color: '#ec407a' };
        case 'hopeful':
        case '期待':
            return { key: 'hopeful', label: '期待', emoji: '🌤️', color: '#26a69a' };
        case 'playful':
        case '调皮':
            return { key: 'playful', label: '调皮', emoji: '😼', color: '#8e24aa' };
        case 'disappointed':
        case '失望':
            return { key: 'disappointed', label: '失望', emoji: '😒', color: '#757575' };
        case 'relieved':
        case '松一口气':
            return { key: 'relieved', label: '松一口气', emoji: '😮‍💨', color: '#26c6da' };
        case 'affectionate':
        case '依恋':
            return { key: 'affectionate', label: '依恋', emoji: '🥰', color: '#ef5350' };
        case 'reassured':
        case '安心':
            return { key: 'reassured', label: '安心', emoji: '🤍', color: '#42a5f5' };
        case 'yearning':
        case '想念':
            return { key: 'yearning', label: '想念', emoji: '💭', color: '#7e57c2' };
        case 'flustered':
        case '慌乱':
            return { key: 'flustered', label: '慌乱', emoji: '😵', color: '#ff7043' };
        case 'guilty':
        case '内疚':
            return { key: 'guilty', label: '内疚', emoji: '😔', color: '#8d6e63' };
        case 'frustrated':
        case '挫败':
            return { key: 'frustrated', label: '挫败', emoji: '😮‍💨', color: '#6d4c41' };
        case 'wistful':
        case '怅然':
            return { key: 'wistful', label: '怅然', emoji: '🌫️', color: '#78909c' };
        case 'proud':
        case '得意':
            return { key: 'proud', label: '得意', emoji: '😏', color: '#ab47bc' };
        case 'secure':
        case '笃定':
            return { key: 'secure', label: '笃定', emoji: '🪨', color: '#5c6bc0' };
        case 'tender':
        case '温柔':
            return { key: 'tender', label: '温柔', emoji: '🫶', color: '#f48fb1' };
        case 'helpless':
        case '无奈':
            return { key: 'helpless', label: '无奈', emoji: '😑', color: '#90a4ae' };
        case 'tense':
        case '烦躁':
            return { key: 'tense', label: '烦躁', emoji: '😣', color: '#f4511e' };
        case 'calm':
        case '平静':
            return { key: 'calm', label: '平静', emoji: '🙂', color: '#1e88e5' };
        default:
            return null;
    }
}

export function deriveEmotion(contact = {}) {
    if (contact.emotion_state && contact.emotion_label && contact.emotion_emoji) {
        return {
            key: contact.emotion_state,
            label: contact.emotion_label,
            emoji: contact.emotion_emoji,
            color: contact.emotion_color || '#1e88e5'
        };
    }

    const explicitEmotion = getEmotionByState(contact.explicit_emotion_state);
    if (explicitEmotion) return explicitEmotion;

    const mood = Number(contact.mood ?? 50);
    const stress = Number(contact.stress ?? 20);
    const socialNeed = Number(contact.social_need ?? 50);
    const pressure = Number(contact.pressure_level ?? 0);
    const jealousy = Number(contact.jealousy_level ?? 0);
    const replyPending = Number(contact.city_reply_pending ?? 0) > 0;
    const ignoreStreak = Number(contact.city_ignore_streak ?? 0);
    const jealousyTarget = String(contact.jealousy_target || '').trim();

    if (jealousy >= 60 && jealousyTarget) return { key: 'jealous', label: '吃醋', emoji: '😾', color: '#d81b60' };
    if (mood >= 70 && stress <= 40 && !(jealousy >= 45 && jealousyTarget)) return { key: 'happy', label: '开心', emoji: '😄', color: '#43a047' };
    if (pressure >= 2 || (replyPending && ignoreStreak >= 1)) return { key: 'hurt', label: '委屈', emoji: '🥺', color: '#fb8c00' };
    if (stress >= 68 && mood <= 45) return { key: 'angry', label: '生气', emoji: '😤', color: '#e53935' };
    if (socialNeed >= 78 && mood <= 48) return { key: 'lonely', label: '寂寞', emoji: '🫥', color: '#00897b' };
    if (mood <= 38) return { key: 'sad', label: '伤心', emoji: '😞', color: '#546e7a' };
    if (stress >= 55) return { key: 'tense', label: '烦躁', emoji: '😣', color: '#f4511e' };
    if (stress >= 45 && mood <= 62) return { key: 'cautious', label: '谨慎', emoji: '🫣', color: '#6d4c41' };
    return { key: 'calm', label: '平静', emoji: '🙂', color: '#1e88e5' };
}

export function derivePhysicalState(contact = {}) {
    if (contact.physical_state && contact.physical_label && contact.physical_emoji) {
        return {
            key: contact.physical_state,
            label: contact.physical_label,
            emoji: contact.physical_emoji,
            color: contact.physical_color || '#1e88e5'
        };
    }

    const sleepDebt = Number(contact.sleep_debt ?? 0);
    const health = Number(contact.health ?? 100);
    const satiety = Number(contact.satiety ?? 60);
    const stomachLoad = Number(contact.stomach_load ?? 0);
    const energy = Number(contact.energy ?? 70);
    const calories = Number(contact.calories ?? 3000);
    const cityStatus = String(contact.city_status || '').trim();

    if (cityStatus === 'coma' || health <= 25) return { key: 'severe_unwell', label: '明显不适', emoji: '🤒', color: '#8e24aa' };
    if (cityStatus === 'medical' || health <= 45) return { key: 'unwell', label: '不适', emoji: '🤒', color: '#8e24aa' };
    if (cityStatus === 'sleeping' || sleepDebt >= 72) return { key: 'sleepy', label: '困倦', emoji: '😪', color: '#3949ab' };
    if (cityStatus === 'hungry' || satiety <= 20 || calories <= 900) return { key: 'hungry', label: '饥饿', emoji: '🍽️', color: '#ef6c00' };
    if (stomachLoad >= 75) return { key: 'overfull', label: '胃负担重', emoji: '😵‍💫', color: '#6d4c41' };
    if (energy <= 25 || sleepDebt >= 55) return { key: 'fatigued', label: '疲惫', emoji: '😮‍💨', color: '#546e7a' };
    return { key: 'stable', label: '稳定', emoji: '🙂', color: '#1e88e5' };
}
