import React, { useState, useEffect, useCallback } from 'react';
import { Plus, Trash2, ToggleLeft, ToggleRight, Save, DollarSign, Heart, Edit3, X, Power, Package, ShoppingBag, AlertTriangle } from 'lucide-react';
import { resolveAvatarUrl } from '../../utils/avatar';

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

const CONFIG_LABELS = {
    dlc_enabled: '🔌 DLC 总开关',
    metabolism_rate: '🔥 基础代谢 (卡/tick)',
    inflation: '📈 通货膨胀倍率',
    work_bonus: '💪 打工奖金倍率',
    gambling_win_rate: '🎰 赌博胜率',
    gambling_payout: '💰 赌博赔率',
    city_self_log_limit: '🧠 记忆获取条数 (自己的记忆)',
    city_social_log_limit: '🗣️ 社交获取条数 (他人的记忆)',
    city_stranger_meet_prob: '🎲 陌生人相遇概率 (%)',
    city_chat_probability: '💬 私聊消息概率',
    city_moment_probability: '📱 发朋友圈概率',
    city_diary_probability: '📓 写日记概率',
    city_memory_probability: '🧠 存记忆概率',
};
const HIDDEN_CONFIG_KEYS = ['dlc_enabled', 'mayor_prompt', 'mayor_enabled', 'mayor_interval_hours', 'mayor_model_char_id', 'mayor_custom_endpoint', 'mayor_custom_key', 'mayor_custom_model', 'city_chat_probability', 'city_moment_probability', 'city_diary_probability', 'city_memory_probability', 'city_self_log_limit', 'city_social_log_limit', 'city_stranger_meet_prob', 'tick_label', 'tick_interval_minutes'];

const EMPTY_DISTRICT = {
    id: '', name: '', emoji: '🏠', type: 'generic', description: '',
    action_label: '访问', cal_cost: 0, cal_reward: 0, money_cost: 0,
    money_reward: 0, duration_ticks: 1, capacity: 0, is_enabled: 1, sort_order: 0
};

