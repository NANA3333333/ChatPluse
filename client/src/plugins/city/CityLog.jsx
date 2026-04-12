import React, { useEffect, useState } from 'react';
import {
    Activity,
    AlertCircle,
    Briefcase,
    ChevronDown,
    ChevronRight,
    Cloud,
    CloudDrizzle,
    CloudFog,
    CloudLightning,
    CloudRain,
    CloudSun,
    Coffee,
    Moon,
    Package,
    Settings,
    Store,
    SunMedium,
    Wind,
} from 'lucide-react';
import CityManager from './CityManager';
import { resolveAvatarUrl } from '../../utils/avatar';
import { deriveEmotion } from '../../utils/emotion';

const FALLBACK_AVATAR = 'https://api.dicebear.com/7.x/shapes/svg?seed=User';
const avatarSrc = (url, apiUrl) => resolveAvatarUrl(url, apiUrl) || FALLBACK_AVATAR;

const tabStyle = (active) => ({
    padding: '10px 16px',
    border: 'none',
    borderBottom: active ? '2px solid #ff9800' : '2px solid transparent',
    backgroundColor: 'transparent',
    color: active ? '#ff9800' : '#888',
    cursor: 'pointer',
    fontSize: '14px',
    fontWeight: active ? '600' : '400',
    transition: 'all 0.2s',
    flex: '0 0 auto',
    whiteSpace: 'nowrap',
});

const LOCATION_NAMES = {
    factory: '🏭 工厂',
    restaurant: '🍽️ 餐厅',
    convenience: '🏪 便利店',
    park: '🌳 中央公园',
    mall: '🛍️ 商场',
    school: '🏫 夜校',
    hospital: '🏥 医院',
    home: '🏠 家',
    street: '🛣️ 商业街',
    casino: '🎰 赌城',
};

function getStatusDetails(status) {
    switch (status) {
        case 'working':
            return { icon: <Briefcase size={16} />, text: '工作中', color: '#ff9800' };
        case 'eating':
            return { icon: <Coffee size={16} />, text: '吃饭中', color: '#4caf50' };
        case 'sleeping':
            return { icon: <Moon size={16} />, text: '睡觉中', color: '#9c27b0' };
        case 'hungry':
            return { icon: <AlertCircle size={16} />, text: '饥饿', color: '#f44336' };
        case 'coma':
            return { icon: <Activity size={16} />, text: '昏迷', color: '#d32f2f' };
        default:
            return { icon: <Store size={16} />, text: '空闲', color: '#2196f3' };
    }
}

function getActionEmoji(type) {
    switch (type) {
        case 'BUY':
            return '📦';
        case 'EAT':
            return '🍜';
        case 'STARVE':
            return '🥵';
        case 'BROKE':
            return '💸';
        case 'GIFT':
            return '🎁';
        case 'FED':
            return '🍱';
        case 'PLAN':
            return '🗓️';
        case 'GIVE_ITEM':
            return '🎁';
        case 'SOCIAL':
            return '💬';
        default:
            return '';
    }
}

function getStateColor(value) {
    if (value >= 70) return '#4caf50';
    if (value >= 40) return '#ff9800';
    return '#f44336';
}

function getInvertedStateColor(value) {
    if (value <= 30) return '#4caf50';
    if (value <= 60) return '#ff9800';
    return '#f44336';
}

function getCurrentWeather(events) {
    if (!Array.isArray(events)) return null;
    return events.find((event) => String(event.event_type || '').toLowerCase() === 'weather') || null;
}

