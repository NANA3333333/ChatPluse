import React, { useState, useEffect } from 'react';
import { X, Trash2, Settings, RefreshCw } from 'lucide-react';
import { useLanguage } from '../LanguageContext';
import { resolveAvatarUrl } from '../utils/avatar';
import { deriveEmotion, derivePhysicalState } from '../utils/emotion';

function parseJsonSafely(value, fallback = null) {
    if (value == null || value === '') return fallback;
    if (typeof value !== 'string') return value;
    try {
        return JSON.parse(value);
    } catch (_) {
        return fallback;
    }
}

function formatLlmDebugPayload(payload) {
    if (payload == null || payload === '') return '';
    const formatMessages = (messages) => messages.map((msg, index) => {
        const role = String(msg?.role || 'unknown').toUpperCase();
        const content = typeof msg?.content === 'string'
            ? msg.content
            : JSON.stringify(msg?.content ?? '', null, 2);
        return `--- message ${index + 1} / ${role} ---\n${content}`;
    }).join('\n\n');
    if (typeof payload === 'string') {
        const trimmed = payload.trim();
        const parsed = parseJsonSafely(trimmed, null);
        if (Array.isArray(parsed) && parsed.every(item => item && typeof item === 'object' && 'role' in item)) {
            return formatMessages(parsed);
        }
        if (parsed?.messages && Array.isArray(parsed.messages)) {
            return formatMessages(parsed.messages);
        }
        return parsed ? JSON.stringify(parsed, null, 2) : trimmed;
    }
    if (Array.isArray(payload) && payload.every(item => item && typeof item === 'object' && 'role' in item)) {
        return formatMessages(payload);
    }
    if (payload?.messages && Array.isArray(payload.messages)) {
        return formatMessages(payload.messages);
    }
    try {
        return JSON.stringify(payload, null, 2);
    } catch (_) {
        return String(payload);
    }
}

