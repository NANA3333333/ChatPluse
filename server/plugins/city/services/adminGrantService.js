const {
    normalizeCityGoldAmount,
    normalizeCityCalories,
    normalizeCityItemQuantity
} = require('../utils/inputGuards');

function normalizeGrantDetails(grantKind, details = {}) {
    if (grantKind === 'gold') {
        const amount = normalizeCityGoldAmount(details.amount);
        if (!amount) throw new Error('无效的金币数量');
        return { amount };
    }
    if (grantKind === 'calories') {
        const amount = normalizeCityCalories(details.amount);
        if (!amount) throw new Error('无效的体力数量');
        return { amount };
    }
    if (grantKind === 'item') {
        const quantity = normalizeCityItemQuantity(details.quantity);
        if (!quantity) throw new Error('无效的物品数量');
        return {
            itemName: String(details.itemName || '').trim(),
            itemEmoji: String(details.itemEmoji || '').trim(),
            quantity
        };
    }
    throw new Error('未知的赠与类型');
}

function buildGrantReplyDirective(grantKind, details = {}, userName = '用户') {
    const normalized = normalizeGrantDetails(grantKind, details);
    const amount = normalized.amount || 0;
    const itemName = normalized.itemName || '';
    const itemEmoji = normalized.itemEmoji || '';
    const quantity = normalized.quantity || 0;

    const eventSummary = grantKind === 'gold'
        ? `${userName}刚刚给了你 ${amount} 金币。`
        : grantKind === 'calories'
            ? `${userName}刚刚给你补了 ${amount} 点体力/热量。`
            : `${userName}刚刚给了你 ${itemEmoji}${itemName} x${quantity}。`;

    return [
        '[系统提示：这是一次收到用户赠与后的回复。]',
        `最新事件：${eventSummary}`,
        '请先回应这次收到的东西本身。'
    ].join('\n');
}

function createAdminGrantService({ ensureCityDb, getUserDb, getEngine, getWsClients }) {
    async function triggerAdminGrantChat(userId, char, grantKind, details = {}) {
        if (!char?.id) return null;
        const db = ensureCityDb(getUserDb(userId));
        const engine = getEngine(userId);
        const wsClients = getWsClients(userId);
        if (!engine || typeof engine.triggerImmediateUserReply !== 'function') {
            throw new Error('私聊引擎不可用');
        }

        const normalized = normalizeGrantDetails(grantKind, details);
        const amount = normalized.amount || 0;
        const itemName = normalized.itemName || '';
        const itemEmoji = normalized.itemEmoji || '';
        const quantity = normalized.quantity || 0;
        const userName = String(db.getUserProfile()?.name || '用户').trim() || '用户';
        const noticeContent = grantKind === 'gold'
            ? `${userName}刚给了你 ${amount} 金币。`
            : grantKind === 'calories'
                ? `${userName}刚给你补了 ${amount} 点体力/热量。`
                : `${userName}刚给了你 ${itemEmoji}${itemName} x${quantity}。`;
        const extraSystemDirective = buildGrantReplyDirective(grantKind, details, userName);

        const { id: msgId, timestamp: msgTs } = db.addMessage(char.id, 'system', noticeContent);
        const newMessage = {
            id: msgId,
            character_id: char.id,
            role: 'system',
            content: noticeContent,
            timestamp: msgTs,
            read: 0
        };
        engine?.broadcastNewMessage?.(wsClients, newMessage);
        engine?.broadcastEvent?.(wsClients, { type: 'refresh_contacts' });
        await engine.triggerImmediateUserReply(char.id, wsClients, {
            propagateError: true,
            extraSystemDirective,
            triggerSource: 'city_admin_grant',
            triggerRoute: 'city.triggerAdminGrantChat',
            triggerNote: `grant_${grantKind}`
        });
        return newMessage;
    }

    return {
        triggerAdminGrantChat
    };
}

module.exports = {
    buildGrantReplyDirective,
    createAdminGrantService
};