function getWeatherVisual(event) {
    const title = String(event?.title || '');
    const desc = String(event?.description || '');
    const text = `${title} ${desc}`;
    if (/暴风雨|雷暴|storm|thunder/i.test(text)) {
        return {
            key: 'storm',
            label: title || '暴风雨',
            Icon: CloudLightning,
            tint: 'linear-gradient(180deg, rgba(43, 56, 86, 0.16), rgba(26, 32, 44, 0.07))',
            accent: '#5c6ac4',
            particles: 10,
        };
    }
    if (/大雨|暴雨|rain/i.test(text)) {
        return {
            key: 'rain',
            label: title || '雨天',
            Icon: CloudRain,
            tint: 'linear-gradient(180deg, rgba(64, 105, 168, 0.14), rgba(104, 144, 201, 0.06))',
            accent: '#4f83cc',
            particles: 14,
        };
    }
    if (/小雨|阵雨|drizzle/i.test(text)) {
        return {
            key: 'drizzle',
            label: title || '小雨',
            Icon: CloudDrizzle,
            tint: 'linear-gradient(180deg, rgba(102, 126, 161, 0.12), rgba(159, 184, 218, 0.05))',
            accent: '#7c93b5',
            particles: 10,
        };
    }
    if (/大雾|雾|fog/i.test(text)) {
        return {
            key: 'fog',
            label: title || '大雾',
            Icon: CloudFog,
            tint: 'linear-gradient(180deg, rgba(215, 223, 233, 0.18), rgba(229, 234, 240, 0.08))',
            accent: '#90a4ae',
            particles: 6,
        };
    }
    if (/微风|风|wind/i.test(text)) {
        return {
            key: 'wind',
            label: title || '微风',
            Icon: Wind,
            tint: 'linear-gradient(180deg, rgba(163, 230, 197, 0.16), rgba(222, 247, 236, 0.08))',
            accent: '#2e8b57',
            particles: 8,
        };
    }
    if (/多云|cloud/i.test(text)) {
        return {
            key: 'cloud',
            label: title || '多云',
            Icon: CloudSun,
            tint: 'linear-gradient(180deg, rgba(255, 229, 180, 0.16), rgba(226, 232, 240, 0.08))',
            accent: '#f59e0b',
            particles: 6,
        };
    }
    return {
        key: 'sunny',
        label: title || '晴天',
        Icon: SunMedium,
        tint: 'linear-gradient(180deg, rgba(255, 220, 120, 0.18), rgba(255, 241, 204, 0.06))',
        accent: '#f59e0b',
        particles: 5,
    };
}

function isWeatherAnnouncement(item) {
    const haystack = `${item?.title || ''} ${item?.content || ''}`;
    return /天气|晴天|多云|微风|小雨|大雨|暴风雨|雷暴|大雾|春雨|雨/i.test(haystack);
}

function getAnnouncementMeta(item) {
    const sourceType = String(item?.source_type || '').toLowerCase();
    if (sourceType === 'mayor') {
        return { label: '市长广播', chipBg: '#efe6ff', chipColor: '#7c3aed', borderColor: '#ddd6fe' };
    }
    if (sourceType === 'agency') {
        return { label: '中介广告', chipBg: '#ffedd5', chipColor: '#c2410c', borderColor: '#fed7aa' };
    }
    return { label: '街头公告', chipBg: '#ecfccb', chipColor: '#4d7c0f', borderColor: '#d9f99d' };
}

function cleanAnnouncementContent(item) {
    const raw = String(item?.content || '').trim();
    const withoutPrefix = raw.replace(/^\s*[\[【].{1,12}?[\]】]\s*/, '').trim();
    return withoutPrefix || raw;
}

function splitAnnouncementParagraphs(item) {
    const cleaned = cleanAnnouncementContent(item);
    return cleaned
        .split(/\s*[|｜]\s*|\n+/)
        .map((part) => part.trim())
        .filter(Boolean);
}

