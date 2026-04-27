import React, { useState, useEffect, useCallback } from 'react';
import { Plus, Trash2, ToggleLeft, ToggleRight, Save, DollarSign, Heart, Edit3, X, Power, Package, ShoppingBag, AlertTriangle } from 'lucide-react';
import { resolveAvatarUrl } from '../../utils/avatar';
import { deriveEmotion, derivePhysicalState } from '../../utils/emotion';
import SchoolGrowthPanel from '../cityGrowth/SchoolGrowthPanel';

const FALLBACK_AVATAR = 'https://api.dicebear.com/7.x/shapes/svg?seed=User';
const avatarSrc = (url, apiUrl) => resolveAvatarUrl(url, apiUrl) || FALLBACK_AVATAR;

const sectionStyle = {
    backgroundColor: '#fff', borderRadius: '12px', boxShadow: '0 2px 10px rgba(0,0,0,0.05)',
    overflow: 'hidden', marginBottom: '16px'
};
const headerStyle = {
    padding: '12px 18px', borderBottom: '1px solid #eee',
    background: 'linear-gradient(to right, #f8f9fa, #fff)', display: 'flex',
    justifyContent: 'space-between', alignItems: 'center'
};
const btnStyle = (color = '#ff9800') => ({
    padding: '6px 14px', border: 'none', borderRadius: '6px',
    backgroundColor: color, color: '#fff', cursor: 'pointer', fontSize: '13px',
    display: 'flex', alignItems: 'center', gap: '4px', fontWeight: '500'
});
const inputStyle = {
    width: '100%', padding: '8px 10px', border: '1px solid #ddd', borderRadius: '6px',
    fontSize: '13px', boxSizing: 'border-box'
};
const labelStyle = { fontSize: '12px', color: '#666', marginBottom: '4px', display: 'block', fontWeight: '500' };

const stateColor = (value, inverted = false) => {
    const normalized = Number(value ?? 0);
    if (inverted) {
        if (normalized <= 30) return '#2e7d32';
        if (normalized <= 60) return '#ef6c00';
        return '#c62828';
    }
    if (normalized >= 70) return '#2e7d32';
    if (normalized >= 40) return '#ef6c00';
    return '#c62828';
};

const CONFIG_LABELS = {
    dlc_enabled: 'DLC 总开关',
    city_actions_paused: '暂停生理流逝',
    metabolism_rate: '基础代谢 (每 tick)',
    inflation: '通货膨胀倍率',
    work_bonus: '打工奖金倍率',
    gambling_win_rate: '赌博胜率',
    gambling_payout: '赌博赔率',
    city_self_log_limit: '记忆获取条数 (自己的经历)',
    city_social_log_limit: '社交获取条数 (他人的经历)',
    city_announcement_limit: '公告获取条数',
    city_stranger_meet_prob: '陌生人相遇概率 (%)',
    city_chat_probability: '私聊消息概率',
    city_moment_probability: '发朋友圈概率',
    city_diary_probability: '写日记概率',
};
const HIDDEN_CONFIG_KEYS = ['dlc_enabled', 'mayor_prompt', 'mayor_enabled', 'mayor_interval_hours', 'mayor_model_char_id', 'mayor_last_run_at', 'mayor_custom_endpoint', 'mayor_custom_key', 'mayor_custom_model', 'city_chat_probability', 'city_moment_probability', 'city_diary_probability', 'city_self_log_limit', 'city_social_log_limit', 'city_announcement_limit', 'city_stranger_meet_prob', 'tick_label', 'tick_interval_minutes'];

const EMPTY_DISTRICT = {
    id: '', name: '', emoji: '🏬', type: 'generic', description: '',
    action_label: '前往', cal_cost: 0, cal_reward: 0, money_cost: 0,
    money_reward: 0, duration_ticks: 1, capacity: 0, is_enabled: 1, sort_order: 0
};

const DISTRICT_TEMPLATES = [
    { key: 'work_factory', label: '工厂打工', hint: '消耗体力，稳定赚钱', patch: { type: 'work', action_label: '去上班', cal_cost: 220, cal_reward: 0, money_cost: 0, money_reward: 90, duration_ticks: 2, description: '适合上班、搬运、流水线、兼职。' } },
    { key: 'work_office', label: '办公室工作', hint: '中等体力，稳定赚钱', patch: { type: 'work', action_label: '去工作', cal_cost: 140, cal_reward: 0, money_cost: 0, money_reward: 75, duration_ticks: 2, description: '适合文职、脑力劳动、稳定上班。' } },
    { key: 'meal_restaurant', label: '餐馆吃饭', hint: '花钱吃正餐，明显恢复体力', patch: { type: 'food', action_label: '去吃饭', cal_cost: 0, cal_reward: 900, money_cost: 30, money_reward: 0, duration_ticks: 1, description: '适合点正餐、堂食、吃饱恢复。' } },
    { key: 'fast_food', label: '便利店速食', hint: '先花钱买，之后再吃', patch: { type: 'shopping', action_label: '去买吃的', cal_cost: 20, cal_reward: 0, money_cost: 12, money_reward: 0, duration_ticks: 1, description: '适合买便当、泡面、零食，通常是囤进背包。' } },
    { key: 'rest_home', label: '在家休息', hint: '低成本恢复体力', patch: { type: 'rest', action_label: '回去休息', cal_cost: 0, cal_reward: 600, money_cost: 0, money_reward: 0, duration_ticks: 2, description: '适合睡觉、躺平、宅家恢复。' } },
    { key: 'park_walk', label: '公园散步', hint: '轻度恢复，放松心情', patch: { type: 'rest', action_label: '去散步', cal_cost: 20, cal_reward: 180, money_cost: 0, money_reward: 0, duration_ticks: 1, description: '适合散步、晒太阳、吹风发呆。' } },
    { key: 'mall_shopping', label: '逛街消费', hint: '花钱娱乐或买东西', patch: { type: 'shopping', action_label: '去逛街', cal_cost: 40, cal_reward: 40, money_cost: 50, money_reward: 0, duration_ticks: 1, description: '适合逛商场、买衣服、看柜台、随手消费。' } },
    { key: 'amusement_park', label: '游乐场娱乐', hint: '花钱娱乐，消磨时间', patch: { type: 'leisure', action_label: '去玩', cal_cost: 90, cal_reward: 80, money_cost: 70, money_reward: 0, duration_ticks: 2, description: '适合游乐场、电玩城、主题乐园、娱乐设施。' } },
    { key: 'date_entertainment', label: '约会娱乐', hint: '花钱社交，偏体验', patch: { type: 'leisure', action_label: '去约会', cal_cost: 70, cal_reward: 120, money_cost: 60, money_reward: 0, duration_ticks: 2, description: '适合约会、看电影、喝咖啡、双人娱乐。' } },
    { key: 'night_life', label: '夜生活', hint: '高消费，高情绪波动', patch: { type: 'leisure', action_label: '去玩夜场', cal_cost: 120, cal_reward: 60, money_cost: 90, money_reward: 0, duration_ticks: 2, description: '适合酒吧、Livehouse、夜店、深夜聚会。' } },
    { key: 'study_class', label: '学习培训', hint: '花钱花时间，偏成长', patch: { type: 'education', action_label: '去上课', cal_cost: 110, cal_reward: 0, money_cost: 45, money_reward: 0, duration_ticks: 2, description: '适合补习班、技能培训、课程学习。' } },
    { key: 'hospital', label: '医院治疗', hint: '花钱救急，恢复明显', patch: { type: 'medical', action_label: '去看病', cal_cost: 0, cal_reward: 1200, money_cost: 120, money_reward: 0, duration_ticks: 1, description: '适合生病、受伤、濒危时的治疗和抢救。' } },
    { key: 'casino', label: '赌博碰运气', hint: '高风险高波动', patch: { type: 'gambling', action_label: '去赌一把', cal_cost: 50, cal_reward: 0, money_cost: 40, money_reward: 0, duration_ticks: 1, description: '适合赌场、麻将馆、投机性娱乐。' } },
    { key: 'wander', label: '闲逛发呆', hint: '低风险自由活动', patch: { type: 'wander', action_label: '去逛逛', cal_cost: 30, cal_reward: 20, money_cost: 0, money_reward: 0, duration_ticks: 1, description: '适合压马路、晃悠、随便看看。' } },
    { key: 'generic', label: '自定义通用', hint: '自己细调数值', patch: { type: 'generic', action_label: '前往', cal_cost: 0, cal_reward: 0, money_cost: 0, money_reward: 0, duration_ticks: 1, description: '适合还没想好，之后手动调整。' } }
];

const getDistrictTemplateKey = (district) => {
    const type = district?.type || 'generic';
    const action = district?.action_label || '';
    if (type === 'work' && /上班/.test(action)) return 'work_factory';
    if (type === 'work') return 'work_office';
    if (type === 'food') return 'meal_restaurant';
    if (type === 'shopping' && (district?.money_cost || 0) <= 20) return 'fast_food';
    if (type === 'shopping') return 'mall_shopping';
    if (type === 'rest' && (district?.money_cost || 0) === 0 && (district?.cal_reward || 0) >= 400) return 'rest_home';
    if (type === 'rest') return 'park_walk';
    if (type === 'education') return 'study_class';
    if (type === 'medical') return 'hospital';
    if (type === 'gambling') return 'casino';
    if (type === 'leisure' && /夜/.test(action)) return 'night_life';
    if (type === 'leisure' && /约会/.test(action)) return 'date_entertainment';
    if (type === 'leisure') return 'amusement_park';
    if (type === 'wander') return 'wander';
    return 'generic';
};

const EMPTY_ITEM = {
    id: '', name: '', emoji: '🍱', category: 'food', description: '',
    buy_price: 10, sell_price: 0, cal_restore: 0, effect: '', sold_at: '', is_available: 1, sort_order: 0, stock: -1
};