const EMPTY_ITEM = {
    id: '', name: '', emoji: '📦', category: 'food', description: '',
    buy_price: 10, sell_price: 0, cal_restore: 0, effect: '', sold_at: '', is_available: 1, sort_order: 0, stock: -1
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
    const token = localStorage.getItem('token');
    const headers = { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' };

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

    useEffect(() => { fetchAll(); }, [fetchAll]);

    const saveDistrict = async (d) => { await fetch(`${apiUrl}/city/districts`, { method: 'POST', headers, body: JSON.stringify(d) }); setEditing(null); fetchAll(); };
    const deleteDistrict = async (id) => { if (!confirm(`确认删除分区 "${id}"？`)) return; await fetch(`${apiUrl}/city/districts/${id}`, { method: 'DELETE', headers }); fetchAll(); };
    const toggleDistrict = async (id) => { await fetch(`${apiUrl}/city/districts/${id}/toggle`, { method: 'PATCH', headers }); fetchAll(); };
    const updateConfig = async (key, value) => { await fetch(`${apiUrl}/city/config`, { method: 'POST', headers, body: JSON.stringify({ key, value }) }); setConfig(prev => ({ ...prev, [key]: value })); };

    const saveItem = async (it) => { await fetch(`${apiUrl}/city/items`, { method: 'POST', headers, body: JSON.stringify(it) }); setEditingItem(null); fetchAll(); };
    const deleteItemAction = async (id) => { if (!confirm(`确认删除商品 "${id}"？`)) return; await fetch(`${apiUrl}/city/items/${id}`, { method: 'DELETE', headers }); fetchAll(); };

    const giveGold = async (charId, charName) => { const a = prompt(`给 ${charName} 发多少金币？`, '100'); if (!a) return; await fetch(`${apiUrl}/city/give-gold`, { method: 'POST', headers, body: JSON.stringify({ characterId: charId, amount: Number(a) }) }); fetchAll(); };
    const feedChar = async (charId, charName) => { const c = prompt(`给 ${charName} 投喂多少卡路里？`, '1000'); if (!c) return; await fetch(`${apiUrl}/city/feed`, { method: 'POST', headers, body: JSON.stringify({ characterId: charId, calories: Number(c) }) }); fetchAll(); };
    const giveItem = async (charId, itemId) => { await fetch(`${apiUrl}/city/give-item`, { method: 'POST', headers, body: JSON.stringify({ characterId: charId, itemId, quantity: 1 }) }); setGiveItemTarget(null); fetchAll(); };
    const deleteEvent = async (id) => { await fetch(`${apiUrl}/city/events/${id}`, { method: 'DELETE', headers }); fetchAll(); };
    const deleteQuest = async (id) => { await fetch(`${apiUrl}/city/quests/${id}`, { method: 'DELETE', headers }); fetchAll(); };

    const clearLogs = async () => { if (!confirm(`确认清空商业街所有动态记录吗？此操作不可逆！`)) return; await fetch(`${apiUrl}/city/logs/clear`, { method: 'DELETE', headers }); setMayorResult(null); fetchAll(); if (onRefreshLogs) onRefreshLogs(); alert('动态记录已清空'); };
    const wipeData = async () => { if (!confirm(`⚠️ 危险操作：确认格式化商业街所有数据（分区、物品、资产、日志）吗？此操作不可逆！`)) return; await fetch(`${apiUrl}/city/data/wipe`, { method: 'DELETE', headers }); setMayorResult(null); setEconomy(null); fetchAll(); if (onRefreshLogs) onRefreshLogs(); alert('商业街数据已彻底格式化'); };

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
        if (!confirm(`确认要将商业街时间快进 ${Math.floor(previewTimeSkipMinutes / 60)}小时${previewTimeSkipMinutes % 60}分钟 吗？\n系统将自动推算这段时间内错过的角色行程！`)) return;

        setIsSkippingTime(true);
        try {
            const res = await fetch(`${apiUrl}/city/time-skip`, {
                method: 'POST',
                headers,
                body: JSON.stringify({ minutes: previewTimeSkipMinutes })
            });
            const data = await res.json();
            if (data.success) {
                alert(`时光飞逝！已快进 ${Math.floor(previewTimeSkipMinutes / 60)}小时，并完成了 ${data.processedTasks || 0} 个历史待办行程的模拟推算。`);
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
        alert('自定义API配置已保存！');
    };

    const dlcEnabled = config.dlc_enabled === '1' || config.dlc_enabled === 'true';
    if (loading) return <div style={{ padding: '20px', textAlign: 'center', color: '#999' }}>加载中...</div>;

    const mayorEnabled = config.mayor_enabled === '1' || config.mayor_enabled === 'true';

    return (
        <div style={{ padding: '16px', maxWidth: '1100px', margin: '0 auto', overflowY: 'auto', height: '100%' }}>

            <div style={{ ...sectionStyle, border: dlcEnabled ? '2px solid #4caf50' : '2px solid #f44336' }}>
                <div style={{ padding: '16px 20px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div>
                        <h3 style={{ margin: 0, fontSize: '16px', display: 'flex', alignItems: 'center', gap: '8px' }}>
                            <Power size={18} color={dlcEnabled ? '#4caf50' : '#f44336'} /> 商业街 DLC 总开关
                        </h3>
                        <p style={{ margin: '4px 0 0', fontSize: '12px', color: '#888' }}>
                            {dlcEnabled ? '✅ 模拟引擎运行中，角色会自主行动并消耗API' : '⏸️ 模拟引擎已暂停，不会消耗API'}
                        </p>
                    </div>
                    <button style={btnStyle(dlcEnabled ? '#f44336' : '#4caf50')} onClick={() => updateConfig('dlc_enabled', dlcEnabled ? '0' : '1')}>
                        {dlcEnabled ? <><ToggleRight size={16} /> 关闭</> : <><ToggleLeft size={16} /> 启用</>}
                    </button>
                </div>
            </div>

            {economy && (
                <div style={{ display: 'flex', gap: '12px', marginBottom: '16px', flexWrap: 'wrap' }}>
                    {[
                        { label: '流通金币', value: `${economy.total_gold_in_circulation?.toFixed(0) || 0} 💰`, color: '#ff9800' },
                        { label: '平均卡路里', value: `${economy.avg_calories || 0} 卡`, color: '#4caf50' },
                        { label: '近1h行动', value: economy.actions_last_hour?.reduce((s, a) => s + a.count, 0) || 0, color: '#2196f3' },
                    ].map(s => (
                        <div key={s.label} style={{ flex: 1, minWidth: '140px', padding: '12px 16px', backgroundColor: '#fff', borderRadius: '10px', boxShadow: '0 1px 6px rgba(0,0,0,0.06)', borderLeft: `4px solid ${s.color}` }}>
                            <div style={{ fontSize: '11px', color: '#999', fontWeight: '600' }}>{s.label}</div>
                            <div style={{ fontSize: '20px', fontWeight: '700', color: s.color, marginTop: '2px' }}>{s.value}</div>
                        </div>
                    ))}
                </div>
            )}

            <div style={sectionStyle}>
                <div style={headerStyle}>
                    <h3 style={{ margin: 0, fontSize: '16px' }}>🗺️ 城市分区</h3>
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
                    <h3 style={{ margin: 0, fontSize: '16px' }}>🛒 商品目录</h3>
                    <button style={btnStyle('#4caf50')} onClick={() => setEditingItem({ ...EMPTY_ITEM })}><Plus size={14} /> 新增商品</button>
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(130px, 1fr))', gap: '8px', padding: '12px' }}>
                    {items.map(it => (
                        <div key={it.id} style={{ padding: '10px', borderRadius: '8px', border: '1px solid #eee', backgroundColor: it.is_available ? '#fff' : '#f9f9f9', opacity: it.is_available ? 1 : 0.5 }}>
                            <div style={{ fontSize: '22px', marginBottom: '2px' }}>{it.emoji}</div>
                            <div style={{ fontWeight: '600', fontSize: '12px' }}>{it.name}</div>
                            <div style={{ fontSize: '10px', color: '#888', marginBottom: '4px' }}>{it.description}</div>
                            <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap', marginBottom: '6px' }}>
                                <span style={{ fontSize: '10px', padding: '1px 5px', borderRadius: '3px', backgroundColor: '#fff3e0', color: '#e65100' }}>{it.buy_price}💰</span>
                                {it.cal_restore > 0 && <span style={{ fontSize: '10px', padding: '1px 5px', borderRadius: '3px', backgroundColor: '#e8f5e9', color: '#4caf50' }}>+{it.cal_restore}卡</span>}
                                {it.sold_at && <span style={{ fontSize: '10px', padding: '1px 5px', borderRadius: '3px', backgroundColor: '#e3f2fd', color: '#1565c0' }}>📍{it.sold_at}</span>}
                                <span style={{ fontSize: '10px', padding: '1px 5px', borderRadius: '3px', backgroundColor: it.stock === -1 ? '#f5f5f5' : it.stock <= 0 ? '#ffcdd2' : it.stock <= 3 ? '#fff3e0' : '#e8f5e9', color: it.stock === -1 ? '#999' : it.stock <= 0 ? '#c62828' : it.stock <= 3 ? '#e65100' : '#2e7d32' }}>{it.stock === -1 ? '∞' : it.stock <= 0 ? '售罄' : `库存${it.stock}`}</span>
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
                    <h3 style={{ margin: 0, fontSize: '16px' }}>⚙️ 经济调控</h3>
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
                    <h3 style={{ margin: 0, fontSize: '16px' }}>🏠↔️💬 城市→聊天桥接</h3>
                </div>
                <div style={{ padding: '16px', display: 'flex', flexDirection: 'column', gap: '16px' }}>
                    <div>
                        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '13px', marginBottom: '6px' }}>
                            <span>💬 私聊消息概率</span>
                            <span style={{ fontWeight: '600', color: '#2196f3' }}>{config.city_chat_probability || '0'}%</span>
                        </div>
                        <input type="range" min="0" max="100" value={parseInt(config.city_chat_probability) || 0}
                            onChange={e => updateConfig('city_chat_probability', e.target.value)}
                            style={{ width: '100%' }} />
                        <div style={{ fontSize: '10px', color: '#999', marginTop: '4px' }}>
                            角色在商业街遇到有趣事件时，主动给你发私聊消息的概率。需要同时在角色设置中开启「🏢 商业街动态消息」开关。
                        </div>
                    </div>
                    <div>
                        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '13px', marginBottom: '6px' }}>
                            <span>📱 发朋友圈概率</span>
                            <span style={{ fontWeight: '600', color: '#4caf50' }}>{config.city_moment_probability || '30'}%</span>
                        </div>
                        <input type="range" min="0" max="100" value={parseInt(config.city_moment_probability) || 30}
                            onChange={e => updateConfig('city_moment_probability', e.target.value)}
                            style={{ width: '100%' }} />
                        <div style={{ fontSize: '10px', color: '#999', marginTop: '4px' }}>
                            角色在商业街经历有趣事件后，自动发朋友圈的概率。
                        </div>
                    </div>
                    <div>
                        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '13px', marginBottom: '6px' }}>
                            <span>📓 写日记概率</span>
                            <span style={{ fontWeight: '600', color: '#ff9800' }}>{config.city_diary_probability || '100'}%</span>
                        </div>
                        <input type="range" min="0" max="100" value={parseInt(config.city_diary_probability) || 100}
                            onChange={e => updateConfig('city_diary_probability', e.target.value)}
                            style={{ width: '100%' }} />
                        <div style={{ fontSize: '10px', color: '#999', marginTop: '4px' }}>
                            角色在商业街经历有趣事件后写日记的概率。日记仅角色自己可见。
                        </div>
                    </div>
                    <div>
                        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '13px', marginBottom: '6px' }}>
                            <span>🧠 存记忆概率</span>
                            <span style={{ fontWeight: '600', color: '#9c27b0' }}>{config.city_memory_probability || '100'}%</span>
                        </div>
                        <input type="range" min="0" max="100" value={parseInt(config.city_memory_probability) || 100}
                            onChange={e => updateConfig('city_memory_probability', e.target.value)}
                            style={{ width: '100%' }} />
                        <div style={{ fontSize: '10px', color: '#999', marginTop: '4px' }}>
                            将商业街事件存入角色长期记忆的概率。影响角色在聊天时是否能回忆起这些经历。
                        </div>
                    </div>
                    <div style={{ fontSize: '11px', color: '#888', padding: '8px', backgroundColor: '#f9f9f9', borderRadius: '6px', lineHeight: 1.6 }}>
                        � 提示：私聊消息还需要在角色设置中开启「🏢 商业街动态消息」开关。其他三个渠道（朋友圈/日记/记忆）只由全局概率控制。
                    </div>
                </div>
            </div>

            <div style={sectionStyle}>
                <div style={headerStyle}>
                    <h3 style={{ margin: 0, fontSize: '16px' }}>⚙️ 记忆与社交控制</h3>
                </div>
                <div style={{ padding: '16px', display: 'flex', flexDirection: 'column', gap: '16px' }}>
                    <div>
                        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '13px', marginBottom: '6px' }}>
                            <span>🧠 本人记忆获取上限</span>
                            <span style={{ fontWeight: '600', color: '#2196f3' }}>{config.city_self_log_limit || '5'} 条</span>
                        </div>
                        <input type="range" min="0" max="20" value={parseInt(config.city_self_log_limit) || 5}
                            onChange={e => updateConfig('city_self_log_limit', e.target.value)}
                            style={{ width: '100%' }} />
                        <div style={{ fontSize: '10px', color: '#999', marginTop: '4px' }}>
                            决定AI行动时，最多往Prompt里塞几条自己"今天"的动态。设太大烧Token，设太小容易失忆。
                        </div>
                    </div>
                    <div>
                        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '13px', marginBottom: '6px' }}>
                            <span>🗣️ 熟人情报获取上限</span>
                            <span style={{ fontWeight: '600', color: '#4caf50' }}>{config.city_social_log_limit || '3'} 条</span>
                        </div>
                        <input type="range" min="0" max="20" value={parseInt(config.city_social_log_limit) || 3}
                            onChange={e => updateConfig('city_social_log_limit', e.target.value)}
                            style={{ width: '100%' }} />
                        <div style={{ fontSize: '10px', color: '#999', marginTop: '4px' }}>
                            当两个熟人碰面时，互相能看到对方在当前地点"今天"留下的几条记录。用于制造"我知道你刚才干嘛了"的偶遇感。
                        </div>
                    </div>
                    <div>
                        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '13px', marginBottom: '6px' }}>
                            <span>🎲 陌生人相遇概率</span>
                            <span style={{ fontWeight: '600', color: '#ff9800' }}>{config.city_stranger_meet_prob || '20'}%</span>
                        </div>
                        <input type="range" min="0" max="100" step="5" value={parseInt(config.city_stranger_meet_prob) || 20}
                            onChange={e => updateConfig('city_stranger_meet_prob', e.target.value)}
                            style={{ width: '100%' }} />
                        <div style={{ fontSize: '10px', color: '#999', marginTop: '4px' }}>
                            两个非好友/无共同群聊的陌生角色在同地点相遇时，触发攀谈认识的概率。设置100%则每次同地必相识。
                        </div>
                    </div>
                </div>
            </div>

            <div style={sectionStyle}>
                <div style={headerStyle}>
                    <h3 style={{ margin: 0, fontSize: '16px' }}>⏳ 虚拟时钟 (Virtual Clock)</h3>
                </div>
                <div style={{ padding: '16px', display: 'flex', flexDirection: 'column', gap: '16px' }}>
                    <div style={{ fontSize: '11px', color: '#888', backgroundColor: '#f9f9f9', padding: '10px', borderRadius: '6px', lineHeight: 1.6 }}>
                        💡 偏离现实时间的设定。如果跨越了早上 6 点，系统会在下一次 Tick 强制重新生成当天的行程表。
                    </div>

                    {(() => {
                        const now = new Date();
                        const currentDaysOffset = parseInt(config.city_time_offset_days) || 0;
                        const currentHoursOffset = parseInt(config.city_time_offset_hours) || 0;
                        now.setDate(now.getDate() + currentDaysOffset);
                        now.setHours(now.getHours() + currentHoursOffset);

                        const currentStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

                        // Preview date based on slider
                        now.setMinutes(now.getMinutes() + previewTimeSkipMinutes);
                        const previewStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

                        return (
                            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', background: '#e3f2fd', padding: '8px 12px', borderRadius: '6px' }}>
                                    <span style={{ fontSize: '12px', color: '#1565c0', fontWeight: 'bold' }}>🕒 当前商业街时间映射：</span>
                                    <span style={{ fontSize: '14px', fontFamily: 'monospace', color: '#000', fontWeight: 'bold', letterSpacing: '0.5px' }}>{currentStr}</span>
                                </div>
                                {previewTimeSkipMinutes > 0 && (
                                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', background: '#fff9c4', padding: '8px 12px', borderRadius: '6px', border: '1px dashed #fbc02d' }}>
                                        <span style={{ fontSize: '12px', color: '#f57f17', fontWeight: 'bold' }}>🚀 飞跃后目标时间预览：</span>
                                        <span style={{ fontSize: '14px', fontFamily: 'monospace', color: '#f57f17', fontWeight: 'bold', letterSpacing: '0.5px' }}>{previewStr}</span>
                                    </div>
                                )}
                            </div>
                        );
                    })()}

                    <div>
                        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '13px', marginBottom: '6px' }}>
                            <span>⏩ 准备快进 (Forward Time Skip)</span>
                            <span style={{ fontWeight: '600', color: '#f57f17' }}>
                                +{Math.floor(previewTimeSkipMinutes / 60)}小时 {previewTimeSkipMinutes % 60}分钟
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
                        {isSkippingTime ? <><ShoppingBag size={16} className="spin" style={{ animation: 'spin 2s linear infinite' }} /> 正在推算角色错过的日程，请稍候...</> : <><ToggleRight size={16} /> 确认并推算 (Confirm & Simulate)</>}
                    </button>
                    <style>{`@keyframes spin { 100% { transform: rotate(360deg); } }`}</style>
                </div>
            </div>

            <div style={{ ...sectionStyle, border: `2px solid ${mayorEnabled ? '#9c27b0' : '#ccc'}` }}>
                <div style={{ ...headerStyle, background: mayorEnabled ? 'linear-gradient(to right, #f3e5f5, #fff)' : '#f9f9f9' }}>
                    <h3 style={{ margin: 0, fontSize: '16px', display: 'flex', alignItems: 'center', gap: '8px' }}>
                        🏛️ 市长AI (The Mayor)
                    </h3>
                    <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                        <button style={btnStyle(mayorEnabled ? '#f44336' : '#4caf50')} onClick={() => updateConfig('mayor_enabled', mayorEnabled ? '0' : '1')}>
                            {mayorEnabled ? <><ToggleRight size={14} /> 关闭市长</> : <><ToggleLeft size={14} /> 启用市长</>}
                        </button>
                        <button style={btnStyle(mayorRunning ? '#9e9e9e' : '#9c27b0')} onClick={runMayor} disabled={mayorRunning}>
                            {mayorRunning ? '⏳ 决策中...' : '🎯 手动执行'}
                        </button>
                    </div>
                </div>
                <div style={{ padding: '16px' }}>
                    <p style={{ margin: '0 0 12px', fontSize: '12px', color: '#888' }}>
                        {mayorEnabled ? '✅ 市长AI已启用，每隔' + (config.mayor_interval_hours || '6') + '小时自动做一次决策' : '⏸️ 市长AI已暂停，不会自动执行'}
                    </p>
                    <div style={{ display: 'flex', gap: '12px', marginBottom: '12px', alignItems: 'center' }}>
                        <label style={{ ...labelStyle, margin: 0, whiteSpace: 'nowrap' }}>⏰ 决策间隔</label>
                        <input style={{ ...inputStyle, width: '80px' }} type="number" min="1" defaultValue={config.mayor_interval_hours || '6'}
                            onBlur={e => updateConfig('mayor_interval_hours', e.target.value)} />
                        <span style={{ fontSize: '12px', color: '#999' }}>小时/次</span>
                    </div>
                    <div style={{ marginBottom: '12px' }}>
                        <label style={labelStyle}>🤖 市长使用的AI模型</label>
                        <select style={inputStyle} value={mayorModelMode} onChange={e => saveMayorModel(e.target.value)}>
                            <option value="auto">🔄 自动选择（第一个有API的角色）</option>
                            {characters.filter(c => c.api_endpoint).map(c => (
                                <option key={c.id} value={c.id}>👤 {c.name} — {c.model_name || '未知模型'}</option>
                            ))}
                            <option value="custom">✏️ 手动填写API接口</option>
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
                        <label style={labelStyle}>📝 市长Prompt（决定市长AI的行为方式，可自由修改）</label>
                        <textarea
                            style={{ ...inputStyle, height: '120px', fontFamily: 'monospace', fontSize: '12px', resize: 'vertical' }}
                            value={mayorPromptLocal}
                            onChange={e => setMayorPromptLocal(e.target.value)}
                        />
                        <button style={{ ...btnStyle('#9c27b0'), marginTop: '6px' }} onClick={saveMayorPrompt}>
                            <Save size={12} /> 保存Prompt
                        </button>
                    </div>
                    {mayorResult && (
                        <div style={{ padding: '10px', backgroundColor: mayorResult.success ? '#e8f5e9' : '#ffebee', borderRadius: '8px', fontSize: '12px', marginBottom: '10px' }}>
                            {mayorResult.success ? (
                                <div>
                                    ✅ 决策完成！{mayorResult.results?.price_changes || 0}个调价 · {mayorResult.results?.events || 0}个事件 · {mayorResult.results?.quests || 0}个任务
                                    {mayorResult.fallback && <span style={{ color: '#ff9800' }}> (规则生成)</span>}
                                    {mayorResult.results?.announcement && <div style={{ marginTop: '4px', fontStyle: 'italic' }}>📢 {mayorResult.results.announcement}</div>}
                                </div>
                            ) : <div>❌ {mayorResult.reason || mayorResult.error || '失败'}</div>}
                        </div>
                    )}
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '12px' }}>
                        <div style={{ flex: '1 1 280px' }}>
                            <div style={{ fontWeight: '600', fontSize: '13px', marginBottom: '6px' }}>📢 活跃事件 ({events.length})</div>
                            {events.length === 0 ? <div style={{ fontSize: '11px', color: '#bbb' }}>暂无事件</div> : events.map(e => (
                                <div key={e.id} style={{ padding: '6px', border: '1px solid #eee', borderRadius: '6px', marginBottom: '4px', fontSize: '11px', display: 'flex', alignItems: 'flex-start', gap: '6px' }}>
                                    <div style={{ flex: 1 }}>
                                        <span>{e.emoji} <b>{e.title}</b></span>
                                        <div style={{ color: '#888' }}>{e.description}</div>
                                        <div style={{ color: '#aaa', fontSize: '10px' }}>剩余 {Math.max(0, Math.round((e.expires_at - Date.now()) / 3600000))}h</div>
                                    </div>
                                    <button onClick={() => deleteEvent(e.id)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#ccc', padding: '2px', fontSize: '12px', lineHeight: 1, flexShrink: 0 }} title="删除事件">✕</button>
                                </div>
                            ))}
                        </div>
                        <div style={{ flex: '1 1 280px' }}>
                            <div style={{ fontWeight: '600', fontSize: '13px', marginBottom: '6px' }}>📜 悬赏任务 ({quests.length})</div>
                            {quests.length === 0 ? <div style={{ fontSize: '11px', color: '#bbb' }}>暂无任务</div> : quests.map(q => (
                                <div key={q.id} style={{ padding: '6px', border: '1px solid #eee', borderRadius: '6px', marginBottom: '4px', fontSize: '11px', display: 'flex', alignItems: 'flex-start', gap: '6px' }}>
                                    <div style={{ flex: 1 }}>
                                        <span>{q.emoji} <b>{q.title}</b> <span style={{ color: '#ff9800' }}>({q.difficulty})</span></span>
                                        <div style={{ color: '#888' }}>{q.description}</div>
                                        <div style={{ color: '#4caf50', fontSize: '10px' }}>奖励: {q.reward_gold}💰 {q.reward_cal > 0 ? `${q.reward_cal}卡` : ''}{q.claimed_by ? ` · 已被领取` : ''}</div>
                                    </div>
                                    <button onClick={() => deleteQuest(q.id)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#ccc', padding: '2px', fontSize: '12px', lineHeight: 1, flexShrink: 0 }} title="删除任务">✕</button>
                                </div>
                            ))}
                        </div>
                    </div>
                </div>
            </div>

            <div style={sectionStyle}>
                <div style={headerStyle}>
                    <h3 style={{ margin: 0, fontSize: '16px' }}>👑 管理员操作</h3>
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: '8px', padding: '12px' }}>
                    {characters.map(c => (
                        <div key={c.id} style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '8px', border: '1px solid #eee', borderRadius: '8px' }}>
                            <img src={avatarSrc(c.avatar, apiUrl)} alt="" style={{ width: '28px', height: '28px', borderRadius: '50%', objectFit: 'cover' }} />
                            <div style={{ flex: 1, minWidth: 0 }}>
                                <div style={{ fontWeight: '500', fontSize: '12px' }}>{c.name}</div>
                                <div style={{ fontSize: '10px', color: '#999' }}>{(c.wallet || 0).toFixed(0)}币 · {c.calories}卡 · <span onClick={(e) => { e.stopPropagation(); setViewInventory({ charName: c.name, inventory: c.inventory || [] }); }} style={{ cursor: 'pointer', color: (c.inventory || []).length > 0 ? 'var(--accent-color, #2196f3)' : '#999', textDecoration: (c.inventory || []).length > 0 ? 'underline' : 'none' }}>🎒背包{(c.inventory || []).length}件</span></div>
                                <div style={{ display: 'flex', gap: '6px', marginTop: '2px' }}>
                                    <span style={{ fontSize: '9px', padding: '1px 4px', borderRadius: '3px', backgroundColor: '#e3f2fd', color: '#1565c0' }}>🧠{c.stat_int ?? 50}</span>
                                    <span style={{ fontSize: '9px', padding: '1px 4px', borderRadius: '3px', backgroundColor: '#e8f5e9', color: '#2e7d32' }}>💪{c.stat_sta ?? 50}</span>
                                    <span style={{ fontSize: '9px', padding: '1px 4px', borderRadius: '3px', backgroundColor: '#fce4ec', color: '#c62828' }}>✨{c.stat_cha ?? 50}</span>
                                </div>
                            </div>
                            <button onClick={() => giveGold(c.id, c.name)} style={{ ...btnStyle('#ff9800'), padding: '3px 6px', fontSize: '10px' }} title="发金币"><DollarSign size={10} /></button>
                            <button onClick={() => feedChar(c.id, c.name)} style={{ ...btnStyle('#4caf50'), padding: '3px 6px', fontSize: '10px' }} title="投喂"><Heart size={10} /></button>
                            <button onClick={() => setGiveItemTarget({ charId: c.id, charName: c.name })} style={{ ...btnStyle('#9c27b0'), padding: '3px 6px', fontSize: '10px' }} title="送物品"><Package size={10} /></button>
                        </div>
                    ))}
                </div>
                <div style={{ marginTop: '16px', padding: '16px', borderTop: '1px dashed #ddd', backgroundColor: '#fff5f5' }}>
                    <h4 style={{ margin: '0 0 12px 0', fontSize: '14px', color: '#d32f2f' }}>⚠️ 危险操作 (全局记录与数据清理)</h4>
                    <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap' }}>
                        <button onClick={clearLogs} style={{ ...btnStyle('#ff9800'), padding: '8px 16px' }}>
                            <Trash2 size={16} style={{ marginRight: '6px' }} /> 清空市长/角色动态日志
                        </button>
                        <button onClick={wipeData} style={{ ...btnStyle('#d32f2f'), padding: '8px 16px' }}>
                            <AlertTriangle size={16} style={{ marginRight: '6px' }} /> 彻底格式化商业街所有数据
                        </button>
                    </div>
                </div>
            </div>

            {
                editing && (
                    <div style={{ position: 'fixed', inset: 0, backgroundColor: 'rgba(0,0,0,0.4)', display: 'flex', justifyContent: 'center', alignItems: 'center', zIndex: 9999, padding: '16px', boxSizing: 'border-box' }} onClick={(e) => { if (e.target === e.currentTarget) setEditing(null); }}>
                        <div style={{ backgroundColor: '#fff', borderRadius: '16px', padding: '24px', width: '100%', maxWidth: '480px', maxHeight: '80vh', overflowY: 'auto', boxShadow: '0 10px 40px rgba(0,0,0,0.2)', boxSizing: 'border-box' }}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
                                <h3 style={{ margin: 0 }}>{editing.id ? `编辑：${editing.name}` : '新建分区'}</h3>
                                <button onClick={() => setEditing(null)} style={{ border: 'none', background: 'none', cursor: 'pointer' }}><X size={20} /></button>
                            </div>
                            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
                                <div><label style={labelStyle}>ID</label><input style={inputStyle} value={editing.id} onChange={e => setEditing(p => ({ ...p, id: e.target.value.toLowerCase().replace(/\s/g, '_') }))} /></div>
                                <div><label style={labelStyle}>名称</label><input style={inputStyle} value={editing.name} onChange={e => setEditing(p => ({ ...p, name: e.target.value }))} /></div>
                                <div><label style={labelStyle}>Emoji</label><input style={inputStyle} value={editing.emoji} onChange={e => setEditing(p => ({ ...p, emoji: e.target.value }))} /></div>
                                <div style={{ gridColumn: '1/-1' }}>
                                    <label style={labelStyle}>功能原型 (决定AI如何理解这个地点)</label>
                                    <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', marginTop: '4px' }}>
                                        {[['work', '🏭 工作'], ['food', '🍜 餐饮'], ['rest', '🏠 休息'], ['leisure', '🌳 休闲'], ['shopping', '🛒 购物'], ['education', '📚 教育'], ['medical', '🏥 医疗'], ['gambling', '🎰 赌博'], ['wander', '🚶 闲逛'], ['generic', '📍 通用']].map(([v, l]) => (
                                            <button key={v} type="button" onClick={() => setEditing(p => ({ ...p, type: v }))}
                                                style={{
                                                    padding: '5px 10px', borderRadius: '16px', fontSize: '12px', fontWeight: '500', cursor: 'pointer',
                                                    border: editing.type === v ? '2px solid #2196f3' : '1px solid #ddd',
                                                    backgroundColor: editing.type === v ? '#e3f2fd' : '#fff',
                                                    color: editing.type === v ? '#1565c0' : '#666',
                                                    transition: 'all 0.15s'
                                                }}>
                                                {l}
                                            </button>
                                        ))}
                                    </div>
                                </div>
                                <div style={{ gridColumn: '1/-1' }}><label style={labelStyle}>描述</label><input style={inputStyle} value={editing.description} onChange={e => setEditing(p => ({ ...p, description: e.target.value }))} /></div>
                                <div><label style={labelStyle}>行动标签</label><input style={inputStyle} value={editing.action_label} onChange={e => setEditing(p => ({ ...p, action_label: e.target.value }))} /></div>
                                <div><label style={labelStyle}>排序</label><input style={inputStyle} type="number" value={editing.sort_order} onChange={e => setEditing(p => ({ ...p, sort_order: Number(e.target.value) }))} /></div>
                            </div>

                            {/* Resource Sliders */}
                            <div style={{ marginTop: '14px', padding: '12px', backgroundColor: '#f8f9fa', borderRadius: '8px', border: '1px solid #eee' }}>
                                <div style={{ fontSize: '12px', fontWeight: '600', color: '#555', marginBottom: '10px' }}>⚡ 资源消耗/产出 (滑杆调节)</div>
                                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
                                    <div>
                                        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11px', color: '#f44336', marginBottom: '4px' }}>
                                            <span>🔥 消耗体力</span><span style={{ fontWeight: '700' }}>{editing.cal_cost}</span>
                                        </div>
                                        <input type="range" min="0" max="500" step="10" value={editing.cal_cost} onChange={e => setEditing(p => ({ ...p, cal_cost: Number(e.target.value) }))} style={{ width: '100%' }} />
                                    </div>
                                    <div>
                                        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11px', color: '#4caf50', marginBottom: '4px' }}>
                                            <span>💚 恢复体力</span><span style={{ fontWeight: '700' }}>{editing.cal_reward}</span>
                                        </div>
                                        <input type="range" min="0" max="1000" step="10" value={editing.cal_reward} onChange={e => setEditing(p => ({ ...p, cal_reward: Number(e.target.value) }))} style={{ width: '100%' }} />
                                    </div>
                                    <div>
                                        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11px', color: '#e65100', marginBottom: '4px' }}>
                                            <span>💸 消耗金币</span><span style={{ fontWeight: '700' }}>{editing.money_cost}</span>
                                        </div>
                                        <input type="range" min="0" max="500" step="5" value={editing.money_cost} onChange={e => setEditing(p => ({ ...p, money_cost: Number(e.target.value) }))} style={{ width: '100%' }} />
                                    </div>
                                    <div>
                                        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11px', color: '#2e7d32', marginBottom: '4px' }}>
                                            <span>💰 获得金币</span><span style={{ fontWeight: '700' }}>{editing.money_reward}</span>
                                        </div>
                                        <input type="range" min="0" max="500" step="5" value={editing.money_reward} onChange={e => setEditing(p => ({ ...p, money_reward: Number(e.target.value) }))} style={{ width: '100%' }} />
                                    </div>
                                </div>
                            </div>

                            {/* Duration & Capacity */}
                            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px', marginTop: '10px' }}>
                                <div>
                                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11px', color: '#666', marginBottom: '4px' }}>
                                        <span>⏱️ 持续tick</span><span style={{ fontWeight: '700' }}>{editing.duration_ticks}</span>
                                    </div>
                                    <input type="range" min="1" max="10" value={editing.duration_ticks} onChange={e => setEditing(p => ({ ...p, duration_ticks: Number(e.target.value) }))} style={{ width: '100%' }} />
                                </div>
                                <div>
                                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11px', color: '#666', marginBottom: '4px' }}>
                                        <span>👥 容量 (0=无限)</span><span style={{ fontWeight: '700' }}>{editing.capacity}</span>
                                    </div>
                                    <input type="range" min="0" max="50" value={editing.capacity} onChange={e => setEditing(p => ({ ...p, capacity: Number(e.target.value) }))} style={{ width: '100%' }} />
                                </div>
                            </div>

                            {/* AI Classification Preview */}
                            <div style={{ marginTop: '12px', padding: '8px 12px', backgroundColor: '#fffde7', borderRadius: '6px', border: '1px solid #fff9c4', fontSize: '11px', color: '#f57f17' }}>
                                🤖 AI将把此地点识别为：<strong>{
                                    editing.type === 'medical' ? '【医疗救助点】仅限病态/晕倒时访问'
                                        : editing.type === 'gambling' ? '【无保护熵增点】高风险赌博'
                                            : (editing.cal_cost > 0 && editing.money_cost > 0) ? '【属性训练点】(双扣型)'
                                                : (editing.money_cost > 0 && editing.cal_reward > 0) ? '【能量补给点】(花钱补体力)'
                                                    : (editing.cal_cost > 0 && editing.money_reward > 0) ? '【资金产出点】(消耗体力赚钱)'
                                                        : '【纯粹漫游点】(零收益闲逛)'
                                }</strong>
                            </div>

                            <div style={{ marginTop: '16px', display: 'flex', justifyContent: 'flex-end', gap: '8px' }}>
                                <button style={btnStyle('#9e9e9e')} onClick={() => setEditing(null)}>取消</button>
                                <button style={btnStyle('#4caf50')} onClick={() => saveDistrict(editing)}><Save size={14} /> 保存</button>
                            </div>
                        </div>
                    </div>
                )
            }

            {
                editingItem && (
                    <div style={{ position: 'fixed', inset: 0, backgroundColor: 'rgba(0,0,0,0.4)', display: 'flex', justifyContent: 'center', alignItems: 'center', zIndex: 9999, padding: '16px', boxSizing: 'border-box' }} onClick={(e) => { if (e.target === e.currentTarget) setEditingItem(null); }}>
                        <div style={{ backgroundColor: '#fff', borderRadius: '16px', padding: '24px', width: '100%', maxWidth: '440px', maxHeight: '80vh', overflowY: 'auto', boxShadow: '0 10px 40px rgba(0,0,0,0.2)', boxSizing: 'border-box' }}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
                                <h3 style={{ margin: 0 }}>{editingItem.id ? `编辑商品：${editingItem.name}` : '新建商品'}</h3>
                                <button onClick={() => setEditingItem(null)} style={{ border: 'none', background: 'none', cursor: 'pointer' }}><X size={20} /></button>
                            </div>
                            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
                                <div><label style={labelStyle}>ID</label><input style={inputStyle} value={editingItem.id} onChange={e => setEditingItem(p => ({ ...p, id: e.target.value.toLowerCase().replace(/\s/g, '_') }))} /></div>
                                <div><label style={labelStyle}>名称</label><input style={inputStyle} value={editingItem.name} onChange={e => setEditingItem(p => ({ ...p, name: e.target.value }))} /></div>
                                <div><label style={labelStyle}>Emoji</label><input style={inputStyle} value={editingItem.emoji} onChange={e => setEditingItem(p => ({ ...p, emoji: e.target.value }))} /></div>
                                <div><label style={labelStyle}>分类</label>
                                    <select style={inputStyle} value={editingItem.category} onChange={e => setEditingItem(p => ({ ...p, category: e.target.value }))}>
                                        {[['food', '食物'], ['gift', '礼物'], ['medicine', '药品'], ['tool', '道具'], ['misc', '杂货']].map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                                    </select>
                                </div>
                                <div style={{ gridColumn: '1/-1' }}><label style={labelStyle}>描述</label><input style={inputStyle} value={editingItem.description} onChange={e => setEditingItem(p => ({ ...p, description: e.target.value }))} /></div>
                                <div><label style={labelStyle}>购买价格</label><input style={inputStyle} type="number" value={editingItem.buy_price} onChange={e => setEditingItem(p => ({ ...p, buy_price: Number(e.target.value) }))} /></div>
                                <div><label style={labelStyle}>恢复卡路里</label><input style={inputStyle} type="number" value={editingItem.cal_restore} onChange={e => setEditingItem(p => ({ ...p, cal_restore: Number(e.target.value) }))} /></div>
                                <div><label style={labelStyle}>售卖地点(分区ID)</label><input style={inputStyle} value={editingItem.sold_at} onChange={e => setEditingItem(p => ({ ...p, sold_at: e.target.value }))} placeholder="如: convenience" /></div>
                                <div><label style={labelStyle}>特殊效果</label><input style={inputStyle} value={editingItem.effect} onChange={e => setEditingItem(p => ({ ...p, effect: e.target.value }))} placeholder="如: affinity+5" /></div>
                                <div><label style={labelStyle}>库存数量 (-1=无限)</label><input style={inputStyle} type="number" value={editingItem.stock ?? -1} onChange={e => setEditingItem(p => ({ ...p, stock: Number(e.target.value) }))} /></div>
                            </div>
                            <div style={{ marginTop: '16px', display: 'flex', justifyContent: 'flex-end', gap: '8px' }}>
                                <button style={btnStyle('#9e9e9e')} onClick={() => setEditingItem(null)}>取消</button>
                                <button style={btnStyle('#4caf50')} onClick={() => saveItem(editingItem)}><Save size={14} /> 保存</button>
                            </div>
                        </div>
                    </div>
                )
            }

            {
                giveItemTarget && (
                    <div style={{ position: 'fixed', inset: 0, backgroundColor: 'rgba(0,0,0,0.4)', display: 'flex', justifyContent: 'center', alignItems: 'center', zIndex: 9999, padding: '16px', boxSizing: 'border-box' }} onClick={(e) => { if (e.target === e.currentTarget) setGiveItemTarget(null); }}>
                        <div style={{ backgroundColor: '#fff', borderRadius: '16px', padding: '20px', width: '100%', maxWidth: '360px', boxShadow: '0 10px 40px rgba(0,0,0,0.2)', boxSizing: 'border-box' }}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
                                <h3 style={{ margin: 0, fontSize: '15px' }}>送物品给 {giveItemTarget.charName}</h3>
                                <button onClick={() => setGiveItemTarget(null)} style={{ border: 'none', background: 'none', cursor: 'pointer' }}><X size={18} /></button>
                            </div>
                            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(80px, 1fr))', gap: '8px' }}>
                                {items.map(it => (
                                    <button key={it.id} onClick={() => giveItem(giveItemTarget.charId, it.id)}
                                        style={{ padding: '10px 4px', border: '1px solid #eee', borderRadius: '8px', backgroundColor: '#fff', cursor: 'pointer', textAlign: 'center', fontSize: '11px' }}>
                                        <div style={{ fontSize: '22px' }}>{it.emoji}</div>
                                        <div>{it.name}</div>
                                    </button>
                                ))}
                            </div>
                        </div>
                    </div>
                )
            }
            {
                viewInventory && (
                    <div style={{ position: 'fixed', inset: 0, backgroundColor: 'rgba(0,0,0,0.4)', display: 'flex', justifyContent: 'center', alignItems: 'center', zIndex: 9999, padding: '16px', boxSizing: 'border-box' }} onClick={(e) => { if (e.target === e.currentTarget) setViewInventory(null); }}>
                        <div style={{ backgroundColor: '#fff', borderRadius: '16px', padding: '20px', width: '100%', maxWidth: '400px', maxHeight: '70vh', display: 'flex', flexDirection: 'column', boxShadow: '0 10px 40px rgba(0,0,0,0.2)', boxSizing: 'border-box' }}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
                                <h3 style={{ margin: 0, fontSize: '15px', display: 'flex', alignItems: 'center', gap: '6px' }}>
                                    🎒 {viewInventory.charName} 的背包
                                </h3>
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
                                                    <span style={{ fontSize: '10px', padding: '1px 5px', borderRadius: '3px', backgroundColor: '#f5f5f5', color: '#777' }}>×{item.quantity}</span>
                                                    {item.category && <span style={{ fontSize: '9px', padding: '1px 4px', borderRadius: '3px', backgroundColor: item.category === 'food' ? '#e8f5e9' : item.category === 'gift' ? '#fce4ec' : item.category === 'medicine' ? '#e3f2fd' : '#f5f5f5', color: item.category === 'food' ? '#4caf50' : item.category === 'gift' ? '#e91e63' : item.category === 'medicine' ? '#2196f3' : '#999' }}>{item.category === 'food' ? '食物' : item.category === 'gift' ? '礼物' : item.category === 'medicine' ? '药品' : item.category === 'tool' ? '道具' : '杂货'}</span>}
                                                </div>
                                                <div style={{ display: 'flex', gap: '6px', fontSize: '10px', color: '#999' }}>
                                                    {item.cal_restore > 0 && <span style={{ color: '#4caf50' }}>+{item.cal_restore}卡</span>}
                                                    {item.buy_price > 0 && <span>价值{item.buy_price}💰</span>}
                                                </div>
                                                {item.item_desc && <div style={{ fontSize: '11px', color: '#aaa', marginTop: '2px' }}>{item.item_desc}</div>}
                                            </div>
                                        </div>
                                    ))
                                )}
                            </div>
                        </div>
                    </div>
                )
            }
        </div >
    );
}