export default function CityLog({ apiUrl, userProfile }) {
    const announcementActionTypes = new Set(['ANNOUNCE', 'MAYOR', 'EVENT', 'QUEST']);
    const [tab, setTab] = useState('feed');
    const [logs, setLogs] = useState([]);
    const [announcements, setAnnouncements] = useState([]);
    const [events, setEvents] = useState([]);
    const [characters, setCharacters] = useState([]);
    const [loading, setLoading] = useState(true);
    const [expandedBag, setExpandedBag] = useState(null);
    const [collapsedDates, setCollapsedDates] = useState({});
    const [expandedHiddenLogs, setExpandedHiddenLogs] = useState({});
    const [isMobile, setIsMobile] = useState(() => window.innerWidth <= 768);
    const refreshTimerRef = React.useRef(null);
    const token = localStorage.getItem('token');

    useEffect(() => {
        const onResize = () => setIsMobile(window.innerWidth <= 768);
        window.addEventListener('resize', onResize);
        return () => window.removeEventListener('resize', onResize);
    }, []);

    const fetchData = async () => {
        try {
            const headers = { Authorization: `Bearer ${token}` };
            const [logsRes, announcementsRes, eventsRes, charsRes] = await Promise.all([
                fetch(`${apiUrl}/city/logs?limit=300`, { headers }),
                fetch(`${apiUrl}/city/announcements?limit=50`, { headers }),
                fetch(`${apiUrl}/city/events`, { headers }),
                fetch(`${apiUrl}/city/characters`, { headers }),
            ]);
            const logsData = await logsRes.json();
            const announcementsData = await announcementsRes.json();
            const eventsData = await eventsRes.json();
            const charsData = await charsRes.json();
            if (logsData.success) setLogs(logsData.logs || []);
            if (announcementsData.success) setAnnouncements(announcementsData.announcements || []);
            if (eventsData.success) setEvents(eventsData.events || []);
            if (charsData.success) setCharacters(charsData.characters || []);
        } catch (e) {
            console.error('CityLog error:', e);
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        fetchData();
        const scheduleRefresh = () => {
            if (refreshTimerRef.current) return;
            refreshTimerRef.current = setTimeout(() => {
                refreshTimerRef.current = null;
                fetchData();
            }, 800);
        };
        const handleCityUpdate = () => scheduleRefresh();
        window.addEventListener('city_update', handleCityUpdate);
        const interval = setInterval(fetchData, 5000);
        return () => {
            window.removeEventListener('city_update', handleCityUpdate);
            clearInterval(interval);
            if (refreshTimerRef.current) {
                clearTimeout(refreshTimerRef.current);
                refreshTimerRef.current = null;
            }
        };
    }, [apiUrl, token]);

    const activityLogs = logs.filter((log) => !announcementActionTypes.has(String(log.action_type || '').toUpperCase()));

    const latestLogDateTag = activityLogs.length > 0
        ? (() => {
            const latest = new Date(activityLogs[0].timestamp);
            return `${latest.getFullYear()}-${String(latest.getMonth() + 1).padStart(2, '0')}-${String(latest.getDate()).padStart(2, '0')}`;
        })()
        : '';

    const groupedLogs = activityLogs.reduce((acc, log) => {
        const d = new Date(log.timestamp);
        const tag = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
        if (!acc[tag]) acc[tag] = [];
        acc[tag].push(log);
        return acc;
    }, {});

    const todayTag = (() => {
        const now = new Date();
        return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    })();

    const currentWeather = getCurrentWeather(events);
    const weatherVisual = currentWeather ? getWeatherVisual(currentWeather) : null;
    const visibleAnnouncements = announcements.filter((item, index) => {
        if (!isWeatherAnnouncement(item)) return true;
        return announcements.findIndex((candidate) => isWeatherAnnouncement(candidate)) === index;
    });

    const isCollapsed = (tag) => {
        if (collapsedDates[tag] !== undefined) return collapsedDates[tag];
        return tag !== latestLogDateTag;
    };

    return (
        <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
            <style>{`
                .city-scroll {
                    scrollbar-width: thin;
                    scrollbar-color: rgba(148, 163, 184, 0.32) transparent;
                }
                .city-scroll::-webkit-scrollbar {
                    width: 6px;
                    height: 6px;
                }
                .city-scroll::-webkit-scrollbar-track {
                    background: transparent;
                }
                .city-scroll::-webkit-scrollbar-thumb {
                    background: linear-gradient(180deg, rgba(203, 213, 225, 0.72), rgba(148, 163, 184, 0.38));
                    border-radius: 999px;
                    border: 1px solid transparent;
                    background-clip: padding-box;
                }
                .city-scroll::-webkit-scrollbar-thumb:hover {
                    background: linear-gradient(180deg, rgba(191, 219, 254, 0.78), rgba(148, 163, 184, 0.52));
                    border-radius: 999px;
                    border: 1px solid transparent;
                    background-clip: padding-box;
                }
            `}</style>
            <div style={{ display: 'flex', borderBottom: '1px solid #eee', padding: '0 12px', backgroundColor: '#fff', overflowX: 'auto', gap: '8px' }}>
                <button style={tabStyle(tab === 'feed')} onClick={() => setTab('feed')}>
                    <Activity size={14} style={{ verticalAlign: 'middle', marginRight: '4px' }} />实时动态
                </button>
                <button style={tabStyle(tab === 'manage')} onClick={() => setTab('manage')}>
                    <Settings size={14} style={{ verticalAlign: 'middle', marginRight: '4px' }} />分区管理
                </button>
            </div>

            <div style={{ flex: 1, minHeight: 0, overflow: 'hidden' }}>
                {tab === 'manage' ? (
                    <CityManager apiUrl={apiUrl} onRefreshLogs={fetchData} />
                ) : loading ? (
                    <div style={{ padding: '40px', textAlign: 'center', color: '#999' }}>加载中...</div>
                ) : (
                    <div
                        style={{
                            padding: isMobile ? '10px' : '16px',
                            display: 'flex',
                            flexDirection: isMobile ? 'column' : 'row',
                            gap: '16px',
                            height: '100%',
                            minHeight: 0,
                            overflow: 'auto',
                        }}
                    >
                        <div
                            style={{
                                flex: isMobile ? 'none' : 2.2,
                                minHeight: isMobile ? '56vh' : 0,
                                display: 'flex',
                                flexDirection: 'column',
                                position: 'relative',
                                backgroundColor: '#fff',
                                borderRadius: '12px',
                                boxShadow: '0 2px 10px rgba(0,0,0,0.05)',
                                overflow: 'hidden',
                            }}
                        >
                            <div style={{ padding: '12px 18px', borderBottom: '1px solid #eee', background: weatherVisual ? weatherVisual.tint : 'linear-gradient(to right, #f8f9fa, #fff)' }}>
                                <h3 style={{ margin: 0, fontSize: isMobile ? '14px' : '15px', display: 'flex', alignItems: 'center', gap: '6px', justifyContent: 'space-between' }}>
                                    <Activity size={16} color="#ff9800" /> 城市动态
                                </h3>
                            </div>
                            {weatherVisual && (
                                <div style={{ position: 'absolute', inset: '52px 0 0 0', pointerEvents: 'none', overflow: 'hidden' }}>
                                    <div style={{ position: 'absolute', inset: 0, background: weatherVisual.tint, opacity: 0.78 }} />
                                    {Array.from({ length: weatherVisual.particles }).map((_, index) => (
                                        <span
                                            key={`weather-particle-${weatherVisual.key}-${index}`}
                                            style={{
                                                position: 'absolute',
                                                left: `${8 + ((index * 11) % 84)}%`,
                                                top: `${5 + ((index * 9) % 70)}%`,
                                                width: weatherVisual.key === 'fog' ? '54px' : weatherVisual.key === 'wind' ? '30px' : '2px',
                                                height: weatherVisual.key === 'fog' ? '12px' : weatherVisual.key === 'wind' ? '2px' : '14px',
                                                borderRadius: '999px',
                                                background: weatherVisual.key === 'fog'
                                                    ? 'rgba(255,255,255,0.24)'
                                                    : weatherVisual.key === 'wind'
                                                        ? `${weatherVisual.accent}55`
                                                        : `${weatherVisual.accent}44`,
                                                transform: weatherVisual.key === 'wind'
                                                    ? `translateX(${(index % 4) * 6}px)`
                                                    : `rotate(${weatherVisual.key === 'storm' ? 18 : 8}deg)`,
                                                boxShadow: weatherVisual.key === 'sunny'
                                                    ? `0 0 18px ${weatherVisual.accent}22`
                                                    : 'none',
                                            }}
                                        />
                                    ))}
                                </div>
                            )}
                            <div className="city-scroll" style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '10px', display: 'flex', flexDirection: isMobile ? 'column' : 'row', gap: '12px', position: 'relative', zIndex: 1 }}>
                                <div style={{ flex: isMobile ? 'none' : 0.9, minHeight: isMobile ? '28vh' : 0, display: 'flex', flexDirection: 'column', border: '1px solid #f3e8dc', borderRadius: '10px', overflow: 'hidden', background: '#fffaf5' }}>
                                    <div style={{ padding: '10px 14px', borderBottom: '1px solid #f3e8dc', background: 'linear-gradient(to right, #fff7ed, #fff)' }}>
                                        <h3 style={{ margin: 0, fontSize: isMobile ? '13px' : '14px', display: 'flex', alignItems: 'center', gap: '6px', color: '#c2410c' }}>
                                            <AlertCircle size={15} color="#f97316" /> 公告区
                                        </h3>
                                    </div>
                                    <div className="city-scroll" style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '10px' }}>
                                        {currentWeather && weatherVisual && (
                                            <div style={{ padding: '10px 12px', borderRadius: '10px', marginBottom: '10px', background: 'rgba(255,255,255,0.72)', border: `1px solid ${weatherVisual.accent}2e`, boxShadow: '0 4px 16px rgba(0,0,0,0.04)' }}>
                                                <div style={{ display: 'flex', justifyContent: 'space-between', gap: '8px', marginBottom: '4px', alignItems: 'center' }}>
                                                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', fontSize: '12px', fontWeight: 700, color: weatherVisual.accent }}>
                                                        <weatherVisual.Icon size={14} />
                                                        当前天气
                                                    </span>
                                                    <span style={{ fontSize: '11px', color: '#b45309', flexShrink: 0 }}>
                                                        {new Date(currentWeather.created_at || currentWeather.timestamp || Date.now()).toLocaleTimeString()}
                                                    </span>
                                                </div>
                                                <div style={{ fontSize: '13px', fontWeight: 700, color: '#7c2d12', marginBottom: '3px' }}>
                                                    {currentWeather.emoji || ''} {currentWeather.title || weatherVisual.label}
                                                </div>
                                                {currentWeather.description && (
                                                    <div style={{ fontSize: isMobile ? '12px' : '13px', color: '#7c2d12', lineHeight: 1.65 }}>
                                                        {currentWeather.description}
                                                    </div>
                                                )}
                                            </div>
                                        )}
                                        {visibleAnnouncements.length === 0 ? (
                                            <div style={{ textAlign: 'center', color: '#bbb', padding: '16px 0', fontSize: '12px' }}>暂无公告</div>
                                        ) : (
                                            visibleAnnouncements.map((item) => (
                                                <div key={`ann-${item.id}`} style={{ padding: '10px 10px 12px', marginBottom: '10px', border: `1px solid ${getAnnouncementMeta(item).borderColor}`, borderRadius: '12px', background: 'rgba(255,255,255,0.72)', boxShadow: '0 4px 14px rgba(120, 53, 15, 0.04)' }}>
                                                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: '10px', marginBottom: '8px', alignItems: 'center' }}>
                                                        <span style={{ fontSize: '11px', fontWeight: 700, color: getAnnouncementMeta(item).chipColor, background: getAnnouncementMeta(item).chipBg, borderRadius: '999px', padding: '3px 8px', flexShrink: 0 }}>
                                                            {item.title || (item.source_type === 'mayor' ? '市长广播' : item.source_type === 'agency' ? '中介广告' : '街头公告')}
                                                        </span>
                                                        <span style={{ fontSize: '11px', color: '#b45309', flexShrink: 0 }}>{new Date(item.timestamp).toLocaleTimeString()}</span>
                                                    </div>
                                                    <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                                                        {item.title && (
                                                            <div style={{ fontSize: '13px', fontWeight: 700, color: '#7c2d12', wordBreak: 'break-word' }}>
                                                                {item.title}
                                                            </div>
                                                        )}
                                                        {splitAnnouncementParagraphs(item).map((part, index) => (
                                                            <div
                                                                key={`ann-${item.id}-part-${index}`}
                                                                style={{
                                                                    fontSize: isMobile ? '12px' : '13px',
                                                                    color: '#7c2d12',
                                                                    lineHeight: 1.7,
                                                                    wordBreak: 'break-word',
                                                                    paddingLeft: index === 0 ? 0 : '10px',
                                                                    borderLeft: index === 0 ? 'none' : '2px solid rgba(249, 115, 22, 0.16)',
                                                                }}
                                                            >
                                                                {part}
                                                            </div>
                                                        ))}
                                                    </div>
                                                </div>
                                            ))
                                        )}
                                    </div>
                                </div>

                                <div
                                    style={{
                                        flex: isMobile ? 'none' : 1.8,
                                        minHeight: isMobile ? '36vh' : 0,
                                        display: 'flex',
                                        flexDirection: 'column',
                                        border: '1px solid #eee',
                                        borderRadius: '10px',
                                        overflow: 'hidden',
                                        background: '#fff',
                                    }}
                                >
                                    <div style={{ padding: '10px 14px', borderBottom: '1px solid #eee', background: 'linear-gradient(to right, #f8f9fa, #fff)' }}>
                                        <h3 style={{ margin: 0, fontSize: isMobile ? '13px' : '14px', display: 'flex', alignItems: 'center', gap: '6px' }}>
                                            <Activity size={15} color="#ff9800" /> 个人活动
                                        </h3>
                                    </div>
                                    <div className="city-scroll" style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '10px' }}>
                                {activityLogs.length === 0 ? (
                                    <div style={{ textAlign: 'center', color: '#bbb', marginTop: '40px', fontSize: '13px' }}>暂无动态，等待模拟引擎运行...</div>
                                ) : (
                                    Object.keys(groupedLogs)
                                        .sort((a, b) => b.localeCompare(a))
                                        .map((dateTag) => {
                                            const dateLogs = groupedLogs[dateTag];
                                            const collapsed = isCollapsed(dateTag);
                                            const isToday = dateTag === todayTag;
                                            return (
                                                <div key={dateTag} style={{ marginBottom: '12px' }}>
                                                    <div
                                                        onClick={() => setCollapsedDates((prev) => ({ ...prev, [dateTag]: !collapsed }))}
                                                        style={{
                                                            display: 'flex',
                                                            alignItems: 'center',
                                                            padding: '8px 10px',
                                                            backgroundColor: isToday ? '#fff8e1' : '#f5f5f5',
                                                            borderRadius: '6px',
                                                            cursor: 'pointer',
                                                            marginBottom: '8px',
                                                            fontSize: isMobile ? '12px' : '13px',
                                                            fontWeight: '600',
                                                            color: isToday ? '#ff9800' : '#666',
                                                            border: isToday ? '1px solid #ffe082' : '1px solid #eee',
                                                        }}
                                                    >
                                                        {collapsed ? <ChevronRight size={14} style={{ marginRight: '6px' }} /> : <ChevronDown size={14} style={{ marginRight: '6px' }} />}
                                                        📅 {dateTag} {isToday ? '(今天)' : ''}
                                                        <span style={{ marginLeft: 'auto', fontSize: '11px', color: '#999', fontWeight: '400' }}>{dateLogs.length} 条记录</span>
                                                    </div>

                                                    {!collapsed &&
                                                        dateLogs.map((log) => {
                                                            const isSocial = log.action_type === 'SOCIAL';
                                                            const isTruncated = Boolean(log.is_truncated);
                                                            const hiddenExpanded = Boolean(expandedHiddenLogs[log.id]);
                                                            return (
                                                                <div
                                                                    key={log.id}
                                                                    style={{
                                                                        display: 'flex',
                                                                        gap: '10px',
                                                                        padding: isMobile ? '8px' : '10px',
                                                                        marginLeft: isMobile ? '4px' : '12px',
                                                                        borderLeft: '2px solid #eee',
                                                                        borderBottom: '1px solid #f5f5f5',
                                                                        alignItems: 'flex-start',
                                                                        ...(isSocial
                                                                            ? {
                                                                                background: 'linear-gradient(135deg, #fce4ec 0%, #f3e5f5 50%, #e8eaf6 100%)',
                                                                                borderRadius: '0 8px 8px 0',
                                                                                marginBottom: '4px',
                                                                                border: '1px solid #e1bee7',
                                                                                borderLeft: '4px solid #ff4081',
                                                                                borderBottom: '1px solid #e1bee7',
                                                                            }
                                                                            : {}),
                                                                    }}
                                                                >
                                                                    <img src={avatarSrc(log.char_avatar, apiUrl)} alt="" style={{ width: isMobile ? '32px' : '36px', height: isMobile ? '32px' : '36px', borderRadius: '50%', objectFit: 'cover' }} />
                                                                    <div style={{ flex: 1, minWidth: 0 }}>
                                                                        <div style={{ display: 'flex', justifyContent: 'space-between', gap: '8px', marginBottom: '3px' }}>
                                                                            <span style={{ fontWeight: '600', fontSize: isMobile ? '12px' : '13px', color: isSocial ? '#7b1fa2' : undefined }}>
                                                                                {getActionEmoji(log.action_type)} {log.char_name}
                                                                                {isSocial ? ' · 偶遇' : ''}
                                                                            </span>
                                                                            <span style={{ fontSize: '11px', color: '#bbb', flexShrink: 0 }}>{new Date(log.timestamp).toLocaleTimeString()}</span>
                                                                        </div>
                                                                        {isTruncated ? (
                                                                            <div
                                                                                style={{
                                                                                    borderLeft: '2px solid rgba(140, 140, 140, 0.16)',
                                                                                    background: 'rgba(120, 120, 120, 0.028)',
                                                                                    color: 'rgba(102, 102, 102, 0.5)',
                                                                                    borderRadius: '0 6px 6px 0',
                                                                                    padding: isMobile ? '4px 8px' : '5px 9px',
                                                                                    lineHeight: 1.35,
                                                                                    opacity: 0.52,
                                                                                }}
                                                                            >
                                                                                <button
                                                                                    type="button"
                                                                                    onClick={() => setExpandedHiddenLogs((prev) => ({ ...prev, [log.id]: !hiddenExpanded }))}
                                                                                    style={{
                                                                                        width: '100%',
                                                                                        border: 'none',
                                                                                        background: 'transparent',
                                                                                        padding: 0,
                                                                                        cursor: 'pointer',
                                                                                        display: 'flex',
                                                                                        alignItems: 'center',
                                                                                        justifyContent: 'space-between',
                                                                                        gap: '6px',
                                                                                        color: 'inherit',
                                                                                        textAlign: 'left',
                                                                                        opacity: 0.95,
                                                                                    }}
                                                                                >
                                                                                    <div style={{ fontSize: isMobile ? '10px' : '11px', fontWeight: '500', display: 'flex', alignItems: 'center', gap: '4px', letterSpacing: '0.01em' }}>
                                                                                        <AlertCircle size={11} />
                                                                                        隐藏内容
                                                                                    </div>
                                                                                    <div style={{ display: 'flex', alignItems: 'center', gap: '2px', fontSize: '9px', color: 'rgba(108, 108, 108, 0.42)' }}>
                                                                                        <span>{hiddenExpanded ? '收起' : '查看'}</span>
                                                                                        {hiddenExpanded ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
                                                                                    </div>
                                                                                </button>
                                                                                {hiddenExpanded && (
                                                                                    <div style={{ marginTop: '4px', fontSize: '10px', color: 'rgba(92, 92, 92, 0.64)', wordBreak: 'break-word' }}>
                                                                                        原文：{log.truncated_original_content || log.content}
                                                                                    </div>
                                                                                )}
                                                                            </div>
                                                                        ) : (
                                                                            <div style={{ fontSize: isMobile ? '12px' : '13px', color: isSocial ? '#4a148c' : '#555', lineHeight: 1.7, wordBreak: 'break-word' }}>{log.content}</div>
                                                                        )}
                                                                        {(log.delta_calories !== 0 || log.delta_money !== 0) && (
                                                                            <div style={{ marginTop: '4px', display: 'flex', gap: '8px', flexWrap: 'wrap', fontSize: '11px', fontWeight: '600' }}>
                                                                                {log.delta_calories !== 0 && (
                                                                                    <span style={{ color: log.delta_calories > 0 ? '#4caf50' : '#f44336' }}>
                                                                                        {log.delta_calories > 0 ? '+' : ''}
                                                                                        {log.delta_calories} 卡
                                                                                    </span>
                                                                                )}
                                                                                {log.delta_money !== 0 && (
                                                                                    <span style={{ color: log.delta_money > 0 ? '#ff9800' : '#d32f2f' }}>
                                                                                        {log.delta_money > 0 ? '+' : ''}
                                                                                        {Number(log.delta_money).toFixed(0)} 金币
                                                                                    </span>
                                                                                )}
                                                                            </div>
                                                                        )}
                                                                    </div>
                                                                </div>
                                                            );
                                                        })}
                                                </div>
                                            );
                                        })
                                )}
                                    </div>
                                </div>
                            </div>
                        </div>

                        <div
                            style={{
                                flex: isMobile ? 'none' : 1,
                                minHeight: isMobile ? '46vh' : 0,
                                display: 'flex',
                                flexDirection: 'column',
                                backgroundColor: '#fff',
                                borderRadius: '12px',
                                boxShadow: '0 2px 10px rgba(0,0,0,0.05)',
                                overflow: 'hidden',
                            }}
                        >
                            <div style={{ padding: '12px 18px', borderBottom: '1px solid #eee' }}>
                                <h3 style={{ margin: 0, fontSize: isMobile ? '14px' : '15px' }}>人口状态</h3>
                            </div>
                            <div className="city-scroll" style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '8px' }}>
                                {characters.map((c) => {
                                    const status = getStatusDetails(c.city_status);
                                    const emotion = deriveEmotion(c);
                                    const pct = Math.min(100, Math.max(0, (c.calories / 4000) * 100));
                                    const bagOpen = expandedBag === c.id;
                                    const inventory = c.inventory || [];
                                    const stateChips = [
                                        { label: '精力 ⚡', value: c.energy ?? 100, color: getStateColor(c.energy ?? 100) },
                                        { label: '睡眠债 😴', value: c.sleep_debt ?? 0, color: getInvertedStateColor(c.sleep_debt ?? 0) },
                                        { label: '压力 🔥', value: c.stress ?? 20, color: getInvertedStateColor(c.stress ?? 20) },
                                        { label: '社交需求 💬', value: c.social_need ?? 50, color: getInvertedStateColor(c.social_need ?? 50) },
                                        { label: '健康 ❤️', value: c.health ?? 100, color: getStateColor(c.health ?? 100) },
                                        { label: '饱腹感 🍽️', value: c.satiety ?? 45, color: getStateColor(c.satiety ?? 45) },
                                        { label: '胃负担 🤰', value: c.stomach_load ?? 0, color: getInvertedStateColor(c.stomach_load ?? 0) },
                                    ];
                                    return (
                                        <div key={c.id} style={{ padding: isMobile ? '8px' : '10px', border: '1px solid #eee', borderRadius: '8px', marginBottom: '8px' }}>
                                            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '6px' }}>
                                                <img src={avatarSrc(c.avatar, apiUrl)} alt="" style={{ width: isMobile ? '26px' : '28px', height: isMobile ? '26px' : '28px', borderRadius: '50%', objectFit: 'cover' }} />
                                                <span style={{ fontWeight: '500', flex: 1, minWidth: 0, fontSize: isMobile ? '12px' : '13px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.name}</span>
                                                <span style={{ fontSize: '10px', color: emotion.color, fontWeight: '700', flexShrink: 0 }}>{emotion.emoji} {emotion.label}</span>
                                                <span style={{ fontSize: '12px', fontWeight: '600', color: '#ff9800', flexShrink: 0 }}>{(c.wallet || 0).toFixed(0)}💰</span>
                                            </div>
                                            <div style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: isMobile ? '10px' : '11px', color: status.color, marginBottom: '6px', padding: '4px 6px', backgroundColor: `${status.color}12`, borderRadius: '4px', overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>
                                                {status.icon} {status.text} · {LOCATION_NAMES[c.location] || c.location || '家'}
                                            </div>
                                            <div style={{ width: '100%', height: '5px', backgroundColor: '#eee', borderRadius: '3px', overflow: 'hidden' }}>
                                                <div style={{ width: `${pct}%`, height: '100%', backgroundColor: pct < 20 ? '#f44336' : pct < 50 ? '#ff9800' : '#4caf50', transition: 'width 0.3s' }} />
                                            </div>
                                            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: '4px', marginTop: '6px' }}>
                                                {stateChips.map((chip) => (
                                                    <div key={chip.label} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '10px', padding: '3px 5px', borderRadius: '4px', backgroundColor: `${chip.color}12`, color: chip.color }}>
                                                        <span>{chip.label}</span>
                                                        <span style={{ fontWeight: '700' }}>{chip.value}</span>
                                                    </div>
                                                ))}
                                            </div>
                                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px', marginTop: '4px' }}>
                                                <span style={{ fontSize: '10px', color: '#aaa' }}>{c.calories}/4000 卡路里</span>
                                                <button
                                                    onClick={() => setExpandedBag(bagOpen ? null : c.id)}
                                                    style={{ fontSize: '10px', color: inventory.length > 0 ? '#ff9800' : '#ccc', border: 'none', background: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '2px', flexShrink: 0 }}
                                                >
                                                    <Package size={12} /> 背包 ({inventory.length})
                                                </button>
                                            </div>
                                            {bagOpen && (
                                                <div style={{ marginTop: '6px', padding: '6px', backgroundColor: '#fafafa', borderRadius: '6px', border: '1px dashed #ddd' }}>
                                                    {inventory.length === 0 ? (
                                                        <div style={{ fontSize: '11px', color: '#bbb', textAlign: 'center' }}>空背包</div>
                                                    ) : (
                                                        inventory.map((item) => (
                                                            <div key={item.item_id} style={{ display: 'flex', alignItems: 'center', gap: '6px', padding: '3px 0', fontSize: '12px' }}>
                                                                <span>{item.emoji}</span>
                                                                <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.name}</span>
                                                                <span style={{ color: '#999', fontSize: '11px', flexShrink: 0 }}>x{item.quantity}</span>
                                                                {item.cal_restore > 0 && <span style={{ color: '#4caf50', fontSize: '10px', flexShrink: 0 }}>+{item.cal_restore}卡</span>}
                                                            </div>
                                                        ))
                                                    )}
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