const ITEM_TEMPLATES = [
    { key: 'instant_food', label: '速食', hint: '便宜，适合囤进背包', patch: { category: 'food', emoji: '🍜', buy_price: 12, cal_restore: 350, effect: '', description: '适合泡面、便当、零食，通常买回去再吃。' } },
    { key: 'full_meal', label: '正餐', hint: '更贵，恢复更多体力', patch: { category: 'food', emoji: '🍱', buy_price: 28, cal_restore: 800, effect: '', description: '适合套餐、盖饭、热食正餐。' } },
    { key: 'drink', label: '饮料', hint: '小额消费，轻微恢复', patch: { category: 'food', emoji: '🧃', buy_price: 8, cal_restore: 120, effect: '', description: '适合买来解渴、提神、小恢复。' } },
    { key: 'medicine', label: '药品', hint: '恢复类或特殊用途', patch: { category: 'medicine', emoji: '💊', buy_price: 35, cal_restore: 200, effect: 'recover', description: '适合药片、退烧药、医疗用品。' } },
    { key: 'tool', label: '工具', hint: '偏功能，不恢复体力', patch: { category: 'tool', emoji: '🧰', buy_price: 45, cal_restore: 0, effect: 'utility', description: '适合工作工具、钥匙、电子设备、零件。' } },
    { key: 'gift', label: '礼物', hint: '社交向物品', patch: { category: 'gift', emoji: '🎁', buy_price: 66, cal_restore: 0, effect: 'affinity+5', description: '适合买来送人，增加关系或表达心意。' } },
    { key: 'luxury', label: '奢侈品', hint: '高消费，高情绪价值', patch: { category: 'gift', emoji: '💎', buy_price: 188, cal_restore: 0, effect: 'affinity+10', description: '适合昂贵礼物、饰品、品牌消费。' } },
    { key: 'quest_item', label: '任务物品', hint: '剧情或任务用途', patch: { category: 'misc', emoji: '🗝️', buy_price: 0, cal_restore: 0, effect: 'quest', description: '适合任务道具、线索、钥匙、材料。' } },
    { key: 'custom', label: '自定义', hint: '后面自己细调', patch: { category: 'misc', emoji: '📦', buy_price: 10, cal_restore: 0, effect: '', description: '适合暂时没有对应模板的物品。' } }
];

const getItemTemplateKey = (item) => {
    const category = item?.category || 'misc';
    const effect = item?.effect || '';
    const price = Number(item?.buy_price || 0);
    const restore = Number(item?.cal_restore || 0);
    if (category === 'food' && restore >= 600) return 'full_meal';
    if (category === 'food' && restore > 0 && restore <= 180 && price <= 12) return 'drink';
    if (category === 'food' && price <= 15 && restore <= 400) return 'instant_food';
    if (category === 'food' && restore > 0) return 'drink';
    if (category === 'medicine') return 'medicine';
    if (category === 'tool') return 'tool';
    if (category === 'gift' && /10/.test(effect)) return 'luxury';
    if (category === 'gift') return 'gift';
    if (category === 'misc' && /quest/i.test(effect)) return 'quest_item';
    return 'custom';
};