function ChatSettingsDrawer({ contact, apiUrl, onClose, onClearHistory, isGeneratingSchedule, messagesHideStateCount }) {
    const { t, lang } = useLanguage();
    const [relationships, setRelationships] = useState([]);
    const [regenLoading, setRegenLoading] = useState(null);
    const [regenError, setRegenError] = useState(null);
    const [sweepLimit, setSweepLimit] = useState(contact?.sweep_limit ?? 30);
    const [isSavingSweep, setIsSavingSweep] = useState(false);
    const [impressionQLimit, setImpressionQLimit] = useState(contact?.impression_q_limit ?? 3);
    const [isSavingQLimit, setIsSavingQLimit] = useState(false);
    const [contextLimit, setContextLimit] = useState(contact?.context_msg_limit ?? 60);
    const [isSavingContextLimit, setIsSavingContextLimit] = useState(false);
    const [privateSummaryThreshold, setPrivateSummaryThreshold] = useState(contact?.private_summary_threshold ?? 30);
    const [isSavingPrivateSummaryThreshold, setIsSavingPrivateSummaryThreshold] = useState(false);
    const [expandedHistory, setExpandedHistory] = useState({});
    const [impressionHistories, setImpressionHistories] = useState({});
    const [contextStats, setContextStats] = useState(null);
    const [emotionLogs, setEmotionLogs] = useState([]);
    const [isLoadingEmotionLogs, setIsLoadingEmotionLogs] = useState(false);
    const [llmDebugLogs, setLlmDebugLogs] = useState([]);
    const [isLoadingLlmDebugLogs, setIsLoadingLlmDebugLogs] = useState(false);
    const [isScheduled, setIsScheduled] = useState(contact?.is_scheduled !== 0);
    const [todaySchedule, setTodaySchedule] = useState([]);
    const [isSavingSchedule, setIsSavingSchedule] = useState(false);
    const [isRetryingSchedule, setIsRetryingSchedule] = useState(false);
    const [cityActionFreq, setCityActionFreq] = useState(contact?.city_action_frequency ?? 1);
    const [isSavingFreq, setIsSavingFreq] = useState(false);
    const [isRetryingSweep, setIsRetryingSweep] = useState(false);
    const [isResettingPhysicalState, setIsResettingPhysicalState] = useState(false);
    const authHeaders = {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${localStorage.getItem('cp_token') || ''}`
    };
    const currentEmotion = contact ? deriveEmotion(contact) : null;
    const currentPhysical = contact ? derivePhysicalState(contact) : null;

    useEffect(() => {
        if (!contact) return;
        setSweepLimit(contact.sweep_limit ?? 30);
        setImpressionQLimit(contact.impression_q_limit ?? 3);
        setContextLimit(contact.context_msg_limit ?? 60);
        setPrivateSummaryThreshold(contact.private_summary_threshold ?? 30);
        setIsScheduled(contact.is_scheduled !== 0);
        setCityActionFreq(contact.city_action_frequency ?? 1);

        fetch(`${apiUrl}/characters/${contact.id}/relationships`)
            .then(r => r.json())
            .then(data => setRelationships(Array.isArray(data) ? data : []))
            .catch(() => { });

        fetch(`${apiUrl}/city/schedules/${contact.id}`)
            .then(r => r.json())
            .then(data => { if (data.success) setTodaySchedule(data.schedule || []); })
            .catch(() => { });
    }, [contact?.id, apiUrl]);

    useEffect(() => {
        if (!contact) return;
        const fetchStats = () => {
            fetch(`${apiUrl}/characters/${contact.id}/context-stats`, { headers: { 'Authorization': `Bearer ${localStorage.getItem('cp_token') || ''}` } })
                .then(r => r.json())
                .then(data => { if (data.success) setContextStats(data.stats); })
                .catch(() => { });
        };
        fetchStats();
        const interval = setInterval(fetchStats, 15000);
        return () => clearInterval(interval);
    }, [contact?.id, apiUrl, messagesHideStateCount]);

    useEffect(() => {
        if (!contact) return;

        let cancelled = false;
        const fetchEmotionLogs = async () => {
            setIsLoadingEmotionLogs(true);
            try {
                const r = await fetch(`${apiUrl}/characters/${contact.id}/emotion-logs?limit=30`, { headers: authHeaders });
                const data = await r.json();
                if (!cancelled) {
                    setEmotionLogs(data.success ? (data.logs || []) : []);
                }
            } catch (err) {
                if (!cancelled) {
                    console.error('Failed to load emotion logs', err);
                    setEmotionLogs([]);
                }
            } finally {
                if (!cancelled) setIsLoadingEmotionLogs(false);
            }
        };

        const handleRefresh = () => fetchEmotionLogs();
        fetchEmotionLogs();
        const interval = setInterval(fetchEmotionLogs, 5000);
        window.addEventListener('refresh_contacts', handleRefresh);
        window.addEventListener('city_update', handleRefresh);

        return () => {
            cancelled = true;
            clearInterval(interval);
            window.removeEventListener('refresh_contacts', handleRefresh);
            window.removeEventListener('city_update', handleRefresh);
        };
    }, [contact?.id, apiUrl]);

    useEffect(() => {
        if (!contact) return;

        let cancelled = false;
        setLlmDebugLogs([]);
        const fetchLlmDebugLogs = async () => {
            setIsLoadingLlmDebugLogs(true);
            try {
                const r = await fetch(`${apiUrl}/characters/${contact.id}/llm-debug-logs?limit=60`, { headers: authHeaders });
                const data = await r.json();
                if (!cancelled) {
                    const nextLogs = data.success ? (data.logs || []) : [];
                    setLlmDebugLogs(prevLogs => {
                        if (nextLogs.length > 0) return nextLogs;
                        return prevLogs;
                    });
                }
            } catch (err) {
                if (!cancelled) {
                    console.error('Failed to load LLM debug logs', err);
                }
            } finally {
                if (!cancelled) setIsLoadingLlmDebugLogs(false);
            }
        };

        const handleRefresh = () => fetchLlmDebugLogs();
        fetchLlmDebugLogs();
        const interval = setInterval(fetchLlmDebugLogs, 5000);
        window.addEventListener('refresh_contacts', handleRefresh);
        window.addEventListener('city_update', handleRefresh);

        return () => {
            cancelled = true;
            clearInterval(interval);
            window.removeEventListener('refresh_contacts', handleRefresh);
            window.removeEventListener('city_update', handleRefresh);
        };
    }, [contact?.id, apiUrl]);

    useEffect(() => {
        if (!contact) return;
        if (!isGeneratingSchedule) {
            fetch(`${apiUrl}/city/schedules/${contact.id}`)
                .then(r => r.json())
                .then(data => { if (data.success) setTodaySchedule(data.schedule || []); })
                .catch(() => { });
        }
    }, [isGeneratingSchedule, contact, apiUrl]);

    const refreshStats = async () => {
        const r = await fetch(`${apiUrl}/characters/${contact.id}/context-stats`, { headers: { 'Authorization': `Bearer ${localStorage.getItem('cp_token') || ''}` } });
        const data = await r.json();
        if (data.success) setContextStats(data.stats);
    };

    const handleSweepLimitSave = async () => {
        setIsSavingSweep(true);
        try {
            await fetch(`${apiUrl}/characters/${contact.id}`, {
                method: 'PUT',
                headers: authHeaders,
                body: JSON.stringify({ sweep_limit: sweepLimit })
            });
            await refreshStats();
        } catch (err) {
            console.error('Failed to update sweep limit', err);
        }
        setIsSavingSweep(false);
    };

    const handleQLimitSave = async () => {
        setIsSavingQLimit(true);
        try {
            await fetch(`${apiUrl}/characters/${contact.id}`, {
                method: 'PUT',
                headers: authHeaders,
                body: JSON.stringify({ impression_q_limit: impressionQLimit })
            });
            await refreshStats();
        } catch (err) {
            console.error('Failed to update impression q limit', err);
        }
        setIsSavingQLimit(false);
    };

    const handleContextLimitSave = async () => {
        setIsSavingContextLimit(true);
        try {
            await fetch(`${apiUrl}/characters/${contact.id}`, {
                method: 'PUT',
                headers: authHeaders,
                body: JSON.stringify({ context_msg_limit: contextLimit })
            });
            await refreshStats();
            if (contact) contact.context_msg_limit = contextLimit;
        } catch (err) {
            console.error('Failed to update context limit', err);
        }
        setIsSavingContextLimit(false);
    };

    const handlePrivateSummaryThresholdSave = async () => {
        setIsSavingPrivateSummaryThreshold(true);
        try {
            await fetch(`${apiUrl}/characters/${contact.id}`, {
                method: 'PUT',
                headers: authHeaders,
                body: JSON.stringify({ private_summary_threshold: privateSummaryThreshold })
            });
            await refreshStats();
            if (contact) contact.private_summary_threshold = privateSummaryThreshold;
        } catch (err) {
            console.error('Failed to update private summary threshold', err);
        }
        setIsSavingPrivateSummaryThreshold(false);
    };

    const toggleHistory = async (targetId) => {
        if (expandedHistory[targetId]) {
            setExpandedHistory(prev => ({ ...prev, [targetId]: false }));
            return;
        }
        setExpandedHistory(prev => ({ ...prev, [targetId]: true }));
        if (!impressionHistories[targetId]) {
            try {
                const r = await fetch(`${apiUrl}/characters/${contact.id}/impressions/${targetId}?limit=10`);
                const data = await r.json();
                setImpressionHistories(prev => ({ ...prev, [targetId]: Array.isArray(data) ? data : [] }));
            } catch (e) {
                console.error(e);
            }
        }
    };

    const handleToggleSchedule = async () => {
        const newVal = !isScheduled;
        setIsScheduled(newVal);
        setIsSavingSchedule(true);
        try {
            await fetch(`${apiUrl}/characters/${contact.id}`, {
                method: 'PUT',
                headers: authHeaders,
                body: JSON.stringify({ is_scheduled: newVal ? 1 : 0 })
            });
            if (contact) contact.is_scheduled = newVal ? 1 : 0;
        } catch (err) {
            console.error('Failed to update schedule config', err);
        }
        setIsSavingSchedule(false);
    };

    const handleFreqSave = async () => {
        setIsSavingFreq(true);
        try {
            await fetch(`${apiUrl}/characters/${contact.id}`, {
                method: 'PUT',
                headers: authHeaders,
                body: JSON.stringify({ city_action_frequency: cityActionFreq })
            });
            if (contact) contact.city_action_frequency = cityActionFreq;
        } catch (err) {
            console.error('Failed to update city action frequency', err);
        }
        setIsSavingFreq(false);
    };

    const handleRegenerate = async (targetId) => {
        setRegenLoading(targetId);
        setRegenError(null);
        try {
            const r = await fetch(`${apiUrl}/characters/${contact.id}/relationships/regenerate`, {
                method: 'POST',
                headers: authHeaders,
                body: JSON.stringify({ target_id: targetId })
            });
            const d = await r.json();
            if (!r.ok) {
                setRegenError(d.error || (lang === 'en' ? 'Generation failed' : '生成失败'));
            } else {
                setRelationships(prev => prev.map(rel =>
                    rel.targetId === targetId ? { ...rel, affinity: d.affinity ?? rel.affinity, impression: d.impression ?? rel.impression } : rel
                ));
            }
        } catch (e) {
            console.error(e);
            setRegenError(e.message || (lang === 'en' ? 'Network error' : '网络错误'));
        }
        setRegenLoading(null);
    };

    const forceGenerateSchedule = async () => {
        if (!contact?.id) return;
        setIsRetryingSchedule(true);
        try {
            const res = await fetch(`${apiUrl}/city/schedules/${contact.id}/generate`, {
                method: 'POST',
                headers: authHeaders
            });
            const data = await res.json();
            if (data.success) {
                setTodaySchedule(data.schedule || []);
            } else {
                alert('生成失败: ' + (data.error || '未知错误'));
            }
        } catch (err) {
            console.error('Failed to force generate schedule', err);
            alert('网络请求失败');
        } finally {
            setIsRetryingSchedule(false);
        }
    };

    if (!contact) return null;

    const handleClearHistory = async () => {
        if (!window.confirm(lang === 'en'
            ? `Are you sure you want to completely wipe all history with ${contact.name}?\n\nThis deletes chats, memories, diaries, moments, vector indices, and resets affinity.\n\nThis cannot be undone.`
            : `确定要完全重置与 ${contact.name} 的关系吗？\n\n这将清除：聊天记录、长期记忆、日记、朋友圈、向量索引，并重置好感度。\n\n此操作不可撤销。`)) return;
        try {
            const res = await fetch(`${apiUrl}/data/${contact.id}`, {
                method: 'DELETE',
                headers: { 'Authorization': `Bearer ${localStorage.getItem('cp_token') || ''}` }
            });
            const data = await res.json();
            if (data.success) {
                window.dispatchEvent(new CustomEvent('character_data_wiped', { detail: { characterId: contact.id } }));
                window.dispatchEvent(new Event('refresh_contacts'));
                alert(lang === 'en' ? 'Data wiped successfully.' : '数据已清空。');
                if (onClearHistory) onClearHistory();
            } else {
                alert((lang === 'en' ? 'Wipe failed: ' : '清空失败：') + (data.error || (lang === 'en' ? 'Unknown error' : '未知错误')));
            }
        } catch (e) {
            console.error('Failed to wipe character data:', e);
            alert(lang === 'en' ? 'Failed to wipe character data.' : '清空角色数据失败。');
        }
    };

    const handleRetrySweep = async () => {
        if (!contact?.id) return;
        setIsRetryingSweep(true);
        try {
            const res = await fetch(`${apiUrl}/memories/${contact.id}/sweep`, {
                method: 'POST',
                headers: authHeaders
            });
            const data = await res.json();
            await refreshStats();
            if (!res.ok || !data.success) {
                alert((lang === 'en' ? 'Memory sweep failed: ' : '长时记忆整理失败：') + (data.error || 'Unknown error'));
                return;
            }
            alert(lang === 'en'
                ? `Memory sweep completed. Saved ${data.savedCount ?? 0} memories.`
                : `长时记忆整理完成，新增 ${data.savedCount ?? 0} 条记忆。`);
        } catch (e) {
            console.error('Failed to retry memory sweep', e);
            alert(lang === 'en' ? 'Network request failed.' : '网络请求失败。');
        } finally {
            setIsRetryingSweep(false);
        }
    };

    const handleResetPhysicalState = async () => {
        if (!contact?.id) return;
        if (!window.confirm(lang === 'en'
            ? `Reset ${contact.name}'s negative physical state? This will restore energy and clear sleep/stress-related burden.`
            : `确定要清空 ${contact.name} 的负面生理状态吗？这会恢复精力，并清掉睡眠债、压力和相关干扰。`)) return;
        setIsResettingPhysicalState(true);
        try {
            const res = await fetch(`${apiUrl}/characters/${contact.id}/reset-physical-state`, {
                method: 'POST',
                headers: authHeaders
            });
            const data = await res.json();
            if (!res.ok || !data.success) {
                alert((lang === 'en' ? 'Reset failed: ' : '重置失败：') + (data.error || 'Unknown error'));
                return;
            }
            await refreshStats();
            window.dispatchEvent(new Event('refresh_contacts'));
            window.dispatchEvent(new Event('city_update'));
            alert(lang === 'en' ? 'Negative physical state cleared.' : '负面生理状态已清空。');
        } catch (e) {
            console.error('Failed to reset physical state', e);
            alert(lang === 'en' ? 'Network request failed.' : '网络请求失败。');
        } finally {
            setIsResettingPhysicalState(false);
        }
    };

    const estimatedWithoutCache = contextStats?.estimated_without_cache_tokens ?? 0;
    const estimatedWithCache = contextStats?.estimated_with_cache_tokens ?? 0;
    const lastRoundEstimatedWithoutCache = contextStats?.last_conversation_estimated_without_cache_tokens
        ?? contextStats?.estimated_without_cache_tokens
        ?? 0;
    const estimatedTailTokens = contextStats?.estimated_tail_tokens ?? 0;
    const estimatedDigestTokens = contextStats?.estimated_digest_tokens ?? 0;
    const estimatedWithoutCacheBase = contextStats?.estimated_without_cache_base_tokens ?? 0;
    const estimatedWithCacheBase = contextStats?.estimated_with_cache_base_tokens ?? 0;
    const estimatedWithoutCacheOther = contextStats?.estimated_without_cache_other_tokens ?? 0;
    const estimatedWithCacheOther = contextStats?.estimated_with_cache_other_tokens ?? 0;
    const estimatedWithoutCacheX = contextStats?.estimated_without_cache_x_tokens
        ?? contextStats?.estimated_full_history_tokens
        ?? 0;
    const estimatedWithCacheX = contextStats?.estimated_with_cache_x_tokens
        ?? contextStats?.estimated_history_tokens
        ?? 0;
    const estimatedY = contextStats?.city_x_y ?? 0;
    const estimatedZ = contextStats?.z_memory ?? 0;
    const estimatedMoments = contextStats?.moments ?? 0;
    const estimatedO = contextStats?.q_impression ?? 0;
    const estimatedRagInjectedTokens = contextStats?.estimated_rag_injected_tokens ?? 0;
    const estimatedOtherTokens = contextStats?.last_conversation_other_tokens ?? 0;
    const lastConversationRoutedToCity = Boolean(contextStats?.last_conversation_routed_to_city);
    const lastConversationUsedRag = Boolean(contextStats?.last_conversation_used_rag);
    const lastConversationTopicSwitchDecision = String(contextStats?.last_conversation_topic_switch_decision || '').trim();
    const lastConversationTopicSwitchReason = String(contextStats?.last_conversation_topic_switch_reason || '').trim();
    const lastConversationTopicSwitchFallback = Boolean(contextStats?.last_conversation_topic_switch_fallback);
    const topicSwitchDecisionLabel = (() => {
        if (!lastConversationTopicSwitchDecision) return lang === 'en' ? 'Not triggered' : '未触发';
        if (lastConversationTopicSwitchDecision === 'SWITCH_TOPIC') return lang === 'en' ? 'Switch topic' : '切题';
        if (lastConversationTopicSwitchDecision === 'FOLLOW_UP_ON_RETRIEVED_HISTORY') return lang === 'en' ? 'History follow-up' : '历史追问';
        return lang === 'en' ? 'Continue current topic' : '继续当前话题';
    })();
    const actualInputTokens = contextStats?.last_conversation_prompt_tokens || contextStats?.last_actual_prompt_tokens || 0;
    const actualSavedTokens = Math.max(0, lastRoundEstimatedWithoutCache - actualInputTokens);
    const actualSavedRate = lastRoundEstimatedWithoutCache > 0
        ? Math.round((actualSavedTokens / lastRoundEstimatedWithoutCache) * 100)
        : 0;
    const cacheOnlyHitRatePercent = contextStats?.cache_only_hit_rate_percent ?? 0;
    const cacheOnlySavedTokens = contextStats?.cache_only_saved_tokens ?? 0;
    const totalSavedIncludingRagTokens = contextStats?.total_saved_including_rag_tokens ?? 0;
    const totalSavedIncludingRagRatePercent = contextStats?.total_saved_including_rag_rate_percent ?? 0;

    const formatEmotionLogDelta = (label, before, after) => {
        if (before == null && after == null) return null;
        if (before === after) return null;
        return `${label} ${before ?? '-'}→${after ?? '-'}`;
    };

    const recentConversationDebugLogs = llmDebugLogs
        .filter(log => {
            const contextType = String(log.context_type || '').trim();
            return [
                'private_reply',
                'proactive',
                'timer_wakeup',
                'city_private_reply_directed_action',
                'city_private_self_prompt',
                'hacker_intel_reply'
            ].includes(contextType);
        })
        .slice(0, 12)
        .map(log => ({
            ...log,
            metaObj: parseJsonSafely(log.meta, {}),
            formattedPayload: formatLlmDebugPayload(log.payload)
        }));

    return (
        <div className="memory-drawer" style={{ width: '320px', backgroundColor: '#f7f7f7' }}>
            <div className="memory-header">
                <h3 style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <Settings size={18} /> {t('Chat Settings')}
                </h3>
                <button className="icon-btn" onClick={onClose}>
                    <X size={20} />
                </button>
            </div>
            <div className="memory-content" style={{ padding: '0' }}>
                <div style={{ backgroundColor: '#fff', padding: '20px', display: 'flex', flexDirection: 'column', alignItems: 'center', borderBottom: '1px solid #eee' }}>
                    <img
                        src={resolveAvatarUrl(contact.avatar, apiUrl) || `https://api.dicebear.com/7.x/shapes/svg?seed=${contact.id}`}
                        alt={contact.name}
                        style={{ width: '60px', height: '60px', borderRadius: '50%', marginBottom: '10px', objectFit: 'cover' }}
                    />
                    <div style={{ fontSize: '18px', fontWeight: '500' }}>{contact.name}</div>
                    <div style={{ fontSize: '13px', color: '#999', marginTop: '5px', textAlign: 'center', padding: '0 10px' }}>
                        {contact.persona ? `${contact.persona.substring(0, 50)}...` : (lang === 'en' ? 'No persona set.' : '未设置 Persona。')}
                    </div>
                </div>

                <div style={{ marginTop: '10px', backgroundColor: '#fff', padding: '15px', borderTop: '1px solid #eee', borderBottom: '1px solid #eee' }}>
                    <div style={{ fontSize: '12px', color: '#999', marginBottom: '15px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                        {lang === 'en' ? 'Hidden AI Stats' : 'AI 隐藏数据'}
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '12px', fontSize: '14px' }}>
                        <span>{lang === 'en' ? 'Affinity' : '好感度'}</span>
                        <span style={{ fontWeight: '500', color: contact.affinity >= 80 ? 'var(--accent-color)' : contact.affinity < 30 ? 'var(--danger)' : '#333' }}>
                            {contact.affinity} / 100
                        </span>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '12px', fontSize: '14px' }}>
                        <span>{lang === 'en' ? 'Wallet' : '钱包余额'}</span>
                        <span style={{ fontWeight: '500', color: '#e67e22' }}>💰 ¥{(contact.wallet ?? 0).toFixed(2)}</span>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '12px', fontSize: '14px' }}>
                        <span>{lang === 'en' ? 'Pressure' : '焦虑值'}</span>
                        <span style={{ fontWeight: '500', color: contact.pressure_level > 2 ? 'var(--danger)' : '#333' }}>{contact.pressure_level}</span>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '14px' }}>
                        <span>Status</span>
                        <span style={{ fontWeight: '500', color: contact.is_blocked ? 'var(--danger)' : 'var(--accent-color)' }}>
                            {contact.is_blocked ? (lang === 'en' ? 'Blocked You' : '已拉黑') : (lang === 'en' ? 'Active' : '正常')}
                        </span>
                    </div>
                </div>

                <div style={{ marginTop: '10px', backgroundColor: '#fff', padding: '15px', borderTop: '1px solid #eee', borderBottom: '1px solid #eee' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
                        <div style={{ fontSize: '12px', color: '#999', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                            {lang === 'en' ? 'Long-Term Memory Sweep (W)' : '长时记忆消化量 (W参数)'}
                        </div>
                        {isSavingSweep && <span style={{ fontSize: '11px', color: '#aaa' }}>{lang === 'en' ? 'Saving...' : '保存中...'}</span>}
                    </div>
                    <div style={{ fontSize: '13px', color: '#666', marginBottom: '12px', lineHeight: '1.4' }}>
                        {lang === 'en'
                            ? 'The AI automatically forms long-term memories once this many old messages accumulate. Higher values = richer memory but more token cost.'
                            : '控制系统每次提取长时记忆的积攒阈值。一旦未消化对话达到此数量，后台会立即将其打包成核心记忆。值越大长时记忆越丰富连贯，但提取开销也越大。'}
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '15px' }}>
                        <input type="range" min="10" max="100" step="10" value={sweepLimit} onChange={(e) => setSweepLimit(parseInt(e.target.value, 10))} onMouseUp={handleSweepLimitSave} onTouchEnd={handleSweepLimitSave} style={{ flex: 1, accentColor: 'var(--accent-color)' }} />
                        <div style={{ width: '40px', textAlign: 'right', fontWeight: 'bold', color: 'var(--accent-color)', fontSize: '14px' }}>{sweepLimit}</div>
                    </div>
                    <div style={{ marginTop: '10px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '10px' }}>
                        <div style={{ fontSize: '12px', color: '#666' }}>
                            {lang === 'en' ? 'If the small memory model fails, fix it and retry manually.' : '如果记忆小模型报错，修好后可手动重新整理。'}
                        </div>
                        <button onClick={handleRetrySweep} disabled={isRetryingSweep} style={{ padding: '6px 10px', border: '1px solid var(--accent-color)', color: 'var(--accent-color)', background: '#fff', borderRadius: '6px', cursor: isRetryingSweep ? 'not-allowed' : 'pointer', fontSize: '12px', whiteSpace: 'nowrap' }}>
                            {isRetryingSweep ? (lang === 'en' ? 'Retrying...' : '整理中...') : (lang === 'en' ? 'Retry Sweep' : '重新整理')}
                        </button>
                    </div>
                </div>

                <div style={{ marginTop: '10px', backgroundColor: '#fff', padding: '15px', borderTop: '1px solid #eee', borderBottom: '1px solid #eee' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
                        <div style={{ fontSize: '12px', color: '#999', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                            {lang === 'en' ? 'Context History Inject (Q)' : '印象历史上下文 (Q参数)'}
                        </div>
                        {isSavingQLimit && <span style={{ fontSize: '11px', color: '#aaa' }}>{lang === 'en' ? 'Saving...' : '保存中...'}</span>}
                    </div>
                    <div style={{ fontSize: '13px', color: '#666', marginBottom: '12px', lineHeight: '1.4' }}>
                        {lang === 'en'
                            ? 'The AI forms its persona using Q latest historical impressions regarding the active characters in the same social setting.'
                            : '控制 AI 在多人场景下的前置上下文。在生成回复时，系统会向 AI 提供最多 Q 条有关在场其余角色的往事印象（最新记录）。'}
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '15px' }}>
                        <input type="range" min="0" max="10" step="1" value={impressionQLimit} onChange={(e) => setImpressionQLimit(parseInt(e.target.value, 10))} onMouseUp={handleQLimitSave} onTouchEnd={handleQLimitSave} style={{ flex: 1, accentColor: 'var(--accent-color)' }} />
                        <div style={{ width: '40px', textAlign: 'right', fontWeight: 'bold', color: 'var(--accent-color)', fontSize: '14px' }}>{impressionQLimit}</div>
                    </div>
                </div>

                <div style={{ marginTop: '10px', backgroundColor: '#fff', padding: '15px', borderTop: '1px solid #eee', borderBottom: '1px solid #eee' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
                        <div style={{ fontSize: '12px', color: '#999', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                            {lang === 'en' ? 'Private Context Window (R)' : '私聊上下文窗口 (R参数)'}
                        </div>
                        {isSavingContextLimit && <span style={{ fontSize: '11px', color: '#aaa' }}>{lang === 'en' ? 'Saving...' : '保存中...'}</span>}
                    </div>
                    <div style={{ fontSize: '13px', color: '#666', marginBottom: '12px', lineHeight: '1.4' }}>
                        {lang === 'en'
                            ? 'How many recent private messages the AI can read. Older messages stay in history but are not injected into the live prompt.'
                            : '控制私聊中最近多少条消息会进入 AI 的实时上下文。更早的消息仍保留在历史里，但不会继续注入当前提示词。'}
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '15px' }}>
                        <input type="range" min="10" max="200" step="10" value={contextLimit} onChange={(e) => setContextLimit(parseInt(e.target.value, 10))} onMouseUp={handleContextLimitSave} onTouchEnd={handleContextLimitSave} style={{ flex: 1, accentColor: 'var(--accent-color)' }} />
                        <div style={{ width: '40px', textAlign: 'right', fontWeight: 'bold', color: 'var(--accent-color)', fontSize: '14px' }}>{contextLimit}</div>
                    </div>
                </div>

                <div style={{ marginTop: '10px', backgroundColor: '#fff', padding: '15px', borderTop: '1px solid #eee', borderBottom: '1px solid #eee' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
                        <div style={{ fontSize: '12px', color: '#999', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                            {lang === 'en' ? 'Private Summary Threshold (S)' : '私聊摘要阈值 (S参数)'}
                        </div>
                        {isSavingPrivateSummaryThreshold && <span style={{ fontSize: '11px', color: '#aaa' }}>{lang === 'en' ? 'Saving...' : '保存中...'}</span>}
                    </div>
                    <div style={{ fontSize: '13px', color: '#666', marginBottom: '12px', lineHeight: '1.4' }}>
                        {lang === 'en'
                            ? 'When messages outside the R raw window accumulate to S, the small model must summarize them before the reply continues. The live prompt reads up to 3 summaries plus the R raw messages.'
                            : '当 R 原文窗口外的未摘要消息积攒到 S 条时，回复前必须先调用小模型总结。实时输入只读取最多 3 轮摘要 + R 条原文；总结失败会中止本轮并提示重试。'}
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '15px' }}>
                        <input type="range" min="5" max="100" step="5" value={privateSummaryThreshold} onChange={(e) => setPrivateSummaryThreshold(parseInt(e.target.value, 10))} onMouseUp={handlePrivateSummaryThresholdSave} onTouchEnd={handlePrivateSummaryThresholdSave} style={{ flex: 1, accentColor: 'var(--accent-color)' }} />
                        <div style={{ width: '40px', textAlign: 'right', fontWeight: 'bold', color: 'var(--accent-color)', fontSize: '14px' }}>{privateSummaryThreshold}</div>
                    </div>
                    <div style={{ marginTop: '10px', fontSize: '12px', color: '#666', lineHeight: 1.5 }}>
                        {lang === 'en' ? 'Summary progress: ' : '摘要积攒：'}
                        <strong>{contextStats?.private_summary_pending_count ?? 0} / {contextStats?.private_summary_threshold ?? privateSummaryThreshold}</strong>
                        {lang === 'en' ? ` pending, ${contextStats?.private_summary_active_count ?? 0} active summaries.` : ` 条待总结，当前读取 ${contextStats?.private_summary_active_count ?? 0} 轮摘要。`}
                    </div>
                    {!!contextStats?.private_summary_last_error && (
                        <div style={{ marginTop: '8px', padding: '8px 10px', background: '#fff1f1', border: '1px solid #ffc0c0', borderRadius: '6px', color: '#c0392b', fontSize: '12px', lineHeight: 1.5 }}>
                            <strong>{lang === 'en' ? 'Summary Error: ' : '摘要失败：'}</strong>{contextStats.private_summary_last_error}
                        </div>
                    )}
                </div>

                <div style={{ marginTop: '10px', backgroundColor: '#fff', padding: '15px', borderTop: '1px solid #eee', borderBottom: '1px solid #eee' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
                        <div style={{ fontSize: '13px', fontWeight: 'bold', color: '#333' }}>
                            {lang === 'en' ? '🧠 AI Context Focus' : '🧠 AI 上下文焦点'}
                        </div>
                    </div>
                    {contextStats ? (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', fontSize: '12px' }}>
                            <div style={{ padding: '12px', borderRadius: '10px', background: '#eff6ff', border: '1px solid #bfdbfe' }}>
                                <div style={{ fontSize: '12px', color: '#2563eb', marginBottom: '6px' }}>
                                    {lang === 'en' ? 'Actual token saved last round' : '上一轮实际省下的 token'}
                                </div>
                                <div style={{ fontSize: '26px', fontWeight: '800', color: '#1d4ed8', lineHeight: 1.1 }}>
                                    {actualSavedRate}%
                                </div>
                                <div style={{ fontSize: '12px', color: '#1e40af', marginTop: '6px', lineHeight: 1.5 }}>
                                    {lang === 'en'
                                        ? `About ${actualSavedTokens} tokens were saved in the last real request.`
                                        : `按上一轮真实输入算，大约少喂了 ${actualSavedTokens} 个 token。`}
                                </div>
                            </div>
                            <div style={{ display: 'flex', justifyContent: 'space-between' }}><span style={{ color: '#666' }}>{lang === 'en' ? 'Estimated Without Cache' : '无缓存预估 token'}</span><span style={{ fontWeight: '700', color: '#c0392b' }}>{estimatedWithoutCache} T</span></div>
                            <div style={{ display: 'flex', justifyContent: 'space-between' }}><span style={{ color: '#666' }}>{lang === 'en' ? 'Estimated With Cache' : '有缓存后预估 token'}</span><span style={{ fontWeight: '700', color: '#2c3e50' }}>{estimatedWithCache} T</span></div>
                            <div style={{ display: 'flex', justifyContent: 'space-between' }}><span style={{ color: '#666' }}>{lang === 'en' ? 'Tail Tokens' : '尾巴 token'}</span><span style={{ fontWeight: '700', color: '#27ae60' }}>{estimatedTailTokens} T</span></div>
                            <div style={{ display: 'flex', justifyContent: 'space-between', borderTop: '1px dashed #eee', paddingTop: '8px', marginTop: '4px' }}><span style={{ color: '#666', fontWeight: '600' }}>{lang === 'en' ? 'Without Cache Breakdown' : '无缓存预估明细'}</span><span style={{ fontWeight: '700', color: '#c0392b' }}>{estimatedWithoutCache} T</span></div>
                            <div style={{ display: 'flex', justifyContent: 'space-between' }}><span style={{ color: '#666' }}>{lang === 'en' ? 'Base' : '基础设定与系统指令 (Base)'}</span><span style={{ fontWeight: '500', color: '#333' }}>{estimatedWithoutCacheBase} T</span></div>
                            <div style={{ display: 'flex', justifyContent: 'space-between' }}><span style={{ color: '#666' }}>{lang === 'en' ? 'Private Window (X)' : '私聊上下文窗口 (X参数)'}</span><span style={{ fontWeight: '500', color: '#27ae60' }}>{estimatedWithoutCacheX} T</span></div>
                            <div style={{ display: 'flex', justifyContent: 'space-between' }}><span style={{ color: '#666' }}>{lang === 'en' ? 'City Context (Y)' : '商业街环境感知 (Y参数)'}</span><span style={{ fontWeight: '500', color: '#e67e22' }}>{estimatedY} T</span></div>
                            <div style={{ display: 'flex', justifyContent: 'space-between' }}><span style={{ color: '#666' }}>{lang === 'en' ? 'Deep Memory (Z)' : '深层记忆调用 (Z参数)'}</span><span style={{ fontWeight: '500', color: '#7f8c8d' }}>{estimatedZ} T</span></div>
                            <div style={{ display: 'flex', justifyContent: 'space-between' }}><span style={{ color: '#666' }}>{lang === 'en' ? 'Moments Feed' : '朋友圈上下文'}</span><span style={{ fontWeight: '500', color: '#7f8c8d' }}>{estimatedMoments} T</span></div>
                            <div style={{ display: 'flex', justifyContent: 'space-between' }}><span style={{ color: '#666' }}>{lang === 'en' ? 'Impression History (Q)' : '往事印象注入 (Q参数)'}</span><span style={{ fontWeight: '500', color: '#c0392b' }}>{estimatedO} T</span></div>
                            <div style={{ display: 'flex', justifyContent: 'space-between' }}><span style={{ color: '#666' }}>{lang === 'en' ? 'Other Overhead' : '其他类 T'}</span><span style={{ fontWeight: '500', color: '#7c3aed' }}>{estimatedWithoutCacheOther} T</span></div>
                            <div style={{ display: 'flex', justifyContent: 'space-between', borderTop: '1px dashed #eee', paddingTop: '8px', marginTop: '4px' }}><span style={{ color: '#666', fontWeight: '600' }}>{lang === 'en' ? 'With Cache Breakdown' : '有缓存后预估明细'}</span><span style={{ fontWeight: '700', color: '#2c3e50' }}>{estimatedWithCache} T</span></div>
                            <div style={{ display: 'flex', justifyContent: 'space-between' }}><span style={{ color: '#666' }}>{lang === 'en' ? 'Base' : '基础设定与系统指令 (Base)'}</span><span style={{ fontWeight: '500', color: '#333' }}>{estimatedWithCacheBase} T</span></div>
                            <div style={{ display: 'flex', justifyContent: 'space-between' }}><span style={{ color: '#666' }}>{lang === 'en' ? 'Digest Summary' : '摘要 digest'}</span><span style={{ fontWeight: '500', color: '#2563eb' }}>{estimatedDigestTokens} T</span></div>
                            <div style={{ display: 'flex', justifyContent: 'space-between' }}><span style={{ color: '#666' }}>{lang === 'en' ? 'Private Window (X)' : '私聊上下文窗口 (X参数)'}</span><span style={{ fontWeight: '500', color: '#27ae60' }}>{estimatedWithCacheX} T</span></div>
                            <div style={{ display: 'flex', justifyContent: 'space-between' }}><span style={{ color: '#666' }}>{lang === 'en' ? 'City Context (Y)' : '商业街环境感知 (Y参数)'}</span><span style={{ fontWeight: '500', color: '#e67e22' }}>{estimatedY} T</span></div>
                            <div style={{ display: 'flex', justifyContent: 'space-between' }}><span style={{ color: '#666' }}>{lang === 'en' ? 'Deep Memory (Z)' : '深层记忆调用 (Z参数)'}</span><span style={{ fontWeight: '500', color: '#7f8c8d' }}>{estimatedZ} T</span></div>
                            <div style={{ display: 'flex', justifyContent: 'space-between' }}><span style={{ color: '#666' }}>{lang === 'en' ? 'Moments Feed' : '朋友圈上下文'}</span><span style={{ fontWeight: '500', color: '#7f8c8d' }}>{estimatedMoments} T</span></div>
                            <div style={{ display: 'flex', justifyContent: 'space-between' }}><span style={{ color: '#666' }}>{lang === 'en' ? 'Impression History (Q)' : '往事印象注入 (Q参数)'}</span><span style={{ fontWeight: '500', color: '#c0392b' }}>{estimatedO} T</span></div>
                            <div style={{ display: 'flex', justifyContent: 'space-between' }}><span style={{ color: '#666' }}>{lang === 'en' ? 'Other Overhead' : '其他类 T'}</span><span style={{ fontWeight: '500', color: '#7c3aed' }}>{estimatedWithCacheOther} T</span></div>
                            <div style={{ display: 'flex', justifyContent: 'space-between' }}><span style={{ color: '#666' }}>{lang === 'en' ? 'Tail Tokens' : '尾巴 token'}</span><span style={{ fontWeight: '700', color: '#27ae60' }}>{estimatedTailTokens} T</span></div>
                            <div style={{ display: 'flex', justifyContent: 'space-between', borderTop: '1px dashed #eee', paddingTop: '8px', marginTop: '4px' }}><span style={{ color: '#666', fontWeight: '600' }}>{lang === 'en' ? 'Actual Input Tokens' : '实际输入 token'}</span><span style={{ fontWeight: '700', color: '#8e44ad' }}>{actualInputTokens} T</span></div>
                            <div style={{ display: 'flex', justifyContent: 'space-between' }}><span style={{ color: '#666' }}>{lang === 'en' ? 'Last Round RAG Injected' : '上一轮 RAG 注入 token'}</span><span style={{ fontWeight: '500', color: '#d97706' }}>{estimatedRagInjectedTokens} T</span></div>
                            <div style={{ display: 'flex', justifyContent: 'space-between' }}><span style={{ color: '#666' }}>{lang === 'en' ? 'Last Round Other Overhead' : '上一轮其他类 T'}</span><span style={{ fontWeight: '500', color: '#7c3aed' }}>{estimatedOtherTokens} T</span></div>
                            <div style={{ display: 'flex', justifyContent: 'space-between' }}><span style={{ color: '#666' }}>{lang === 'en' ? 'Last Round Routed to City' : '上一轮是否路由到商业街内容'}</span><span style={{ fontWeight: '500', color: lastConversationRoutedToCity ? '#e67e22' : '#7f8c8d' }}>{lastConversationRoutedToCity ? (lang === 'en' ? 'Yes' : '是') : (lang === 'en' ? 'No' : '否')}</span></div>
                            <div style={{ display: 'flex', justifyContent: 'space-between' }}><span style={{ color: '#666' }}>{lang === 'en' ? 'Last Round Used RAG' : '上一轮是否使用了 RAG'}</span><span style={{ fontWeight: '500', color: lastConversationUsedRag ? '#8e44ad' : '#7f8c8d' }}>{lastConversationUsedRag ? (lang === 'en' ? 'Yes' : '是') : (lang === 'en' ? 'No' : '否')}</span></div>
                            <div style={{ display: 'flex', justifyContent: 'space-between' }}><span style={{ color: '#666' }}>{lang === 'en' ? 'Last Round Topic Switch Result' : '上一轮切题判断结果'}</span><span style={{ fontWeight: '500', color: lastConversationTopicSwitchDecision ? '#2563eb' : '#7f8c8d' }}>{topicSwitchDecisionLabel}</span></div>
                            {lastConversationTopicSwitchDecision && (
                                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                                    <span style={{ color: '#666' }}>{lang === 'en' ? 'Topic Switch Reason' : '切题判断原因'}</span>
                                    <span style={{ fontWeight: '500', color: lastConversationTopicSwitchFallback ? '#d97706' : '#2563eb' }}>
                                        {lastConversationTopicSwitchReason || (lang === 'en' ? 'unspecified' : '未标注')}
                                        {lastConversationTopicSwitchFallback ? (lang === 'en' ? ' (fallback)' : '（回退）') : ''}
                                    </span>
                                </div>
                            )}
                            <div style={{ display: 'flex', justifyContent: 'space-between' }}><span style={{ color: '#666' }}>{lang === 'en' ? 'Cache Hit Rate (No RAG)' : '排除 RAG 的缓存命中率'}</span><span style={{ fontWeight: '500', color: '#2563eb' }}>{cacheOnlyHitRatePercent}%</span></div>
                            <div style={{ display: 'flex', justifyContent: 'space-between' }}><span style={{ color: '#666' }}>{lang === 'en' ? 'Cache Saved (No RAG)' : '排除 RAG 的缓存节约 token'}</span><span style={{ fontWeight: '500', color: '#2563eb' }}>{cacheOnlySavedTokens} T</span></div>
                            <div style={{ display: 'flex', justifyContent: 'space-between' }}><span style={{ color: '#666' }}>{lang === 'en' ? 'Cache + RAG Saved' : '缓存库 + RAG 总节约 token'}</span><span style={{ fontWeight: '500', color: '#16a34a' }}>{totalSavedIncludingRagTokens} T ({totalSavedIncludingRagRatePercent}%)</span></div>
                            <div style={{ display: 'flex', justifyContent: 'space-between', borderTop: '1px dashed #eee', paddingTop: '8px', marginTop: '4px' }}><span style={{ color: '#666', fontWeight: '600' }}>{lang === 'en' ? 'Memory Sweep Progress (W)' : '长时记忆消化积攒 (W参数)'}</span><span style={{ fontWeight: '500', color: (contextStats?.w_unsummarized_count ?? 0) >= (contextStats?.w_sweep_limit ?? 0) ? '#c0392b' : '#34495e' }}>{contextStats?.w_unsummarized_count ?? 0} / {contextStats?.w_sweep_limit ?? 0} {lang === 'en' ? 'msgs' : '条'}</span></div>
                            {!!contextStats?.w_last_error && <div style={{ marginTop: '6px', padding: '8px 10px', background: '#fff1f1', border: '1px solid #ffc0c0', borderRadius: '6px', color: '#c0392b', fontSize: '12px', lineHeight: 1.5 }}><strong>{lang === 'en' ? 'Sweep Error: ' : '整理失败：'}</strong>{contextStats.w_last_error}</div>}
                            {(contextStats?.w_last_run_at ?? 0) > 0 && <div style={{ display: 'flex', justifyContent: 'space-between' }}><span style={{ color: '#666' }}>{lang === 'en' ? 'Last Sweep Attempt' : '上次整理尝试'}</span><span style={{ fontWeight: '500', color: '#555' }}>{new Date(contextStats.w_last_run_at).toLocaleString()}</span></div>}
                            {(contextStats?.w_last_success_at ?? 0) > 0 && <div style={{ display: 'flex', justifyContent: 'space-between' }}><span style={{ color: '#666' }}>{lang === 'en' ? 'Last Sweep Success' : '上次整理成功'}</span><span style={{ fontWeight: '500', color: '#2e7d32' }}>{new Date(contextStats.w_last_success_at).toLocaleString()}</span></div>}
                            <div style={{ display: 'flex', justifyContent: 'space-between' }}><span style={{ color: '#666' }}>{lang === 'en' ? 'Last Saved Memories' : '上次新增记忆'}</span><span style={{ fontWeight: '500', color: '#8e44ad' }}>{contextStats?.w_last_saved_count ?? 0}</span></div>
                        </div>
                    ) : (
                        <div style={{ fontSize: '12px', color: '#999', textAlign: 'center', padding: '10px 0' }}>{lang === 'en' ? 'Calculating...' : '计算中...'}</div>
                    )}
                </div>

                <div style={{ marginTop: '10px', backgroundColor: '#fff', padding: '15px', borderTop: '1px solid #eee', borderBottom: '1px solid #eee' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
                        <div style={{ fontSize: '13px', fontWeight: 'bold', color: '#333', display: 'flex', alignItems: 'center', gap: '6px' }}>
                            🌆 {lang === 'en' ? 'City Activity Frequency (r/hr)' : '商业街活动频率 (次/小时)'}
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                            {isSavingFreq && <span style={{ fontSize: '11px', color: '#aaa' }}>{lang === 'en' ? 'Saving...' : '保存中...'}</span>}
                            <span style={{ fontWeight: '700', color: '#e67e22', fontSize: '15px' }}>{cityActionFreq}</span>
                        </div>
                    </div>
                    <input type="range" min="1" max="30" step="1" value={cityActionFreq} onChange={(e) => setCityActionFreq(parseInt(e.target.value, 10))} onMouseUp={handleFreqSave} onTouchEnd={handleFreqSave} style={{ width: '100%', accentColor: '#e67e22' }} />
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '10px', color: '#bbb', marginTop: '2px' }}><span>1</span><span>10</span><span>20</span><span>30</span></div>
                    <div style={{ fontSize: '10px', color: '#999', marginTop: '6px', lineHeight: 1.5 }}>
                        {lang === 'en' ? 'How many times per in-game hour this character acts in the city.' : '角色每个小时在商业街随机行动的次数。值越高越活跃，但 API 消耗也会增加。'}
                    </div>
                </div>

                <div style={{ marginTop: '10px', backgroundColor: '#fff', padding: '15px', borderTop: '1px solid #eee', borderBottom: '1px solid #eee' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
                        <div style={{ fontSize: '13px', fontWeight: 'bold', color: '#333', display: 'flex', alignItems: 'center', gap: '6px' }}>📅 {lang === 'en' ? "Today's Schedule" : '今日日程'}</div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                            {isSavingSchedule && <span style={{ fontSize: '11px', color: '#aaa' }}>...</span>}
                            <label style={{ display: 'flex', alignItems: 'center', cursor: 'pointer', gap: '6px' }}>
                                <span style={{ fontSize: '12px', color: isScheduled ? 'var(--accent-color)' : '#999' }}>{isScheduled ? (lang === 'en' ? 'Enabled' : '启用') : (lang === 'en' ? 'Disabled' : '禁用')}</span>
                                <input type="checkbox" checked={isScheduled} onChange={handleToggleSchedule} style={{ accentColor: 'var(--accent-color)', width: '16px', height: '16px', cursor: 'pointer' }} />
                            </label>
                        </div>
                    </div>
                    {!isScheduled ? (
                        <div style={{ fontSize: '12px', color: '#999', textAlign: 'center', padding: '10px 0', background: '#f5f5f5', borderRadius: '6px' }}>{lang === 'en' ? 'Free roam mode. The AI will not follow a set schedule.' : '自由模式。角色会根据当前状态和想法自由行动。'}</div>
                    ) : isGeneratingSchedule || isRetryingSchedule ? (
                        <div style={{ padding: '20px 0', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '10px' }}>
                            <RefreshCw className="spinner" size={18} color="var(--accent-color)" style={{ animation: 'spin 1s linear infinite' }} />
                            <div style={{ fontSize: '12px', color: '#666' }}>🤖 {lang === 'en' ? 'AI is thinking about today...' : 'AI 正在生成今日日程...'}</div>
                        </div>
                    ) : todaySchedule.length === 0 ? (
                        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '15px 0', gap: '8px' }}>
                            <div style={{ fontSize: '12px', color: '#999', textAlign: 'center' }}>{lang === 'en' ? 'Schedule not generated yet.' : '今日日程尚未生成...'}</div>
                            <button onClick={forceGenerateSchedule} style={{ padding: '6px 12px', background: 'var(--accent-color)', color: '#fff', border: 'none', borderRadius: '4px', fontSize: '12px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '4px' }}>
                                <RefreshCw size={14} /> {lang === 'en' ? 'Force Generate' : '强制重新生成'}
                            </button>
                        </div>
                    ) : (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                            {todaySchedule.map((task, idx) => {
                                let statusIcon = '🕒';
                                let statusColor = '#666';
                                if (task.status === 'completed') {
                                    statusIcon = '✅';
                                    statusColor = '#27ae60';
                                } else if (task.status === 'missed') {
                                    statusIcon = '❌';
                                    statusColor = '#e74c3c';
                                }
                                return (
                                    <div key={idx} style={{ display: 'flex', alignItems: 'center', background: '#f8f9fa', padding: '8px 10px', borderRadius: '6px', borderLeft: `3px solid ${statusColor}` }}>
                                        <div style={{ fontSize: '13px', fontWeight: 'bold', minWidth: '45px', color: '#555' }}>{String(task.hour).padStart(2, '0')}:00</div>
                                        <div style={{ flex: 1, paddingLeft: '8px' }}>
                                            <div style={{ fontSize: '13px', color: '#333' }}>{lang === 'en' ? `Go to [${task.action}]` : `前往 [${task.action}]`}</div>
                                            <div style={{ fontSize: '11px', color: '#888', marginTop: '2px' }}>{task.reason}</div>
                                        </div>
                                        <div style={{ fontSize: '16px', title: task.status }}>{statusIcon}</div>
                                    </div>
                                );
                            })}
                        </div>
                    )}
                </div>

                {(contact.inventory && contact.inventory.length > 0) && (
                    <div style={{ marginTop: '10px', backgroundColor: '#fff', padding: '15px', borderTop: '1px solid #eee', borderBottom: '1px solid #eee' }}>
                        <div style={{ fontSize: '12px', color: '#999', marginBottom: '12px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>{lang === 'en' ? 'Backpack / Inventory' : '背包物品'}</div>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                            {contact.inventory.map((item, idx) => (
                                <div key={`inv-${item.id || idx}`} style={{ display: 'flex', alignItems: 'center', background: '#f8f9fa', padding: '8px 10px', borderRadius: '6px' }}>
                                    <div style={{ fontSize: '18px', marginRight: '10px' }}>{item.emoji || '📦'}</div>
                                    <div style={{ flex: 1 }}>
                                        <div style={{ fontSize: '14px', fontWeight: '500', color: '#333' }}>{item.name}</div>
                                        {(item.description || item.effect) && <div style={{ fontSize: '11px', color: '#888', marginTop: '2px' }}>{item.description || item.effect}</div>}
                                    </div>
                                    <div style={{ fontSize: '13px', fontWeight: '600', color: '#666' }}>x{item.quantity}</div>
                                </div>
                            ))}
                        </div>
                    </div>
                )}

                <div style={{ marginTop: '10px', backgroundColor: '#fff', padding: '15px', borderTop: '1px solid #eee', borderBottom: '1px solid #eee' }}>
                    <div style={{ fontSize: '12px', color: '#999', marginBottom: '12px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                        {lang === 'en' ? `${contact.name}'s Impressions of Others` : `${contact.name} 对其他角色的印象`}
                    </div>
                    {relationships.length === 0 ? (
                        <div style={{ fontSize: '13px', color: '#bbb', fontStyle: 'italic' }}>{lang === 'en' ? 'No relationships yet.' : '还没有角色关系。'}</div>
                    ) : (
                        relationships.map(rel => (
                            <div key={rel.targetId} style={{ marginBottom: '12px', padding: '10px', background: '#f8f9fa', borderRadius: '8px' }}>
                                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '6px' }}>
                                    <img src={resolveAvatarUrl(rel.targetAvatar, apiUrl) || `https://api.dicebear.com/7.x/shapes/svg?seed=${rel.targetName}`} alt="" style={{ width: 28, height: 28, borderRadius: '50%', objectFit: 'cover' }} />
                                    <div style={{ flex: 1 }}>
                                        <span style={{ fontWeight: '500', fontSize: '13px' }}>{rel.targetName}</span>
                                        <span style={{ fontSize: '11px', color: '#999', marginLeft: '6px' }}>❤️ {rel.affinity ?? '?'}</span>
                                    </div>
                                    <button onClick={() => handleRegenerate(rel.targetId)} disabled={regenLoading === rel.targetId} title={lang === 'en' ? 'Regenerate this character\'s impression via AI' : '通过 AI 重新生成这个角色的印象'} style={{ background: 'none', border: '1px solid #ddd', borderRadius: '4px', padding: '2px 6px', cursor: 'pointer', fontSize: '11px', color: 'var(--accent-color)', display: 'flex', alignItems: 'center', gap: '3px' }}>
                                        <RefreshCw size={10} /> {regenLoading === rel.targetId ? '...' : (lang === 'en' ? 'Regen' : '刷新')}
                                    </button>
                                </div>
                                {rel.impression && <div style={{ fontSize: '12px', color: '#666', lineHeight: '1.4', fontStyle: 'italic' }}>"{rel.impression}"</div>}
                                <div style={{ marginTop: '8px', borderTop: '1px dashed #ddd', paddingTop: '6px' }}>
                                    <button onClick={() => toggleHistory(rel.targetId)} style={{ background: 'none', border: 'none', color: '#aaa', fontSize: '11px', cursor: 'pointer', padding: '0', display: 'flex', alignItems: 'center', gap: '4px' }}>
                                        {expandedHistory[rel.targetId] ? (lang === 'en' ? 'Hide History ▲' : '隐藏历史 ▲') : (lang === 'en' ? 'Show History ▼' : '查看历史 ▼')}
                                    </button>
                                    {expandedHistory[rel.targetId] && (
                                        <div style={{ marginTop: '8px', display: 'flex', flexDirection: 'column', gap: '6px' }}>
                                            {!impressionHistories[rel.targetId] ? (
                                                <div style={{ fontSize: '11px', color: '#ccc' }}>Loading...</div>
                                            ) : impressionHistories[rel.targetId].length === 0 ? (
                                                <div style={{ fontSize: '11px', color: '#ccc' }}>{lang === 'en' ? 'No detailed history.' : '暂无详细历史。'}</div>
                                            ) : (
                                                impressionHistories[rel.targetId].map((h, i) => (
                                                    <div key={i} style={{ fontSize: '11px', background: '#fff', padding: '6px', borderRadius: '4px', borderLeft: '2px solid var(--accent-color)' }}>
                                                        <div style={{ color: '#999', marginBottom: '2px', display: 'flex', justifyContent: 'space-between' }}>
                                                            <span>[{h.trigger_event}]</span>
                                                            <span>{new Date(h.timestamp).toLocaleDateString()}</span>
                                                        </div>
                                                        <div style={{ color: '#555', fontStyle: 'italic' }}>"{h.impression}"</div>
                                                    </div>
                                                ))
                                            )}
                                        </div>
                                    )}
                                </div>
                            </div>
                        ))
                    )}
                    {regenError && <div style={{ marginTop: '8px', padding: '6px 10px', background: '#fff1f1', border: '1px solid #ffc0c0', borderRadius: '6px', fontSize: '12px', color: '#c0392b' }}>⚠️ {regenError}</div>}
                </div>

                <div style={{ marginTop: '10px', backgroundColor: '#fff', padding: '15px', borderTop: '1px solid #eee', borderBottom: '1px solid #eee' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
                        <div style={{ fontSize: '13px', fontWeight: 'bold', color: '#333' }}>
                            {lang === 'en' ? 'Current Live State' : '当前实时状态'}
                        </div>
                    </div>
                    <div style={{ fontSize: '12px', color: '#666', marginBottom: '10px', lineHeight: '1.5' }}>
                        {lang === 'en'
                            ? 'This is the emotion and physical state currently in effect for the character.'
                            : '这里显示的是角色此刻真正生效的实时情绪和生理状态，不是历史日志。'}
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '14px' }}>
                            <span>{lang === 'en' ? 'Emotion' : '情绪'}</span>
                            <span style={{ fontWeight: '600', color: currentEmotion?.color || '#333' }}>
                                {currentEmotion ? `${currentEmotion.emoji} ${currentEmotion.label}` : '-'}
                            </span>
                        </div>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '14px' }}>
                            <span>{lang === 'en' ? 'Physical' : '生理状态'}</span>
                            <span style={{ fontWeight: '600', color: currentPhysical?.color || '#333' }}>
                                {currentPhysical ? `${currentPhysical.emoji} ${currentPhysical.label}` : '-'}
                            </span>
                        </div>
                    </div>
                </div>

                <div style={{ marginTop: '10px', backgroundColor: '#fff', padding: '15px', borderTop: '1px solid #eee', borderBottom: '1px solid #eee' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
                        <div style={{ fontSize: '13px', fontWeight: 'bold', color: '#333' }}>
                            {lang === 'en' ? 'Emotion Change Log' : '情绪变化日志'}
                        </div>
                        <div style={{ fontSize: '11px', color: '#999' }}>
                            {isLoadingEmotionLogs ? (lang === 'en' ? 'Loading...' : '加载中...') : (lang === 'en' ? 'Auto refresh 5s' : '5秒自动刷新')}
                        </div>
                    </div>
                    <div style={{ fontSize: '12px', color: '#666', marginBottom: '10px', lineHeight: '1.5' }}>
                        {lang === 'en'
                            ? 'Shows when emotion state changed, what caused it, and which hidden values moved.'
                            : '这里记录的是情绪变化历史；如果上面实时状态变了但这里没新增，通常说明这次只是重复声明了同一种情绪。'}
                    </div>
                    {emotionLogs.length === 0 ? (
                        <div style={{ fontSize: '12px', color: '#999', textAlign: 'center', padding: '10px 0', background: '#f8f9fa', borderRadius: '6px' }}>
                            {isLoadingEmotionLogs ? (lang === 'en' ? 'Loading emotion logs...' : '正在读取情绪日志...') : (lang === 'en' ? 'No emotion changes logged yet.' : '暂时还没有情绪变化记录。')}
                        </div>
                    ) : (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', maxHeight: '340px', overflowY: 'auto', paddingRight: '2px' }}>
                            {emotionLogs.map(log => {
                                const deltas = [
                                    formatEmotionLogDelta(lang === 'en' ? 'Mood' : '心情', log.old_mood, log.new_mood),
                                    formatEmotionLogDelta(lang === 'en' ? 'Stress' : '压力', log.old_stress, log.new_stress),
                                    formatEmotionLogDelta(lang === 'en' ? 'Social' : '社交需求', log.old_social_need, log.new_social_need),
                                    formatEmotionLogDelta(lang === 'en' ? 'Pressure' : '焦虑值', log.old_pressure, log.new_pressure),
                                    formatEmotionLogDelta(lang === 'en' ? 'Jealousy' : '嫉妒值', log.old_jealousy, log.new_jealousy)
                                ].filter(Boolean);
                                return (
                                    <div key={log.id} style={{ background: '#f8f9fa', borderRadius: '8px', padding: '10px', borderLeft: '3px solid #ffb74d' }}>
                                        <div style={{ display: 'flex', justifyContent: 'space-between', gap: '10px', marginBottom: '4px' }}>
                                            <div style={{ fontSize: '12px', fontWeight: '600', color: '#333' }}>
                                                {(log.old_state || (lang === 'en' ? 'Unknown' : '未知'))} → {(log.new_state || (lang === 'en' ? 'Unknown' : '未知'))}
                                            </div>
                                            <div style={{ fontSize: '11px', color: '#999', whiteSpace: 'nowrap' }}>
                                                {log.timestamp ? new Date(log.timestamp).toLocaleString() : '-'}
                                            </div>
                                        </div>
                                        <div style={{ fontSize: '11px', color: '#b26a00', marginBottom: '6px' }}>
                                            {lang === 'en' ? 'Source: ' : '来源：'}{log.source || '-'}
                                        </div>
                                        <div style={{ fontSize: '12px', color: '#555', lineHeight: '1.5' }}>
                                            {log.reason || (lang === 'en' ? 'No explicit reason.' : '没有记录到明确原因。')}
                                        </div>
                                        {deltas.length > 0 && (
                                            <div style={{ marginTop: '6px', fontSize: '11px', color: '#777', lineHeight: '1.5' }}>
                                                {deltas.join(' | ')}
                                            </div>
                                        )}
                                    </div>
                                );
                            })}
                        </div>
                    )}
                </div>

                <div style={{ marginTop: '10px', backgroundColor: '#fff', padding: '15px', borderTop: '1px solid #eee', borderBottom: '1px solid #eee' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
                        <div style={{ fontSize: '13px', fontWeight: 'bold', color: '#333' }}>
                            {lang === 'en' ? 'Recent LLM Input / Output' : '最近 LLM 输入输出'}
                        </div>
                        <div style={{ fontSize: '11px', color: '#999' }}>
                            {isLoadingLlmDebugLogs ? (lang === 'en' ? 'Loading...' : '加载中...') : (lang === 'en' ? 'Auto refresh 5s' : '5秒自动刷新')}
                        </div>
                    </div>
                    <div style={{ fontSize: '12px', color: '#666', marginBottom: '10px', lineHeight: '1.5' }}>
                        {lang === 'en'
                            ? 'Shows the latest private reply / proactive prompt payloads so we can see what the model just received and produced.'
                            : '这里会显示私聊回复和主动发消息的最近 prompt / 输出，方便直接核对模型刚刚看到了什么、回了什么。'}
                    </div>
                    {recentConversationDebugLogs.length === 0 ? (
                        <div style={{ fontSize: '12px', color: '#999', textAlign: 'center', padding: '10px 0', background: '#f8f9fa', borderRadius: '6px' }}>
                            {isLoadingLlmDebugLogs
                                ? (lang === 'en' ? 'Loading LLM logs...' : '正在读取 LLM 日志...')
                                : (lang === 'en' ? 'No recent LLM logs for this character.' : '这个角色最近还没有可显示的 LLM 日志。')}
                        </div>
                    ) : (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', maxHeight: '420px', overflowY: 'auto', paddingRight: '2px' }}>
                            {recentConversationDebugLogs.map(log => (
                                <div key={log.id} style={{ background: '#f8f9fa', borderRadius: '8px', padding: '10px', borderLeft: `3px solid ${log.direction === 'input' ? '#4f86f7' : '#f39c12'}` }}>
                                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: '10px', marginBottom: '6px', alignItems: 'center' }}>
                                        <div style={{ display: 'flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap' }}>
                                            <span style={{ fontSize: '11px', fontWeight: '700', color: log.direction === 'input' ? '#2f74d0' : '#d68910', textTransform: 'uppercase' }}>
                                                {log.direction}
                                            </span>
                                            <span style={{ fontSize: '10px', color: '#7b8397', background: '#eef2f8', borderRadius: '999px', padding: '2px 8px' }}>
                                                {log.context_type}
                                            </span>
                                            {log.metaObj?.model && (
                                                <span style={{ fontSize: '10px', color: '#7b8397', background: '#f3f5f9', borderRadius: '999px', padding: '2px 8px' }}>
                                                    {log.metaObj.model}
                                                </span>
                                            )}
                                        </div>
                                        <div style={{ fontSize: '11px', color: '#999', whiteSpace: 'nowrap' }}>
                                            {log.timestamp ? new Date(log.timestamp).toLocaleString() : '-'}
                                        </div>
                                    </div>
                                    {(log.metaObj?.finishReason || log.metaObj?.isUserReply != null || log.metaObj?.isTimerWakeup != null) && (
                                        <div style={{ fontSize: '11px', color: '#7a7f8f', marginBottom: '6px', lineHeight: '1.5' }}>
                                            {log.metaObj?.finishReason ? `finish=${log.metaObj.finishReason}` : ''}
                                            {log.metaObj?.finishReason && log.metaObj?.isUserReply != null ? ' · ' : ''}
                                            {log.metaObj?.isUserReply != null ? `userReply=${log.metaObj.isUserReply ? 'yes' : 'no'}` : ''}
                                            {log.metaObj?.isTimerWakeup != null ? ` · timerWakeup=${log.metaObj.isTimerWakeup ? 'yes' : 'no'}` : ''}
                                        </div>
                                    )}
                                    <pre style={{ margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: '11px', lineHeight: '1.5', color: '#3d4354', background: '#fff', borderRadius: '6px', padding: '10px', border: '1px solid #e9edf3', maxHeight: '220px', overflowY: 'auto' }}>
                                        {log.formattedPayload || (lang === 'en' ? '(empty)' : '（空）')}
                                    </pre>
                                </div>
                            ))}
                        </div>
                    )}
                </div>

                <div style={{ marginTop: '10px', backgroundColor: '#fff', borderTop: '1px solid #eee', borderBottom: '1px solid #eee' }}>
                    <div style={{ padding: '15px', display: 'flex', flexDirection: 'column', gap: '10px' }}>
                        <div style={{ fontSize: '13px', fontWeight: 'bold', color: '#333' }}>
                            {lang === 'en' ? 'Physical Reset' : '生理状态重置'}
                        </div>
                        <div style={{ fontSize: '12px', color: '#666', lineHeight: '1.5' }}>
                            {lang === 'en'
                                ? 'One click to restore energy and clear sleep/stress-related burden without touching affinity, memories, or wallet.'
                                : '一键恢复精力，并清空睡眠债、压力和相关干扰，不会影响好感、记忆或钱包。'}
                        </div>
                        <button
                            onClick={handleResetPhysicalState}
                            disabled={isResettingPhysicalState}
                            style={{
                                padding: '10px 12px',
                                border: '1px solid #7fb3ff',
                                background: isResettingPhysicalState ? '#eef5ff' : '#f7fbff',
                                color: '#2f74d0',
                                borderRadius: '8px',
                                cursor: isResettingPhysicalState ? 'not-allowed' : 'pointer',
                                fontWeight: '600'
                            }}
                        >
                            {isResettingPhysicalState
                                ? (lang === 'en' ? 'Resetting...' : '重置中...')
                                : (lang === 'en' ? 'Clear Negative Physical State' : '一键清空负面生理状态')}
                        </button>
                    </div>
                </div>

                <div style={{ marginTop: '10px', backgroundColor: '#fff', borderTop: '1px solid #eee', borderBottom: '1px solid #eee' }}>
                    <div style={{ padding: '15px', display: 'flex', justifyContent: 'center', color: 'var(--danger)', cursor: 'pointer', alignItems: 'center', gap: '8px', fontWeight: '500' }} onClick={handleClearHistory}>
                        <Trash2 size={18} /> {t('Deep Wipe')}
                    </div>
                </div>
            </div>
        </div>
    );
}

export default ChatSettingsDrawer;
