import React, { useState, useEffect } from 'react';
import { Store, Briefcase, Coffee, Moon, Activity, AlertCircle, Settings, Package, ChevronDown, ChevronRight } from 'lucide-react';
import CityManager from './CityManager';
import { resolveAvatarUrl } from '../../utils/avatar';

const FALLBACK_AVATAR = 'https://api.dicebear.com/7.x/shapes/svg?seed=User';
const avatarSrc = (url, apiUrl) => resolveAvatarUrl(url, apiUrl) || FALLBACK_AVATAR;

const TAB_STYLE = (active) => ({
    padding: '8px 18px', border: 'none', borderBottom: active ? '2px solid #ff9800' : '2px solid transparent',
    backgroundColor: 'transparent', color: active ? '#ff9800' : '#888', cursor: 'pointer',
    fontSize: '14px', fontWeight: active ? '600' : '400', transition: 'all 0.2s'
});

export default function CityLog({ apiUrl, userProfile }) {
    const [tab, setTab] = useState('feed');
    const [logs, setLogs] = useState([]);
    const [characters, setCharacters] = useState([]);
    const [loading, setLoading] = useState(true);
    const [expandedBag, setExpandedBag] = useState(null); // charId or null
    const [collapsedDates, setCollapsedDates] = useState({});
    const token = localStorage.getItem('token');

    const fetchData = async () => {
        try {
            const headers = { 'Authorization': `Bearer ${token}` };
            const [logsRes, charsRes] = await Promise.all([
                fetch(`${apiUrl}/city/logs?limit=300`, { headers }),
                fetch(`${apiUrl}/city/characters`, { headers })
            ]);
            const logsData = await logsRes.json();
            const charsData = await charsRes.json();
            if (logsData.success) setLogs(logsData.logs);
            if (charsData.success) setCharacters(charsData.characters);
        } catch (e) { console.error('City DLC Error:', e); }
        finally { setLoading(false); }
    };

    useEffect(() => {
        fetchData();
        const interval = setInterval(fetchData, 15000);
        return () => clearInterval(interval);
    }, [apiUrl, token]);

    const LOCATION_NAMES = {
        factory: '🏭 工厂', restaurant: '🍜 餐厅', convenience: '🏪 便利店',
        park: '🌳 公园', mall: '🛍️ 商场', school: '📚 夜校',
        hospital: '🏥 医院', home: '🏠 家', street: '🚶 商业街', casino: '🎰 赌场'
    };

    const getStatusDetails = (status) => {
        switch (status) {
            case 'working': return { icon: <Briefcase size={16} />, text: '工作中', color: '#ff9800' };
            case 'eating': return { icon: <Coffee size={16} />, text: '吃饭中', color: '#4caf50' };
            case 'sleeping': return { icon: <Moon size={16} />, text: '睡觉中', color: '#9c27b0' };
            case 'hungry': return { icon: <AlertCircle size={16} />, text: '饥饿！', color: '#f44336' };
            case 'coma': return { icon: <Activity size={16} />, text: '已昏迷', color: '#d32f2f' };
            case 'idle':
            default: return { icon: <Store size={16} />, text: '空闲', color: '#2196f3' };
        }
    };

    const getActionEmoji = (type) => {
        switch (type) {
            case 'BUY': return '🛒';
            case 'EAT': return '🍴';
            case 'STARVE': return '🆘';
            case 'BROKE': return '😢';
            case 'GIFT': return '🎁';
            case 'FED': return '🍕';
            case 'PLAN': return '📋';
            case 'GIVE_ITEM': return '🎁';
            case 'SOCIAL': return '💬';
            default: return '';
        }
    };

    return (
        <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
            <div style={{ display: 'flex', borderBottom: '1px solid #eee', padding: '0 16px', backgroundColor: '#fff' }}>
                <button style={TAB_STYLE(tab === 'feed')} onClick={() => setTab('feed')}>
                    <Activity size={14} style={{ verticalAlign: 'middle', marginRight: '4px' }} />实时动态
                </button>
                <button style={TAB_STYLE(tab === 'manage')} onClick={() => setTab('manage')}>
                    <Settings size={14} style={{ verticalAlign: 'middle', marginRight: '4px' }} />分区管理
                </button>
            </div>

            <div style={{ flex: 1, overflowY: 'auto' }}>
                {tab === 'manage' ? (
                    <CityManager apiUrl={apiUrl} onRefreshLogs={fetchData} />
                ) : loading ? (
                    <div style={{ padding: '40px', textAlign: 'center', color: '#999' }}>加载中...</div>
                ) : (
                    <div style={{ padding: '16px', display: 'flex', gap: '16px', height: '100%' }}>
                        {/* 左侧：行为日志 */}
                        <div style={{ flex: 2, display: 'flex', flexDirection: 'column', backgroundColor: '#fff', borderRadius: '12px', boxShadow: '0 2px 10px rgba(0,0,0,0.05)', overflow: 'hidden' }}>
                            <div style={{ padding: '12px 18px', borderBottom: '1px solid #eee', background: 'linear-gradient(to right, #f8f9fa, #fff)' }}>
                                <h3 style={{ margin: 0, fontSize: '15px', display: 'flex', alignItems: 'center', gap: '6px' }}>
                                    <Activity size={16} color="#ff9800" /> 城市动态
                                </h3>
                            </div>
                            <div style={{ flex: 1, overflowY: 'auto', padding: '10px' }}>
                                {(() => {
                                    if (logs.length === 0) return <div style={{ textAlign: 'center', color: '#bbb', marginTop: '40px', fontSize: '13px' }}>暂无动态，等待模拟引擎运行...</div>;

                                    const groupedLogs = {};
                                    logs.forEach(log => {
                                        const d = new Date(log.timestamp);
                                        const tag = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
                                        if (!groupedLogs[tag]) groupedLogs[tag] = [];
                                        groupedLogs[tag].push(log);
                                    });

                                    const latestLogDateTag = logs.length > 0
                                        ? (() => {
                                            const latest = new Date(logs[0].timestamp);
                                            return `${latest.getFullYear()}-${String(latest.getMonth() + 1).padStart(2, '0')}-${String(latest.getDate()).padStart(2, '0')}`;
                                        })()
                                        : '';
                                    const todayTagFmt = `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}-${String(new Date().getDate()).padStart(2, '0')}`;

                                    const toggleDate = (tag) => {
                                        setCollapsedDates(prev => ({ ...prev, [tag]: !prev[tag] }));
                                    };

                                    const isCollapsed = (tag) => {
                                        if (collapsedDates[tag] !== undefined) return collapsedDates[tag];
                                        return tag !== latestLogDateTag; // default-expand the newest log day
                                    };

                                    return Object.keys(groupedLogs).sort((a, b) => b.localeCompare(a)).map(dateTag => {
                                        const dateLogs = groupedLogs[dateTag];
                                        const collapsed = isCollapsed(dateTag);
                                        const isToday = dateTag === todayTagFmt;

                                        return (
                                            <div key={dateTag} style={{ marginBottom: '12px' }}>
                                                <div
                                                    onClick={() => toggleDate(dateTag)}
                                                    style={{
                                                        display: 'flex', alignItems: 'center', padding: '6px 10px',
                                                        backgroundColor: isToday ? '#fff8e1' : '#f5f5f5',
                                                        borderRadius: '6px', cursor: 'pointer', marginBottom: '8px',
                                                        fontSize: '13px', fontWeight: '600', color: isToday ? '#ff9800' : '#666',
                                                        border: isToday ? '1px solid #ffe082' : '1px solid #eee'
                                                    }}
                                                >
                                                    {collapsed ? <ChevronRight size={14} style={{ marginRight: '6px' }} /> : <ChevronDown size={14} style={{ marginRight: '6px' }} />}
                                                    📅 {dateTag} {isToday ? '(今天)' : ''}
                                                    <span style={{ marginLeft: 'auto', fontSize: '11px', color: '#999', fontWeight: '400' }}>{dateLogs.length} 条记录</span>
                                                </div>

                                                {!collapsed && dateLogs.map(log => {
                                                    const isSocial = log.action_type === 'SOCIAL';
                                                    return (
                                                        <div key={log.id} style={{
                                                            display: 'flex', gap: '10px', padding: '10px', marginLeft: '12px',
                                                            borderLeft: '2px solid #eee', borderBottom: '1px solid #f5f5f5', alignItems: 'flex-start',
                                                            ...(isSocial ? {
                                                                background: 'linear-gradient(135deg, #fce4ec 0%, #f3e5f5 50%, #e8eaf6 100%)',
                                                                borderRadius: '0 8px 8px 0', marginBottom: '4px', border: '1px solid #e1bee7',
                                                                borderLeft: '4px solid #ff4081',
                                                                borderBottom: '1px solid #e1bee7'
                                                            } : {})
                                                        }}>
                                                            <img src={avatarSrc(log.char_avatar, apiUrl)} alt="" style={{ width: '36px', height: '36px', borderRadius: '50%', objectFit: 'cover' }} />
                                                            <div style={{ flex: 1 }}>
                                                                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '3px' }}>
                                                                    <span style={{ fontWeight: '600', fontSize: '13px', color: isSocial ? '#7b1fa2' : undefined }}>{getActionEmoji(log.action_type)} {log.char_name}{isSocial ? ' · 偶遇' : ''}</span>
                                                                    <span style={{ fontSize: '11px', color: '#bbb' }}>{new Date(log.timestamp).toLocaleTimeString()}</span>
                                                                </div>
                                                                <div style={{ fontSize: '13px', color: isSocial ? '#4a148c' : '#555' }}>{log.content}</div>
                                                                {(log.delta_calories !== 0 || log.delta_money !== 0) && (
                                                                    <div style={{ marginTop: '4px', display: 'flex', gap: '8px', fontSize: '11px', fontWeight: '600' }}>
                                                                        {log.delta_calories !== 0 && <span style={{ color: log.delta_calories > 0 ? '#4caf50' : '#f44336' }}>{log.delta_calories > 0 ? '+' : ''}{log.delta_calories} 卡</span>}
                                                                        {log.delta_money !== 0 && <span style={{ color: log.delta_money > 0 ? '#ff9800' : '#d32f2f' }}>{log.delta_money > 0 ? '+' : ''}{Number(log.delta_money).toFixed(0)} 金币</span>}
                                                                    </div>
                                                                )}
                                                            </div>
                                                        </div>
                                                    );
                                                })}
                                            </div>
                                        );
                                    });
                                })()}
                            </div>
                        </div>

                        {/* 右侧：人口状态 + 背包 */}
                        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', backgroundColor: '#fff', borderRadius: '12px', boxShadow: '0 2px 10px rgba(0,0,0,0.05)', overflow: 'hidden' }}>
                            <div style={{ padding: '12px 18px', borderBottom: '1px solid #eee' }}>
                                <h3 style={{ margin: 0, fontSize: '15px' }}>人口状态</h3>
                            </div>
                            <div style={{ flex: 1, overflowY: 'auto', padding: '8px' }}>
                                {characters.map(c => {
                                    const s = getStatusDetails(c.city_status);
                                    const pct = Math.min(100, Math.max(0, (c.calories / 4000) * 100));
                                    const bagOpen = expandedBag === c.id;
                                    const inv = c.inventory || [];
                                    return (
                                        <div key={c.id} style={{ padding: '10px', border: '1px solid #eee', borderRadius: '8px', marginBottom: '8px' }}>
                                            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '6px' }}>
                                                <img src={avatarSrc(c.avatar, apiUrl)} alt="" style={{ width: '28px', height: '28px', borderRadius: '50%', objectFit: 'cover' }} />
                                                <span style={{ fontWeight: '500', flex: 1, fontSize: '13px' }}>{c.name}</span>
                                                <span style={{ fontSize: '12px', fontWeight: '600', color: '#ff9800' }}>{(c.wallet || 0).toFixed(0)}💰</span>
                                            </div>
                                            <div style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: '11px', color: s.color, marginBottom: '6px', padding: '3px 6px', backgroundColor: `${s.color}12`, borderRadius: '4px' }}>
                                                {s.icon} {s.text} · {LOCATION_NAMES[c.location] || c.location || '家'}
                                            </div>
                                            <div style={{ width: '100%', height: '5px', backgroundColor: '#eee', borderRadius: '3px', overflow: 'hidden' }}>
                                                <div style={{ width: `${pct}%`, height: '100%', backgroundColor: pct < 20 ? '#f44336' : pct < 50 ? '#ff9800' : '#4caf50', transition: 'width 0.3s' }} />
                                            </div>
                                            <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '3px' }}>
                                                <span style={{ fontSize: '10px', color: '#aaa' }}>{c.calories}/4000 卡路里</span>
                                                <button
                                                    onClick={() => setExpandedBag(bagOpen ? null : c.id)}
                                                    style={{ fontSize: '10px', color: inv.length > 0 ? '#ff9800' : '#ccc', border: 'none', background: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '2px' }}
                                                >
                                                    <Package size={12} /> 背包 ({inv.length})
                                                </button>
                                            </div>
                                            {/* Inventory Dropdown */}
                                            {bagOpen && (
                                                <div style={{ marginTop: '6px', padding: '6px', backgroundColor: '#fafafa', borderRadius: '6px', border: '1px dashed #ddd' }}>
                                                    {inv.length === 0 ? (
                                                        <div style={{ fontSize: '11px', color: '#bbb', textAlign: 'center' }}>空背包</div>
                                                    ) : inv.map(item => (
                                                        <div key={item.item_id} style={{ display: 'flex', alignItems: 'center', gap: '6px', padding: '3px 0', fontSize: '12px' }}>
                                                            <span>{item.emoji}</span>
                                                            <span style={{ flex: 1 }}>{item.name}</span>
                                                            <span style={{ color: '#999', fontSize: '11px' }}>x{item.quantity}</span>
                                                            {item.cal_restore > 0 && <span style={{ color: '#4caf50', fontSize: '10px' }}>+{item.cal_restore}卡</span>}
                                                        </div>
                                                    ))}
                                                </div>
                                            )}
                                        </div>
                                    );
                                })}
                            </div>
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}