export default function CityManager({ apiUrl, onRefreshLogs }) {
    const [districts, setDistricts] = useState([]);
    const [characters, setCharacters] = useState([]);
    const [config, setConfig] = useState({});
    const [economy, setEconomy] = useState(null);
    const [items, setItems] = useState([]);
    const [editing, setEditing] = useState(null);
    const [editingItem, setEditingItem] = useState(null);
    const [giveItemTarget, setGiveItemTarget] = useState(null); // { charId, charName }
    const [actionNotice, setActionNotice] = useState(null);
    const [viewInventory, setViewInventory] = useState(null); // { charName, inventory: [] }
    const [loading, setLoading] = useState(true);
    const [mayorRunning, setMayorRunning] = useState(false);
    const [mayorResult, setMayorResult] = useState(null);
    const [mayorPromptLocal, setMayorPromptLocal] = useState('');
    const [mayorModelMode, setMayorModelMode] = useState('auto'); // 'auto' | charId | 'custom'
    const [customEndpoint, setCustomEndpoint] = useState('');
    const [customKey, setCustomKey] = useState('');
    const [customModel, setCustomModel] = useState('');
    const [events, setEvents] = useState([]);
    const [quests, setQuests] = useState([]);
    const [previewTimeSkipMinutes, setPreviewTimeSkipMinutes] = useState(0);
    const [isSkippingTime, setIsSkippingTime] = useState(false);
    const refreshTimerRef = React.useRef(null);
    const actionNoticeTimerRef = React.useRef(null);
    const token = localStorage.getItem('token');
    const headers = { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' };

    const showActionNotice = useCallback((kind, message) => {
        setActionNotice({ kind, message });
        if (actionNoticeTimerRef.current) {
            clearTimeout(actionNoticeTimerRef.current);
        }
        actionNoticeTimerRef.current = setTimeout(() => {
            actionNoticeTimerRef.current = null;
            setActionNotice(null);
        }, 3500);
    }, []);

    const fetchAll = useCallback(async () => {
        try {
            const [dRes, cRes, cfgRes, ecoRes, itRes, evRes, qRes] = await Promise.all([
                fetch(`${apiUrl}/city/districts`, { headers }),
                fetch(`${apiUrl}/city/characters`, { headers }),
                fetch(`${apiUrl}/city/config`, { headers }),
                fetch(`${apiUrl}/city/economy`, { headers }),
                fetch(`${apiUrl}/city/items`, { headers }),
                fetch(`${apiUrl}/city/events`, { headers }),
                fetch(`${apiUrl}/city/quests`, { headers })
            ]);
            const [dData, cData, cfgData, ecoData, itData, evData, qData] = await Promise.all([dRes.json(), cRes.json(), cfgRes.json(), ecoRes.json(), itRes.json(), evRes.json(), qRes.json()]);
            if (dData.success) setDistricts(dData.districts);
            if (cData.success) setCharacters(cData.characters);
            if (cfgData.success) {
                setConfig(cfgData.config);
                if (!mayorPromptLocal && cfgData.config.mayor_prompt) setMayorPromptLocal(cfgData.config.mayor_prompt);
                const mId = cfgData.config.mayor_model_char_id;
                if (mId === '__custom__') {
                    setMayorModelMode('custom');
                    setCustomEndpoint(cfgData.config.mayor_custom_endpoint || '');
                    setCustomKey(cfgData.config.mayor_custom_key || '');
                    setCustomModel(cfgData.config.mayor_custom_model || '');
                } else if (mId) {
                    setMayorModelMode(mId);
                } else {
                    setMayorModelMode('auto');
                }
            }
            if (ecoData.success) setEconomy(ecoData.stats);
            if (itData.success) setItems(itData.items);
            if (evData.success) setEvents(evData.events);
            if (qData.success) setQuests(qData.quests);
        } catch (e) { console.error('CityManager Error:', e); }
        finally { setLoading(false); }
    }, [apiUrl, token]);

    useEffect(() => {
        fetchAll();
        const scheduleRefresh = () => {
            if (refreshTimerRef.current) return;
            refreshTimerRef.current = setTimeout(() => {
                refreshTimerRef.current = null;
                fetchAll();
            }, 800);
        };
        const handleCityUpdate = () => scheduleRefresh();
        window.addEventListener('city_update', handleCityUpdate);
        const interval = setInterval(fetchAll, 5000);
        return () => {
            window.removeEventListener('city_update', handleCityUpdate);
            clearInterval(interval);
            if (refreshTimerRef.current) {
                clearTimeout(refreshTimerRef.current);
                refreshTimerRef.current = null;
            }
            if (actionNoticeTimerRef.current) {
                clearTimeout(actionNoticeTimerRef.current);
                actionNoticeTimerRef.current = null;
            }
        };
    }, [fetchAll]);

    const saveDistrict = async (d) => { await fetch(`${apiUrl}/city/districts`, { method: 'POST', headers, body: JSON.stringify(d) }); setEditing(null); fetchAll(); };
    const applyDistrictTemplate = (templateKey) => {
        const template = DISTRICT_TEMPLATES.find(t => t.key === templateKey);
        if (!template) return;
        setEditing(p => ({ ...p, ...template.patch }));
    };
    const deleteDistrict = async (id) => { if (!confirm(`确认删除分区 "${id}" 吗？`)) return; await fetch(`${apiUrl}/city/districts/${id}`, { method: 'DELETE', headers }); fetchAll(); };
    const toggleDistrict = async (id) => { await fetch(`${apiUrl}/city/districts/${id}/toggle`, { method: 'PATCH', headers }); fetchAll(); };
    const updateConfig = async (key, value) => { await fetch(`${apiUrl}/city/config`, { method: 'POST', headers, body: JSON.stringify({ key, value }) }); setConfig(prev => ({ ...prev, [key]: value })); };

    const saveItem = async (it) => { await fetch(`${apiUrl}/city/items`, { method: 'POST', headers, body: JSON.stringify(it) }); setEditingItem(null); fetchAll(); };
    const applyItemTemplate = (templateKey) => {
        const template = ITEM_TEMPLATES.find(t => t.key === templateKey);
        if (!template) return;
        setEditingItem(p => ({ ...p, ...template.patch }));
    };
    const deleteItemAction = async (id) => { if (!confirm(`确认删除商品 "${id}" 吗？`)) return; await fetch(`${apiUrl}/city/items/${id}`, { method: 'DELETE', headers }); fetchAll(); };

    const giveGold = async (charId, charName) => {
        const a = prompt(`给 ${charName} 发多少金币？`, '100');
        if (!a) return;
        try {
            const res = await fetch(`${apiUrl}/city/give-gold`, { method: 'POST', headers, body: JSON.stringify({ characterId: charId, amount: Number(a) }) });
            const data = await res.json();
            if (!res.ok || data?.success === false) throw new Error(data?.error || '发金币失败');
            fetchAll();
            alert(`已给 ${charName} 发放 ${Number(a) || 0} 金币。`);
        } catch (e) {
            alert(`发金币失败: ${e.message}`);
        }
    };
    const feedChar = async (charId, charName) => {
        const c = prompt(`给 ${charName} 补多少体力？`, '1000');
        if (!c) return;
        try {
            const res = await fetch(`${apiUrl}/city/feed`, { method: 'POST', headers, body: JSON.stringify({ characterId: charId, calories: Number(c) }) });
            const data = await res.json();
            if (!res.ok || data?.success === false) throw new Error(data?.error || '补体力失败');
            fetchAll();
            alert(`已给 ${charName} 补充 ${Number(c) || 0} 点体力。`);
        } catch (e) {
            alert(`补体力失败: ${e.message}`);
        }
    };
    const giveItem = async (charId, itemId) => {
        const targetName = giveItemTarget?.charName || '该角色';
        const item = items.find(it => it.id === itemId);
        setGiveItemTarget(null);
        showActionNotice('success', `已送出 ${item?.emoji || ''}${item?.name || '物品'} 给 ${targetName}，角色回复正在后台生成。`);
        void (async () => {
            try {
                const res = await fetch(`${apiUrl}/city/give-item`, {
                    method: 'POST',
                    headers,
                    body: JSON.stringify({ characterId: charId, itemId, quantity: 1 })
                });
                const data = await res.json();
                if (!res.ok || data?.success === false) throw new Error(data?.error || '送物品失败');
                fetchAll();
            } catch (e) {
                showActionNotice('error', `送物品失败: ${e.message}`);
            }
        })();
    };
    const deleteEvent = async (id) => { await fetch(`${apiUrl}/city/events/${id}`, { method: 'DELETE', headers }); fetchAll(); };
    const deleteQuest = async (id) => { await fetch(`${apiUrl}/city/quests/${id}`, { method: 'DELETE', headers }); fetchAll(); };
    const claimQuestForCharacter = async (questId, characterId) => {
        try {
            const res = await fetch(`${apiUrl}/city/quests/${questId}/claim`, {
                method: 'POST',
                headers,
                body: JSON.stringify({ characterId })
            });
            const data = await res.json();
            if (!res.ok || data?.success === false) throw new Error(data?.error || '领取失败');
            showActionNotice('success', '悬赏任务已领取');
            fetchAll();
            if (onRefreshLogs) onRefreshLogs();
        } catch (e) {
            showActionNotice('error', `领取失败: ${e.message}`);
        }
    };
    const completeQuestAction = async (questId, characterId) => {
        try {
            const res = await fetch(`${apiUrl}/city/quests/${questId}/complete`, {
                method: 'POST',
                headers,
                body: JSON.stringify({ characterId })
            });
            const data = await res.json();
            if (!res.ok || data?.success === false) throw new Error(data?.error || '完成失败');
            showActionNotice('success', '悬赏任务已完成');
            fetchAll();
            if (onRefreshLogs) onRefreshLogs();
        } catch (e) {
            showActionNotice('error', `完成失败: ${e.message}`);
        }
    };

    const clearLogs = async () => { if (!confirm(`确认清空商业街所有活动记录吗？此操作不可撤销。`)) return; await fetch(`${apiUrl}/city/logs/clear`, { method: 'DELETE', headers }); setMayorResult(null); fetchAll(); if (onRefreshLogs) onRefreshLogs(); alert('活动记录已清空。'); };
    const wipeData = async () => { if (!confirm(`危险操作：确认格式化商业街所有数据（分区、物品、资产、日志）吗？此操作不可撤销。`)) return; await fetch(`${apiUrl}/city/data/wipe`, { method: 'DELETE', headers }); setMayorResult(null); setEconomy(null); fetchAll(); if (onRefreshLogs) onRefreshLogs(); alert('商业街数据已彻底清空。'); };

    const runMayor = async () => {
        setMayorRunning(true); setMayorResult(null);
        try {
            const res = await fetch(`${apiUrl}/city/mayor/run`, { method: 'POST', headers });
            const data = await res.json();
            setMayorResult(data);
            fetchAll();
        } catch (e) { setMayorResult({ error: e.message }); }
        finally { setMayorRunning(false); }
    };
    const saveMayorPrompt = async () => { await updateConfig('mayor_prompt', mayorPromptLocal); };

    const applyTimeSkip = async () => {
        if (previewTimeSkipMinutes <= 0) return;
        if (!confirm('确认要将商业街时间快进 ' + Math.floor(previewTimeSkipMinutes / 60) + ' 小时 ' + (previewTimeSkipMinutes % 60) + ' 分钟吗？\n系统将自动推算这段时间内错过的角色行程。')) return;

        setIsSkippingTime(true);
        try {
            const res = await fetch(`${apiUrl}/city/time-skip`, {
                method: 'POST',
                headers,
                body: JSON.stringify({ minutes: previewTimeSkipMinutes })
            });
            const data = await res.json();
            if (data.success) {
                alert('时间推演完成：已快进 ' + Math.floor(previewTimeSkipMinutes / 60) + ' 小时，并完成 ' + (data.processedTasks || 0) + ' 个待办行程的模拟推算。');
                setPreviewTimeSkipMinutes(0);
                fetchAll(); // Refresh config and logs
            } else {
                alert('时间推算失败: ' + data.error);
            }
        } catch (e) {
            alert('时间推算出错: ' + e.message);
        } finally {
            setIsSkippingTime(false);
        }
    };

    const saveMayorModel = async (mode) => {
        setMayorModelMode(mode);
        if (mode === 'custom') {
            await updateConfig('mayor_model_char_id', '__custom__');
        } else {
            await updateConfig('mayor_model_char_id', mode === 'auto' ? '' : mode);
        }
    };
    const saveCustomApi = async () => {
        await Promise.all([
            updateConfig('mayor_custom_endpoint', customEndpoint),
            updateConfig('mayor_custom_key', customKey),
            updateConfig('mayor_custom_model', customModel),
        ]);
        alert('自定义 API 配置已保存。');
    };

    const dlcEnabled = config.dlc_enabled === '1' || config.dlc_enabled === 'true';
    const physiologyPaused = config.city_actions_paused === '1' || config.city_actions_paused === 'true';
    if (loading) return <div style={{ padding: '20px', textAlign: 'center', color: '#999' }}>加载中...</div>;

    const mayorEnabled = config.mayor_enabled === '1' || config.mayor_enabled === 'true';

    return (
        <div style={{ padding: '16px', maxWidth: '1100px', margin: '0 auto', overflowY: 'auto', height: '100%' }}>
            {actionNotice?.message && (
                <div style={{
                    position: 'sticky',
                    top: '8px',
                    zIndex: 30,
                    marginBottom: '12px',
                    padding: '10px 14px',
                    borderRadius: '12px',
                    fontSize: '13px',
                    fontWeight: '500',
                    backgroundColor: actionNotice.kind === 'error' ? '#fdecea' : '#edf7ed',
                    color: actionNotice.kind === 'error' ? '#c62828' : '#2e7d32',
                    border: `1px solid ${actionNotice.kind === 'error' ? '#f5c2c7' : '#b7dfb9'}`
                }}>
                    {actionNotice.message}
                </div>
            )}

            <div style={{ ...sectionStyle, border: dlcEnabled ? '2px solid #4caf50' : '2px solid #f44336' }}>
                <div style={{ padding: '16px 20px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div>
                        <h3 style={{ margin: 0, fontSize: '16px', display: 'flex', alignItems: 'center', gap: '8px' }}>
                            <Power size={18} color={dlcEnabled ? '#4caf50' : '#f44336'} /> 商业街 DLC 总开关
                        </h3>
                        <p style={{ margin: '4px 0 0', fontSize: '12px', color: '#888' }}>
                            {dlcEnabled ? '模拟引擎运行中，角色会自主行动并消耗 API。' : '模拟引擎已暂停，不会继续消耗 API。'}
                        </p>
                    </div>
                    <button style={btnStyle(dlcEnabled ? '#f44336' : '#4caf50')} onClick={() => updateConfig('dlc_enabled', dlcEnabled ? '0' : '1')}>
                        {dlcEnabled ? <><ToggleRight size={16} /> 关闭</> : <><ToggleLeft size={16} /> 启用</>}
                    </button>
                </div>
            </div>

            <div style={{ ...sectionStyle, border: physiologyPaused ? '2px solid #ff9800' : '2px solid #4caf50', opacity: 1 }}>
                    <div style={{ padding: '16px 20px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <div>
                            <h3 style={{ margin: 0, fontSize: '16px', display: 'flex', alignItems: 'center', gap: '8px' }}>
                                <Power size={18} color={physiologyPaused ? '#ff9800' : '#4caf50'} /> 暂停生理流逝
                            </h3>
                            <p style={{ margin: '4px 0 0', fontSize: '12px', color: '#888' }}>
                                {physiologyPaused
                                    ? '角色的精力、睡眠债、压力、饱腹感、胃负担、健康等生理变量将暂停随时间流逝。'
                                    : '角色的生理变量会继续随时间流逝；这与是否参与商业街活动分开控制。'}
                            </p>
                        </div>
                        <button style={btnStyle(physiologyPaused ? '#4caf50' : '#ff9800')} onClick={() => updateConfig('city_actions_paused', physiologyPaused ? '0' : '1')}>
                            {physiologyPaused ? <><ToggleLeft size={16} /> 恢复生理流逝</> : <><ToggleRight size={16} /> 暂停生理流逝</>}
                        </button>
                    </div>
                </div>

            {economy && (
                <div style={{ display: 'flex', gap: '12px', marginBottom: '16px', flexWrap: 'wrap' }}>
                    {[
                        { label: '流通金币', value: String(economy.total_gold_in_circulation?.toFixed(0) || 0) + ' 金币', color: '#ff9800' },
                        { label: '平均体力', value: String(economy.avg_calories || 0) + ' 卡', color: '#4caf50' },
                        { label: '近1小时行动', value: economy.actions_last_hour?.reduce((s, a) => s + a.count, 0) || 0, color: '#2196f3' },
                    ].map(s => (
                        <div key={s.label} style={{ flex: 1, minWidth: '140px', padding: '12px 16px', backgroundColor: '#fff', borderRadius: '10px', boxShadow: '0 1px 6px rgba(0,0,0,0.06)', borderLeft: '4px solid ' + s.color }}>
                            <div style={{ fontSize: '11px', color: '#999', fontWeight: '600' }}>{s.label}</div>
                            <div style={{ fontSize: '20px', fontWeight: '700', color: s.color, marginTop: '2px' }}>{s.value}</div>
                        </div>
                    ))}
                </div>
            )}

            <div style={sectionStyle}>
                <details open>
                    <summary style={{ ...headerStyle, cursor: 'pointer', listStyle: 'none' }}>
                        <span style={{ fontSize: '16px', fontWeight: '600', color: '#333' }}>规则说明</span>
                    </summary>
                    <div style={{ padding: '14px 18px', fontSize: '13px', color: '#555', lineHeight: 1.7 }}>
                        <div style={{ fontWeight: '600', marginBottom: '8px', color: '#333' }}>当前已实装规则</div>
                        <div>1. 生存基础：角色会持续消耗体力，并随着时间累积精力波动、睡眠债、压力、社交需求和健康变化。</div>
                        <div>2. 进食反馈：吃东西后会提升饱腹感，心情通常会变好，同时增加睡眠债。</div>
                        <div>3. 过量进食：如果胃负担过高，角色会更困、更没精神，压力也会上升。</div>
                        <div>4. 被动消化：饱腹感和胃负担会随时间慢慢下降，胃负担高时会额外推高睡眠债。</div>
                        <div>5. 休息恢复：休息会降低睡眠债，并帮助恢复精力和部分健康。</div>
                        <div>6. 精力阈值：精力低于 35 时会明显偏向恢复类行动；低于 20 时会硬性避开工作、学习、赌博和高强度娱乐。</div>
                        <div>7. 高精力状态：精力高于 70 时，角色更愿意活动、探索和主动表达；高于 85 时这种倾向会更明显。</div>
                        <div>8. 睡眠债对对话：睡眠债高于 40 时回复会更疲惫、更短；高于 70 时更烦躁、更容易觉得聊天是负担；高于 85 时除非情绪特别强烈，否则会明显不想聊，只想休息。</div>
                        <div>9. 情绪触发来源：私聊收到用户消息、角色发出私聊回复、群聊里看到用户发言、群聊里自己发言、商业街社交事件结算，都会回写心情、压力和社交需求。</div>
                        <div>10. 私聊情绪回写：收到用户私聊时，角色会明显提振心情、降低压力、缓解社交饥渴；如果已经等了较久，变化会更大。角色自己发出私聊后，也会小幅缓解压力和社交需求。</div>
                        <div>11. 群聊情绪回写：群里普通看到用户发言会有轻微变化；被点名 @ 时变化更明显；@all 介于两者之间。角色自己在群里发言后，也会小幅缓解压力和社交需求。</div>
                        <div>12. 商业街社交回写：在商业街发生偶遇、攀谈、社交结算后，角色会额外提升一点心情，并降低一点压力和社交需求。</div>
                        <div>13. 主情绪判定阈值：难受 🤒 由低健康或高胃负担触发；困倦 😪 由高睡眠债触发；委屈 🥺 由高压力、商业街消息被忽略或被冷落触发；生气 😤 由高压力配合低心情触发；吃醋 😾 需要较高嫉妒值且必须有明确嫉妒对象；寂寞 🫥 由高社交需求配合偏低心情触发；开心 😄、伤心 😞、烦躁 😣 则由心情和压力区间共同决定。</div>
                        <div>14. 主情绪对私聊：生气会更冲、更带刺；委屈会更试探、更索要安抚；开心会更主动、更愿意展开；寂寞会更想延长对话；困倦和难受会更短句、更不想多聊。</div>
                        <div>15. 主情绪对群聊：生气更容易呛人或反驳；委屈更容易沉默或轻微带刺；开心更容易接话和活跃；寂寞更想被注意；困倦和难受更容易潜水和少参与。</div>
                        <div>16. 主情绪对商业街：难受和困倦更偏向医疗或休息；委屈和伤心更偏向安全、熟悉、低刺激地点；寂寞更偏向公共场所和休闲区；生气和烦躁更偏向散心、发泄或转移注意力；开心更偏向娱乐、探索和主动活动。</div>
                        <div>17. 实时刷新：收到私聊消息、群聊消息、商业街更新和联系人刷新事件时，前端会自动刷新联系人情绪，不需要手动刷新页面。</div>
                        <div>18. 商业街活动开关：关闭上方 DLC 总开关后，角色不再继续参与商业街活动、日程与社交。</div>
                        <div>19. 生理流逝开关：开启“暂停生理流逝”后，精力、睡眠债、压力、饱腹感、胃负担、健康等变量会停止随时间变化。</div>
                        <div>20. 场景化私聊：角色在工作中、睡觉中、吃饭中时，私聊和群聊语气会带上当前场景，不再像完全空闲时那样聊天。</div>
                        <div>21. 工作打扰：角色在工作中被用户频繁私聊或群聊点名时，会累计分心值；工作结束时可能少赚一点钱，压力也会上升。</div>
                        <div>22. 睡眠打扰：角色在睡觉时被用户频繁私聊或群聊点名时，会累计睡眠打断值；休息结束时睡眠债恢复会变差，精力也会受影响。</div>
                    </div>
                </details>
            </div>

            <SchoolGrowthPanel apiUrl={apiUrl} headers={headers} />

            <div style={sectionStyle}>
                <div style={headerStyle}>
                    <h3 style={{ margin: 0, fontSize: '16px' }}>城市分区</h3>
                    <button style={btnStyle('#4caf50')} onClick={() => setEditing({ ...EMPTY_DISTRICT })}><Plus size={14} /> 新增</button>
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', gap: '10px', padding: '12px' }}>
                    {districts.map(d => (
                        <div key={d.id} style={{ padding: '12px', borderRadius: '10px', border: '1px solid #eee', backgroundColor: d.is_enabled ? '#fff' : '#f9f9f9', opacity: d.is_enabled ? 1 : 0.55 }}>
                            <div style={{ fontSize: '24px', marginBottom: '4px' }}>{d.emoji}</div>
                            <div style={{ fontWeight: '600', fontSize: '13px', marginBottom: '2px' }}>{d.name}</div>
                            <div style={{ fontSize: '10px', color: '#888', marginBottom: '6px' }}>{d.description}</div>
                            <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap', marginBottom: '8px' }}>
                                {d.cal_cost > 0 && <span style={{ fontSize: '10px', padding: '1px 5px', borderRadius: '3px', backgroundColor: '#ffebee', color: '#f44336' }}>-{d.cal_cost}卡</span>}
                                {d.cal_reward > 0 && <span style={{ fontSize: '10px', padding: '1px 5px', borderRadius: '3px', backgroundColor: '#e8f5e9', color: '#4caf50' }}>+{d.cal_reward}卡</span>}
                                {d.money_cost > 0 && <span style={{ fontSize: '10px', padding: '1px 5px', borderRadius: '3px', backgroundColor: '#fff3e0', color: '#e65100' }}>-{d.money_cost}币</span>}
                                {d.money_reward > 0 && <span style={{ fontSize: '10px', padding: '1px 5px', borderRadius: '3px', backgroundColor: '#e8f5e9', color: '#2e7d32' }}>+{d.money_reward}币</span>}
                            </div>
                            <div style={{ display: 'flex', gap: '4px' }}>
                                <button onClick={() => setEditing({ ...d })} style={{ ...btnStyle('#2196f3'), padding: '3px 6px', fontSize: '10px' }}><Edit3 size={10} /></button>
                                <button onClick={() => toggleDistrict(d.id)} style={{ ...btnStyle(d.is_enabled ? '#ff9800' : '#9e9e9e'), padding: '3px 6px', fontSize: '10px' }}>{d.is_enabled ? <ToggleRight size={10} /> : <ToggleLeft size={10} />}</button>
                                <button onClick={() => deleteDistrict(d.id)} style={{ ...btnStyle('#f44336'), padding: '3px 6px', fontSize: '10px' }}><Trash2 size={10} /></button>
                            </div>
                        </div>
                    ))}
                </div>
            </div>

            <div style={sectionStyle}>
                <div style={headerStyle}>
                    <h3 style={{ margin: 0, fontSize: '16px' }}>商品目录</h3>
                    <button style={btnStyle('#4caf50')} onClick={() => setEditingItem({ ...EMPTY_ITEM })}><Plus size={14} /> 新增商品</button>
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(130px, 1fr))', gap: '8px', padding: '12px' }}>
                    {items.map(it => (
                        <div key={it.id} style={{ padding: '10px', borderRadius: '8px', border: '1px solid #eee', backgroundColor: it.is_available ? '#fff' : '#f9f9f9', opacity: it.is_available ? 1 : 0.5 }}>
                            <div style={{ fontSize: '22px', marginBottom: '2px' }}>{it.emoji}</div>
                            <div style={{ fontWeight: '600', fontSize: '12px' }}>{it.name}</div>
                            <div style={{ fontSize: '10px', color: '#888', marginBottom: '4px' }}>{it.description}</div>
                            <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap', marginBottom: '6px' }}>
                                <span style={{ fontSize: '10px', padding: '1px 5px', borderRadius: '3px', backgroundColor: '#fff3e0', color: '#e65100' }}>{it.buy_price}币</span>
                                {it.cal_restore > 0 && <span style={{ fontSize: '10px', padding: '1px 5px', borderRadius: '3px', backgroundColor: '#e8f5e9', color: '#4caf50' }}>+{it.cal_restore}卡</span>}
                                {it.sold_at && <span style={{ fontSize: '10px', padding: '1px 5px', borderRadius: '3px', backgroundColor: '#e3f2fd', color: '#1565c0' }}>地点 {it.sold_at}</span>}
                                <span style={{ fontSize: '10px', padding: '1px 5px', borderRadius: '3px', backgroundColor: it.stock === -1 ? '#f5f5f5' : it.stock <= 0 ? '#ffcdd2' : it.stock <= 3 ? '#fff3e0' : '#e8f5e9', color: it.stock === -1 ? '#999' : it.stock <= 0 ? '#c62828' : it.stock <= 3 ? '#e65100' : '#2e7d32' }}>{it.stock === -1 ? '不限' : it.stock <= 0 ? '售罄' : ('库存' + it.stock)}</span>
                            </div>
                            <div style={{ display: 'flex', gap: '4px' }}>
                                <button onClick={() => setEditingItem({ ...it })} style={{ ...btnStyle('#2196f3'), padding: '3px 6px', fontSize: '10px' }}><Edit3 size={10} /></button>
                                <button onClick={() => deleteItemAction(it.id)} style={{ ...btnStyle('#f44336'), padding: '3px 6px', fontSize: '10px' }}><Trash2 size={10} /></button>
                            </div>
                        </div>
                    ))}
                </div>
            </div>

            <div style={sectionStyle}>
                <div style={headerStyle}>
                    <h3 style={{ margin: 0, fontSize: '16px' }}>经济调控</h3>
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', gap: '10px', padding: '12px' }}>
                    {Object.entries(config).filter(([k]) => !HIDDEN_CONFIG_KEYS.includes(k)).map(([key, value]) => (
                        <div key={key} style={{ padding: '8px', border: '1px solid #eee', borderRadius: '6px' }}>
                            <label style={labelStyle}>{CONFIG_LABELS[key] || key}</label>
                            <input style={inputStyle} defaultValue={value} onBlur={(e) => { if (e.target.value !== value) updateConfig(key, e.target.value); }} />
                        </div>
                    ))}
                </div>
            </div>

            <div style={sectionStyle}>
                <div style={headerStyle}>
                    <h3 style={{ margin: 0, fontSize: '16px' }}>记忆与社交控制</h3>
                </div>
                <div style={{ padding: '16px', display: 'flex', flexDirection: 'column', gap: '16px' }}>
                    <div>
                        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '13px', marginBottom: '6px' }}>
                            <span>本人记忆获取上限</span>
                            <span style={{ fontWeight: '600', color: '#2196f3' }}>{config.city_self_log_limit || '5'} 条</span>
                        </div>
                        <input type="range" min="0" max="20" value={parseInt(config.city_self_log_limit) || 5}
                            onChange={e => updateConfig('city_self_log_limit', e.target.value)}
                            style={{ width: '100%' }} />
                        <div style={{ fontSize: '10px', color: '#999', marginTop: '4px' }}>
                            决定 AI 行动时，最多向上下文里注入多少条自己的商业街近期经历。
                        </div>
                    </div>
                    <div>
                        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '13px', marginBottom: '6px' }}>
                            <span>熟人情报获取上限</span>
                            <span style={{ fontWeight: '600', color: '#4caf50' }}>{config.city_social_log_limit || '3'} 条</span>
                        </div>
                        <input type="range" min="0" max="20" value={parseInt(config.city_social_log_limit) || 3}
                            onChange={e => updateConfig('city_social_log_limit', e.target.value)}
                            style={{ width: '100%' }} />
                        <div style={{ fontSize: '10px', color: '#999', marginTop: '4px' }}>
                            当两个熟人相遇时，彼此最多能读到对方多少条近期商业街经历。
                        </div>
                    </div>
                    <div>
                        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '13px', marginBottom: '6px' }}>
                            <span>公告区读取上限</span>
                            <span style={{ fontWeight: '600', color: '#7c3aed' }}>{config.city_announcement_limit || '5'} 条</span>
                        </div>
                        <input type="range" min="0" max="20" value={parseInt(config.city_announcement_limit) || 5}
                            onChange={e => updateConfig('city_announcement_limit', e.target.value)}
                            style={{ width: '100%' }} />
                        <div style={{ fontSize: '10px', color: '#999', marginTop: '4px' }}>
                            决定角色在私聊或商业街行动时，最多能读到公告区多少条广播、广告和街头公告。
                        </div>
                    </div>
                </div>
            </div>

            <div style={sectionStyle}>
                <div style={headerStyle}>
                    <h3 style={{ margin: 0, fontSize: '16px' }}>虚拟时钟 (Virtual Clock)</h3>
                </div>
                <div style={{ padding: '16px', display: 'flex', flexDirection: 'column', gap: '16px' }}>
                    <div style={{ fontSize: '11px', color: '#888', backgroundColor: '#f9f9f9', padding: '10px', borderRadius: '6px', lineHeight: 1.6 }}>
                        偏离现实时间的设定。如果跨过早上 6 点，系统会在下一次 Tick 强制重新生成当天日程。
                    </div>

                    {(() => {
                        const now = new Date();
                        const currentDaysOffset = parseInt(config.city_time_offset_days) || 0;
                        const currentHoursOffset = parseInt(config.city_time_offset_hours) || 0;
                        now.setDate(now.getDate() + currentDaysOffset);
                        now.setHours(now.getHours() + currentHoursOffset);

                        const currentStr = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-' + String(now.getDate()).padStart(2, '0') + ' ' + String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0');

                        // Preview date based on slider
                        now.setMinutes(now.getMinutes() + previewTimeSkipMinutes);
                        const previewStr = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-' + String(now.getDate()).padStart(2, '0') + ' ' + String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0');

                        return (
                            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', background: '#e3f2fd', padding: '8px 12px', borderRadius: '6px' }}>
                                    <span style={{ fontSize: '12px', color: '#1565c0', fontWeight: 'bold' }}>当前商业街时间映射：</span>
                                    <span style={{ fontSize: '14px', fontFamily: 'monospace', color: '#000', fontWeight: 'bold', letterSpacing: '0.5px' }}>{currentStr}</span>
                                </div>
                                {previewTimeSkipMinutes > 0 && (
                                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', background: '#fff9c4', padding: '8px 12px', borderRadius: '6px', border: '1px dashed #fbc02d' }}>
                                        <span style={{ fontSize: '12px', color: '#f57f17', fontWeight: 'bold' }}>快进后目标时间预览：</span>
                                        <span style={{ fontSize: '14px', fontFamily: 'monospace', color: '#f57f17', fontWeight: 'bold', letterSpacing: '0.5px' }}>{previewStr}</span>
                                    </div>
                                )}
                            </div>
                        );
                    })()}

                    <div>
                        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '13px', marginBottom: '6px' }}>
                            <span>准备快进 (Forward Time Skip)</span>
                            <span style={{ fontWeight: '600', color: '#f57f17' }}>
                                +{Math.floor(previewTimeSkipMinutes / 60)} 小时 {previewTimeSkipMinutes % 60} 分钟
                            </span>
                        </div>
                        <input type="range" min="0" max="1440" step="15" value={parseInt(previewTimeSkipMinutes) || 0}
                            onChange={e => setPreviewTimeSkipMinutes(parseInt(e.target.value))}
                            disabled={isSkippingTime}
                            style={{ width: '100%' }} />
                        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '10px', color: '#999', marginTop: '2px' }}>
                            <span>0h</span><span>+12h</span><span>+24h</span>
                        </div>
                    </div>

                    <button
                        onClick={applyTimeSkip}
                        disabled={isSkippingTime || previewTimeSkipMinutes <= 0}
                        style={{ ...btnStyle(isSkippingTime || previewTimeSkipMinutes <= 0 ? '#e0e0e0' : '#4caf50'), width: '100%', justifyContent: 'center', padding: '12px', fontSize: '14px', marginTop: '8px' }}>
                        {isSkippingTime ? <><ShoppingBag size={16} className="spin" style={{ animation: 'spin 2s linear infinite' }} /> 正在推演角色错过的日程，请稍候...</> : <><ToggleRight size={16} /> 确认并推算 (Confirm & Simulate)</>}
                    </button>
                    <style>{`@keyframes spin { 100% { transform: rotate(360deg); } }`}</style>
                </div>
            </div>

            <div style={{ ...sectionStyle, border: '2px solid ' + (mayorEnabled ? '#9c27b0' : '#ccc') }}>
                <div style={{ ...headerStyle, background: mayorEnabled ? 'linear-gradient(to right, #f3e5f5, #fff)' : '#f9f9f9' }}>
                    <h3 style={{ margin: 0, fontSize: '16px', display: 'flex', alignItems: 'center', gap: '8px' }}>
                        市长 AI (The Mayor)
                    </h3>
                    <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                        <button style={btnStyle(mayorEnabled ? '#f44336' : '#4caf50')} onClick={() => updateConfig('mayor_enabled', mayorEnabled ? '0' : '1')}>
                            {mayorEnabled ? <><ToggleRight size={14} /> 关闭市长</> : <><ToggleLeft size={14} /> 启用市长</>}
                        </button>
                        <button style={btnStyle(mayorRunning ? '#9e9e9e' : '#9c27b0')} onClick={runMayor} disabled={mayorRunning}>
                            {mayorRunning ? '决策中...' : '手动执行'}
                        </button>
                    </div>
                </div>
                <div style={{ padding: '16px' }}>
                    <p style={{ margin: '0 0 12px', fontSize: '12px', color: '#888' }}>
                        {mayorEnabled ? '市长 AI 已启用，每隔 ' + (config.mayor_interval_hours || '6') + ' 小时自动执行一次决策。' : '市长 AI 已暂停，不会自动执行。'}
                    </p>
                    <div style={{ display: 'flex', gap: '12px', marginBottom: '12px', alignItems: 'center' }}>
                        <label style={{ ...labelStyle, margin: 0, whiteSpace: 'nowrap' }}>决策间隔</label>
                        <input style={{ ...inputStyle, width: '80px' }} type="number" min="1" defaultValue={config.mayor_interval_hours || '6'}
                            onBlur={e => updateConfig('mayor_interval_hours', e.target.value)} />
                        <span style={{ fontSize: '12px', color: '#999' }}>小时/次</span>
                    </div>
                    <div style={{ marginBottom: '12px' }}>
                        <label style={labelStyle}>市长使用的 AI 模型</label>
                        <select style={inputStyle} value={mayorModelMode} onChange={e => saveMayorModel(e.target.value)}>
                            <option value="auto">自动选择（第一个有 API 的角色）</option>
                            {characters.filter(c => c.api_endpoint).map(c => (
                                <option key={c.id} value={c.id}>{c.name} - {c.model_name || '未知模型'}</option>
                            ))}
                            <option value="custom">手动填写 API 接口</option>
                        </select>
                    </div>
                    {mayorModelMode === 'custom' && (
                        <div style={{ padding: '10px', backgroundColor: '#fafafa', borderRadius: '8px', border: '1px dashed #ccc', marginBottom: '12px' }}>
                            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', alignItems: 'flex-end' }}>
                                <div style={{ flex: '1 1 200px' }}>
                                    <label style={labelStyle}>API Endpoint</label>
                                    <input style={inputStyle} value={customEndpoint} onChange={e => setCustomEndpoint(e.target.value)} placeholder="https://api.openai.com/v1/chat/completions" />
                                </div>
                                <div>
                                    <label style={labelStyle}>API Key</label>
                                    <input style={inputStyle} type="password" value={customKey} onChange={e => setCustomKey(e.target.value)} placeholder="sk-..." />
                                </div>
                                <div style={{ flex: '1 1 120px' }}>
                                    <label style={labelStyle}>模型名称</label>
                                    <input style={inputStyle} value={customModel} onChange={e => setCustomModel(e.target.value)} placeholder="gpt-4o" />
                                </div>
                                <div style={{ width: '100%', display: 'flex', justifyContent: 'flex-end' }}>
                                    <button style={btnStyle('#9c27b0')} onClick={saveCustomApi}><Save size={12} /> 保存</button>
                                </div>
                            </div>
                        </div>
                    )}
                    <div style={{ marginBottom: '12px' }}>
                        <label style={labelStyle}>市长 Prompt（决定市长 AI 的行为方式，可自由修改）</label>
                        <textarea
                            style={{ ...inputStyle, height: '120px', fontFamily: 'monospace', fontSize: '12px', resize: 'vertical' }}
                            value={mayorPromptLocal}
                            onChange={e => setMayorPromptLocal(e.target.value)}
                        />
                        <button style={{ ...btnStyle('#9c27b0'), marginTop: '6px' }} onClick={saveMayorPrompt}>
                            <Save size={12} /> 保存 Prompt
                        </button>
                    </div>
                    {mayorResult && (
                        <div style={{ padding: '10px', backgroundColor: mayorResult.success ? '#e8f5e9' : '#ffebee', borderRadius: '8px', fontSize: '12px', marginBottom: '10px' }}>
                            {mayorResult.success ? (
                                <div>
                                    决策完成：{mayorResult.results?.price_changes || 0} 个调价，{mayorResult.results?.events || 0} 个事件，{mayorResult.results?.quests || 0} 个任务
                                    {mayorResult.results?.announcement && <div style={{ marginTop: '4px', fontStyle: 'italic' }}>广播：{mayorResult.results.announcement}</div>}
                                </div>
                            ) : (
                                <div style={{ display: 'flex', justifyContent: 'space-between', gap: '12px', alignItems: 'center', flexWrap: 'wrap' }}>
                                    <div>失败：{mayorResult.error || mayorResult.reason || '未知错误'}</div>
                                    <button
                                        style={btnStyle(mayorRunning ? '#9e9e9e' : '#d32f2f')}
                                        onClick={runMayor}
                                        disabled={mayorRunning}
                                    >
                                        {mayorRunning ? '重试中...' : '重新生成'}
                                    </button>
                                </div>
                            )}
                        </div>
                    )}
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '12px' }}>
                        <div style={{ flex: '1 1 280px' }}>
                            {(() => {
                                const visibleEvents = events
                                    .map((event) => {
                                        const remainingMs = Number(event.expires_at || 0) - Date.now();
                                        const remainingHours = Math.ceil(remainingMs / 3600000);
                                        return {
                                            ...event,
                                            remainingMs,
                                            remainingHours
                                        };
                                    })
                                    .filter((event) => event.remainingMs > 0 && event.remainingHours > 0);
                                return (
                                    <>
                            <div style={{ fontWeight: '600', fontSize: '13px', marginBottom: '6px' }}>活跃事件 ({visibleEvents.length})</div>
                            {visibleEvents.length === 0 ? <div style={{ fontSize: '11px', color: '#bbb' }}>暂无事件</div> : visibleEvents.map(e => (
                                <div key={e.id} style={{ padding: '6px', border: '1px solid #eee', borderRadius: '6px', marginBottom: '4px', fontSize: '11px', display: 'flex', alignItems: 'flex-start', gap: '6px' }}>
                                    <div style={{ flex: 1 }}>
                                        <span>{e.emoji} <b>{e.title}</b></span>
                                        <div style={{ color: '#888' }}>{e.description}</div>
                                        <div style={{ color: '#aaa', fontSize: '10px' }}>剩余 {e.remainingHours}h</div>
                                    </div>
                                    <button onClick={() => deleteEvent(e.id)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#ccc', padding: '2px', fontSize: '12px', lineHeight: 1, flexShrink: 0 }} title="删除事件">×</button>
                                </div>
                            ))}
                                    </>
                                );
                            })()}
                        </div>
                        <div style={{ flex: '1 1 280px' }}>
                            <div style={{ fontWeight: '600', fontSize: '13px', marginBottom: '6px' }}>悬赏任务 ({quests.length})</div>
                            {quests.length === 0 ? <div style={{ fontSize: '11px', color: '#bbb' }}>暂无任务</div> : quests.map(q => (
                                <div key={q.id} style={{ padding: '6px', border: '1px solid #eee', borderRadius: '6px', marginBottom: '4px', fontSize: '11px', display: 'flex', alignItems: 'flex-start', gap: '6px' }}>
                                    <div style={{ flex: 1 }}>
                                        <span>{q.emoji} <b>{q.title}</b> <span style={{ color: '#ff9800' }}>({q.difficulty})</span></span>
                                        <div style={{ color: '#888' }}>{q.description}</div>
                                        <div style={{ color: '#4caf50', fontSize: '10px' }}>奖励: {q.reward_gold}币 {q.reward_cal > 0 ? (q.reward_cal + '卡') : ''}</div>
                                        <div style={{ color: q.is_completed ? '#2e7d32' : q.claimed_by ? '#ff9800' : '#999', fontSize: '10px', marginTop: '3px' }}>
                                            {q.is_completed
                                                ? '已完成'
                                                : q.claimed_by
                                                    ? `已领取：${(characters.find(c => c.id === q.claimed_by) || {}).name || q.claimed_by}`
                                                    : '待领取'}
                                        </div>
                                        {!q.is_completed && (
                                            <div style={{ display: 'flex', gap: '6px', marginTop: '6px', flexWrap: 'wrap', alignItems: 'center' }}>
                                                {!q.claimed_by ? (
                                                    <select
                                                        defaultValue=""
                                                        style={{ ...inputStyle, minWidth: '120px', height: '30px', fontSize: '11px', padding: '4px 8px' }}
                                                        onChange={(e) => {
                                                            if (!e.target.value) return;
                                                            claimQuestForCharacter(q.id, e.target.value);
                                                            e.target.value = '';
                                                        }}
                                                    >
                                                        <option value="">指派角色领取</option>
                                                        {characters.map(c => (
                                                            <option key={c.id} value={c.id}>{c.name}</option>
                                                        ))}
                                                    </select>
                                                ) : (
                                                    <button onClick={() => completeQuestAction(q.id, q.claimed_by)} style={{ ...btnStyle('#4caf50'), padding: '4px 8px', fontSize: '11px' }}>
                                                        标记完成
                                                    </button>
                                                )}
                                            </div>
                                        )}
                                    </div>
                                    <button onClick={() => deleteQuest(q.id)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#ccc', padding: '2px', fontSize: '12px', lineHeight: 1, flexShrink: 0 }} title="删除任务">×</button>
                                </div>
                            ))}
                        </div>
                    </div>
                </div>
            </div>

            <div style={sectionStyle}>
                <div style={headerStyle}>
                    <h3 style={{ margin: 0, fontSize: '16px' }}>管理员操作</h3>
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: '8px', padding: '12px' }}>
                    {characters.map(c => {
                        const emotion = deriveEmotion(c);
                        const physical = derivePhysicalState(c);
                        return (
                        <div key={c.id} style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '8px', border: '1px solid #eee', borderRadius: '8px' }}>
                            <img src={avatarSrc(c.avatar, apiUrl)} alt="" style={{ width: '28px', height: '28px', borderRadius: '50%', objectFit: 'cover' }} />
                            <div style={{ flex: 1, minWidth: 0 }}>
                                <div style={{ fontWeight: '500', fontSize: '12px', display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
                                    <span>{c.name}</span>
                                    <span style={{ fontSize: '10px', color: emotion.color, fontWeight: '700' }}>{emotion.emoji} {emotion.label}</span>
                                    <span style={{ fontSize: '10px', color: physical.color, fontWeight: '700' }}>{physical.emoji} {physical.label}</span>
                                </div>
                                <div style={{ fontSize: '10px', color: '#999' }}>{(c.wallet || 0).toFixed(0)}币 · {c.calories}卡 · <span onClick={(e) => { e.stopPropagation(); setViewInventory({ charName: c.name, inventory: c.inventory || [] }); }} style={{ cursor: 'pointer', color: (c.inventory || []).length > 0 ? 'var(--accent-color, #2196f3)' : '#999', textDecoration: (c.inventory || []).length > 0 ? 'underline' : 'none' }}>背包 {(c.inventory || []).length} 件</span></div>
                            </div>
                            <button onClick={() => giveGold(c.id, c.name)} style={{ ...btnStyle('#ff9800'), padding: '3px 6px', fontSize: '10px' }} title="发金币"><DollarSign size={10} /></button>
                            <button onClick={() => feedChar(c.id, c.name)} style={{ ...btnStyle('#4caf50'), padding: '3px 6px', fontSize: '10px' }} title="补体力"><Heart size={10} /></button>
                            <button onClick={() => setGiveItemTarget({ charId: c.id, charName: c.name })} style={{ ...btnStyle('#9c27b0'), padding: '3px 6px', fontSize: '10px' }} title="送物品"><Package size={10} /></button>
                        </div>
                        );
                    })}
                </div>
                <div style={{ marginTop: '16px', padding: '16px', borderTop: '1px dashed #ddd', backgroundColor: '#fff5f5' }}>
                    <h4 style={{ margin: '0 0 12px 0', fontSize: '14px', color: '#d32f2f' }}>危险操作（全局记录与数据清理）</h4>
                    <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap' }}>
                        <button onClick={clearLogs} style={{ ...btnStyle('#ff9800'), padding: '8px 16px' }}>
                            <Trash2 size={16} style={{ marginRight: '6px' }} /> 清空市长/角色活动日志
                        </button>
                        <button onClick={wipeData} style={{ ...btnStyle('#d32f2f'), padding: '8px 16px' }}>
                            <AlertTriangle size={16} style={{ marginRight: '6px' }} /> 彻底格式化商业街所有数据
                        </button>
                    </div>
                </div>
            </div>

            {editing && (
                <div style={{ position: 'fixed', inset: 0, backgroundColor: 'rgba(0,0,0,0.4)', display: 'flex', justifyContent: 'center', alignItems: 'center', zIndex: 9999, padding: '16px', boxSizing: 'border-box' }} onClick={(e) => { if (e.target === e.currentTarget) setEditing(null); }}>
                    <div style={{ backgroundColor: '#fff', borderRadius: '16px', padding: '24px', width: '100%', maxWidth: '480px', maxHeight: '80vh', overflowY: 'auto', boxShadow: '0 10px 40px rgba(0,0,0,0.2)', boxSizing: 'border-box' }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
                            <h3 style={{ margin: 0 }}>{editing.id ? ('编辑分区：' + editing.name) : '新建分区'}</h3>
                            <button onClick={() => setEditing(null)} style={{ border: 'none', background: 'none', cursor: 'pointer' }}><X size={20} /></button>
                        </div>
                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
                            <div><label style={labelStyle}>ID</label><input style={inputStyle} value={editing.id} onChange={e => setEditing(p => ({ ...p, id: e.target.value.toLowerCase().replace(/\s/g, '_') }))} /></div>
                            <div><label style={labelStyle}>名称</label><input style={inputStyle} value={editing.name} onChange={e => setEditing(p => ({ ...p, name: e.target.value }))} /></div>
                            <div><label style={labelStyle}>Emoji</label><input style={inputStyle} value={editing.emoji} onChange={e => setEditing(p => ({ ...p, emoji: e.target.value }))} /></div>
                            <div style={{ gridColumn: '1/-1' }}>
                                <label style={labelStyle}>行为模板（先选生活场景，再细调高级参数）</label>
                                <div style={{ fontSize: '12px', color: '#666', marginBottom: '8px' }}>比如“工厂打工”“餐馆吃饭”“游乐场娱乐”“逛街消费”。选中后会自动带出推荐数值。</div>
                                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(132px, 1fr))', gap: '8px', marginTop: '4px' }}>
                                    {DISTRICT_TEMPLATES.map((template) => (
                                        <button
                                            key={template.key}
                                            type="button"
                                            onClick={() => applyDistrictTemplate(template.key)}
                                            style={{
                                                padding: '10px 12px',
                                                borderRadius: '12px',
                                                fontSize: '12px',
                                                fontWeight: '600',
                                                cursor: 'pointer',
                                                textAlign: 'left',
                                                border: getDistrictTemplateKey(editing) === template.key ? '2px solid #2196f3' : '1px solid #ddd',
                                                backgroundColor: getDistrictTemplateKey(editing) === template.key ? '#e3f2fd' : '#fff',
                                                color: getDistrictTemplateKey(editing) === template.key ? '#1565c0' : '#444',
                                                lineHeight: 1.4
                                            }}
                                        >
                                            <div>{template.label}</div>
                                            <div style={{ fontSize: '11px', fontWeight: '400', color: getDistrictTemplateKey(editing) === template.key ? '#1565c0' : '#777', marginTop: '2px' }}>
                                                {template.hint}
                                            </div>
                                        </button>
                                    ))}
                                </div>
                            </div>
                            <div style={{ gridColumn: '1/-1' }}>
                                <label style={labelStyle}>底层类型（高级项，决定 AI 的基础理解）</label>
                                <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', marginTop: '4px' }}>
                                    {[['work', '工作'], ['food', '餐饮'], ['rest', '休息'], ['leisure', '娱乐'], ['shopping', '购物'], ['education', '教育'], ['medical', '医疗'], ['gambling', '赌博'], ['wander', '闲逛'], ['generic', '通用']].map(([v, l]) => (
                                        <button key={v} type="button" onClick={() => setEditing(p => ({ ...p, type: v }))} style={{ padding: '5px 10px', borderRadius: '16px', fontSize: '12px', fontWeight: '500', cursor: 'pointer', border: editing.type === v ? '2px solid #2196f3' : '1px solid #ddd', backgroundColor: editing.type === v ? '#e3f2fd' : '#fff', color: editing.type === v ? '#1565c0' : '#666' }}>
                                            {l}
                                        </button>
                                    ))}
                                </div>
                            </div>
                            <div style={{ gridColumn: '1/-1' }}><label style={labelStyle}>描述</label><input style={inputStyle} value={editing.description} onChange={e => setEditing(p => ({ ...p, description: e.target.value }))} /></div>
                            <div><label style={labelStyle}>行动标签</label><input style={inputStyle} value={editing.action_label} onChange={e => setEditing(p => ({ ...p, action_label: e.target.value }))} /></div>
                            <div><label style={labelStyle}>排序</label><input style={inputStyle} type="number" value={editing.sort_order} onChange={e => setEditing(p => ({ ...p, sort_order: Number(e.target.value) }))} /></div>
                        </div>
                        <div style={{ marginTop: '14px', padding: '12px', backgroundColor: '#f8f9fa', borderRadius: '8px', border: '1px solid #eee' }}>
                            <div style={{ fontSize: '12px', fontWeight: '600', color: '#555', marginBottom: '10px' }}>资源消耗 / 产出</div>
                            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
                                <div><div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11px', color: '#f44336', marginBottom: '4px' }}><span>消耗体力</span><span style={{ fontWeight: '700' }}>{editing.cal_cost}</span></div><input type="range" min="0" max="500" step="10" value={editing.cal_cost} onChange={e => setEditing(p => ({ ...p, cal_cost: Number(e.target.value) }))} style={{ width: '100%' }} /></div>
                                <div><div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11px', color: '#4caf50', marginBottom: '4px' }}><span>恢复体力</span><span style={{ fontWeight: '700' }}>{editing.cal_reward}</span></div><input type="range" min="0" max="1000" step="10" value={editing.cal_reward} onChange={e => setEditing(p => ({ ...p, cal_reward: Number(e.target.value) }))} style={{ width: '100%' }} /></div>
                                <div><div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11px', color: '#e65100', marginBottom: '4px' }}><span>消耗金币</span><span style={{ fontWeight: '700' }}>{editing.money_cost}</span></div><input type="range" min="0" max="500" step="5" value={editing.money_cost} onChange={e => setEditing(p => ({ ...p, money_cost: Number(e.target.value) }))} style={{ width: '100%' }} /></div>
                                <div><div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11px', color: '#2e7d32', marginBottom: '4px' }}><span>获得金币</span><span style={{ fontWeight: '700' }}>{editing.money_reward}</span></div><input type="range" min="0" max="500" step="5" value={editing.money_reward} onChange={e => setEditing(p => ({ ...p, money_reward: Number(e.target.value) }))} style={{ width: '100%' }} /></div>
                            </div>
                        </div>
                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px', marginTop: '10px' }}>
                            <div><div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11px', color: '#666', marginBottom: '4px' }}><span>持续 tick</span><span style={{ fontWeight: '700' }}>{editing.duration_ticks}</span></div><input type="range" min="1" max="10" value={editing.duration_ticks} onChange={e => setEditing(p => ({ ...p, duration_ticks: Number(e.target.value) }))} style={{ width: '100%' }} /></div>
                            <div><div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11px', color: '#666', marginBottom: '4px' }}><span>容量 (0=无限)</span><span style={{ fontWeight: '700' }}>{editing.capacity}</span></div><input type="range" min="0" max="50" value={editing.capacity} onChange={e => setEditing(p => ({ ...p, capacity: Number(e.target.value) }))} style={{ width: '100%' }} /></div>
                        </div>
                        <div style={{ marginTop: '12px', padding: '8px 12px', backgroundColor: '#fffde7', borderRadius: '6px', border: '1px solid #fff9c4', fontSize: '11px', color: '#f57f17' }}>
                            AI 将把此地点识别为：
                            <strong>
                                {editing.type === 'medical' ? '【医疗救助点】仅在病弱或濒危时优先访问' : editing.type === 'gambling' ? '【高风险赌博点】高波动收益' : (editing.cal_cost > 0 && editing.money_cost > 0) ? '【双消耗训练点】同时消耗体力和金币' : (editing.money_cost > 0 && editing.cal_reward > 0) ? '【花钱补体力】消费后恢复体力' : (editing.cal_cost > 0 && editing.money_reward > 0) ? '【消耗体力赚钱】典型打工点' : '【普通活动点】低风险自由行动'}
                            </strong>
                        </div>
                        <div style={{ marginTop: '16px', display: 'flex', justifyContent: 'flex-end', gap: '8px' }}>
                            <button style={btnStyle('#9e9e9e')} onClick={() => setEditing(null)}>取消</button>
                            <button style={btnStyle('#4caf50')} onClick={() => saveDistrict(editing)}><Save size={14} /> 保存</button>
                        </div>
                    </div>
                </div>
            )}

            {editingItem && (
                <div style={{ position: 'fixed', inset: 0, backgroundColor: 'rgba(0,0,0,0.4)', display: 'flex', justifyContent: 'center', alignItems: 'center', zIndex: 9999, padding: '16px', boxSizing: 'border-box' }} onClick={(e) => { if (e.target === e.currentTarget) setEditingItem(null); }}>
                    <div style={{ backgroundColor: '#fff', borderRadius: '16px', padding: '24px', width: '100%', maxWidth: '440px', maxHeight: '80vh', overflowY: 'auto', boxShadow: '0 10px 40px rgba(0,0,0,0.2)', boxSizing: 'border-box' }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
                            <h3 style={{ margin: 0 }}>{editingItem.id ? ('编辑商品：' + editingItem.name) : '新建商品'}</h3>
                            <button onClick={() => setEditingItem(null)} style={{ border: 'none', background: 'none', cursor: 'pointer' }}><X size={20} /></button>
                        </div>
                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
                            <div><label style={labelStyle}>ID</label><input style={inputStyle} value={editingItem.id} onChange={e => setEditingItem(p => ({ ...p, id: e.target.value.toLowerCase().replace(/\s/g, '_') }))} /></div>
                            <div><label style={labelStyle}>名称</label><input style={inputStyle} value={editingItem.name} onChange={e => setEditingItem(p => ({ ...p, name: e.target.value }))} /></div>
                            <div><label style={labelStyle}>Emoji</label><input style={inputStyle} value={editingItem.emoji} onChange={e => setEditingItem(p => ({ ...p, emoji: e.target.value }))} /></div>
                            <div style={{ gridColumn: '1/-1' }}>
                                <label style={labelStyle}>商品模板（先选生活用途，再细调价格和效果）</label>
                                <div style={{ fontSize: '12px', color: '#666', marginBottom: '8px' }}>比如“速食”“正餐”“礼物”“药品”“奢侈品”。选中后会自动带出推荐分类和数值。</div>
                                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(132px, 1fr))', gap: '8px', marginTop: '4px' }}>
                                    {ITEM_TEMPLATES.map((template) => (
                                        <button
                                            key={template.key}
                                            type="button"
                                            onClick={() => applyItemTemplate(template.key)}
                                            style={{
                                                padding: '10px 12px',
                                                borderRadius: '12px',
                                                fontSize: '12px',
                                                fontWeight: '600',
                                                cursor: 'pointer',
                                                textAlign: 'left',
                                                border: getItemTemplateKey(editingItem) === template.key ? '2px solid #2196f3' : '1px solid #ddd',
                                                backgroundColor: getItemTemplateKey(editingItem) === template.key ? '#e3f2fd' : '#fff',
                                                color: getItemTemplateKey(editingItem) === template.key ? '#1565c0' : '#444',
                                                lineHeight: 1.4
                                            }}
                                        >
                                            <div>{template.label}</div>
                                            <div style={{ fontSize: '11px', fontWeight: '400', color: getItemTemplateKey(editingItem) === template.key ? '#1565c0' : '#777', marginTop: '2px' }}>
                                                {template.hint}
                                            </div>
                                        </button>
                                    ))}
                                </div>
                            </div>
                            <div style={{ gridColumn: '1/-1' }}><label style={labelStyle}>描述</label><input style={inputStyle} value={editingItem.description} onChange={e => setEditingItem(p => ({ ...p, description: e.target.value }))} /></div>
                            <div><label style={labelStyle}>购买价格</label><input style={inputStyle} type="number" value={editingItem.buy_price} onChange={e => setEditingItem(p => ({ ...p, buy_price: Number(e.target.value) }))} /></div>
                            <div><label style={labelStyle}>恢复体力</label><input style={inputStyle} type="number" value={editingItem.cal_restore} onChange={e => setEditingItem(p => ({ ...p, cal_restore: Number(e.target.value) }))} /></div>
                            <div><label style={labelStyle}>售卖地点 (分区ID)</label><input style={inputStyle} value={editingItem.sold_at} onChange={e => setEditingItem(p => ({ ...p, sold_at: e.target.value }))} placeholder="如 convenience" /></div>
                            <div><label style={labelStyle}>特殊效果</label><input style={inputStyle} value={editingItem.effect} onChange={e => setEditingItem(p => ({ ...p, effect: e.target.value }))} placeholder="如 affinity+5" /></div>
                            <div><label style={labelStyle}>库存数量 (-1=无限)</label><input style={inputStyle} type="number" value={editingItem.stock ?? -1} onChange={e => setEditingItem(p => ({ ...p, stock: Number(e.target.value) }))} /></div>
                        </div>
                        <div style={{ marginTop: '12px', padding: '8px 12px', backgroundColor: '#f5faff', borderRadius: '6px', border: '1px solid #d9efff', fontSize: '11px', color: '#1e5f8c' }}>
                            当前商品会被理解成：
                            <strong>
                                {editingItem.category === 'food' && editingItem.cal_restore >= 600 ? '【正餐】适合大幅恢复体力' :
                                    editingItem.category === 'food' && editingItem.cal_restore > 0 ? '【轻食 / 饮料】适合小恢复或囤货' :
                                        editingItem.category === 'medicine' ? '【药品】偏恢复或治疗用途' :
                                            editingItem.category === 'gift' && /10/.test(editingItem.effect || '') ? '【高价值礼物】适合表达重视或补偿' :
                                                editingItem.category === 'gift' ? '【礼物】适合社交和送人' :
                                                    editingItem.category === 'tool' ? '【工具】偏功能用途' :
                                                        /quest/i.test(editingItem.effect || '') ? '【任务物品】偏剧情或任务推进' :
                                                            '【通用物品】可继续手动微调'}
                            </strong>
                        </div>
                        <div style={{ marginTop: '16px', display: 'flex', justifyContent: 'flex-end', gap: '8px' }}>
                            <button style={btnStyle('#9e9e9e')} onClick={() => setEditingItem(null)}>取消</button>
                            <button style={btnStyle('#4caf50')} onClick={() => saveItem(editingItem)}><Save size={14} /> 保存</button>
                        </div>
                    </div>
                </div>
            )}

            {giveItemTarget && (
                <div style={{ position: 'fixed', inset: 0, backgroundColor: 'rgba(0,0,0,0.4)', display: 'flex', justifyContent: 'center', alignItems: 'center', zIndex: 9999, padding: '16px', boxSizing: 'border-box' }} onClick={(e) => { if (e.target === e.currentTarget) setGiveItemTarget(null); }}>
                    <div style={{ backgroundColor: '#fff', borderRadius: '16px', padding: '20px', width: '100%', maxWidth: '360px', boxShadow: '0 10px 40px rgba(0,0,0,0.2)', boxSizing: 'border-box' }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
                            <h3 style={{ margin: 0, fontSize: '15px' }}>送物品给 {giveItemTarget.charName}</h3>
                            <button onClick={() => setGiveItemTarget(null)} style={{ border: 'none', background: 'none', cursor: 'pointer' }}><X size={18} /></button>
                        </div>
                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(80px, 1fr))', gap: '8px' }}>
                            {items.map(it => (
                                <button key={it.id} onClick={() => giveItem(giveItemTarget.charId, it.id)} style={{ padding: '10px 4px', border: '1px solid #eee', borderRadius: '8px', backgroundColor: '#fff', cursor: 'pointer', textAlign: 'center', fontSize: '11px' }}>
                                    <div style={{ fontSize: '22px' }}>{it.emoji}</div>
                                    <div>{it.name}</div>
                                </button>
                            ))}
                        </div>
                    </div>
                </div>
            )}

            {viewInventory && (
                <div style={{ position: 'fixed', inset: 0, backgroundColor: 'rgba(0,0,0,0.4)', display: 'flex', justifyContent: 'center', alignItems: 'center', zIndex: 9999, padding: '16px', boxSizing: 'border-box' }} onClick={(e) => { if (e.target === e.currentTarget) setViewInventory(null); }}>
                    <div style={{ backgroundColor: '#fff', borderRadius: '16px', padding: '20px', width: '100%', maxWidth: '400px', maxHeight: '70vh', display: 'flex', flexDirection: 'column', boxShadow: '0 10px 40px rgba(0,0,0,0.2)', boxSizing: 'border-box' }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
                            <h3 style={{ margin: 0, fontSize: '15px', display: 'flex', alignItems: 'center', gap: '6px' }}>背包：{viewInventory.charName}</h3>
                            <button onClick={() => setViewInventory(null)} style={{ border: 'none', background: 'none', cursor: 'pointer' }}><X size={18} /></button>
                        </div>
                        <div style={{ overflowY: 'auto', flex: 1 }}>
                            {viewInventory.inventory.length === 0 ? (
                                <div style={{ textAlign: 'center', padding: '30px 0', color: '#ccc' }}>
                                    <div style={{ fontSize: '36px', marginBottom: '8px' }}>🎒</div>
                                    <div style={{ fontSize: '13px' }}>背包是空的</div>
                                </div>
                            ) : (
                                viewInventory.inventory.map((item, idx) => (
                                    <div key={idx} style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '10px', borderBottom: '1px solid #f0f0f0' }}>
                                        <div style={{ fontSize: '28px', width: '36px', textAlign: 'center', flexShrink: 0 }}>{item.emoji}</div>
                                        <div style={{ flex: 1, minWidth: 0 }}>
                                            <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '2px' }}>
                                                <span style={{ fontWeight: '600', fontSize: '13px' }}>{item.name}</span>
                                                <span style={{ fontSize: '10px', padding: '1px 5px', borderRadius: '3px', backgroundColor: '#f5f5f5', color: '#777' }}>x{item.quantity}</span>
                                                {item.category && <span style={{ fontSize: '9px', padding: '1px 4px', borderRadius: '3px', backgroundColor: item.category === 'food' ? '#e8f5e9' : item.category === 'gift' ? '#fce4ec' : item.category === 'medicine' ? '#e3f2fd' : '#f5f5f5', color: item.category === 'food' ? '#4caf50' : item.category === 'gift' ? '#e91e63' : item.category === 'medicine' ? '#2196f3' : '#999' }}>{item.category === 'food' ? '食物' : item.category === 'gift' ? '礼物' : item.category === 'medicine' ? '药品' : item.category === 'tool' ? '道具' : '杂项'}</span>}
                                            </div>
                                            <div style={{ display: 'flex', gap: '6px', fontSize: '10px', color: '#999' }}>
                                                {item.cal_restore > 0 && <span style={{ color: '#4caf50' }}>+{item.cal_restore}卡</span>}
                                                {item.buy_price > 0 && <span>价值 {item.buy_price}币</span>}
                                            </div>
                                            {item.item_desc && <div style={{ fontSize: '11px', color: '#aaa', marginTop: '2px' }}>{item.item_desc}</div>}
                                        </div>
                                    </div>
                                ))
                            )}
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
