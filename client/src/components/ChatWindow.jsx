import React, { useState, useEffect, useRef, useMemo } from 'react';
import MessageBubble from './MessageBubble';
import InputBar from './InputBar';
import TransferModal from './TransferModal';
import RecommendModal from './RecommendModal';
import { Send, Smile, Paperclip, Bell, Users, ShieldBan, Trash, BookOpen, Brain, MoreHorizontal, UserPlus, Gift, Heart, UserMinus, ShieldAlert, BadgeInfo, ChevronLeft } from 'lucide-react';
import { useLanguage } from '../LanguageContext';
import { resolveAvatarUrl } from '../utils/avatar';
import { deriveEmotion } from '../utils/emotion';

function normalizeMessages(list = []) {
    const byId = new Map();
    list.forEach((msg, index) => {
        if (!msg || !msg.id) return;
        byId.set(msg.id, { ...msg, __fallbackIndex: index });
    });
    return Array.from(byId.values())
        .sort((a, b) => {
            const aTs = Number(a.timestamp || 0);
            const bTs = Number(b.timestamp || 0);
            if (aTs !== bTs) return aTs - bTs;
            const aId = String(a.id);
            const bId = String(b.id);
            if (aId !== bId) return aId.localeCompare(bId, 'en', { numeric: true });
            return (a.__fallbackIndex || 0) - (b.__fallbackIndex || 0);
        })
        .map(({ __fallbackIndex, ...msg }) => msg);
}

function collapseRepeatedApiErrors(list = []) {
    const collapsed = [];
    for (const msg of Array.isArray(list) ? list : []) {
        const prev = collapsed[collapsed.length - 1];
        const isApiError = msg?.role === 'system' && String(msg?.content || '').includes('API Error');
        const sameAsPrev = prev
            && prev.role === 'system'
            && String(prev.content || '') === String(msg?.content || '')
            && String(prev._mergeType || '') === 'api_error';
        if (isApiError && sameAsPrev) {
            prev._mergedIds = Array.isArray(prev._mergedIds) ? [...prev._mergedIds, msg.id] : [prev.id, msg.id];
            prev._mergedCount = Number(prev._mergedCount || 1) + 1;
            prev.id = msg.id;
            prev.timestamp = msg.timestamp;
            continue;
        }
        collapsed.push(isApiError ? {
            ...msg,
            _mergeType: 'api_error',
            _mergedCount: 1,
            _mergedIds: [msg.id]
        } : msg);
    }
    return collapsed;
}



function SystemMessage({ text }) {
    return (
        <div style={{ textAlign: 'center', margin: '8px 0' }}>
            <span style={{ fontSize: '12px', color: '#aaa', backgroundColor: '#f0f0f0', padding: '3px 10px', borderRadius: '10px' }}>
                {text}
            </span>
        </div>
    );
}

function RagHeaderProgress({ progress, lang }) {
    const [displayStep, setDisplayStep] = useState(progress?.currentStep || 0);
    const prevRunRef = useRef(progress?.runId || null);

    useEffect(() => {
        if (!progress) {
            setDisplayStep(0);
            prevRunRef.current = null;
            return;
        }

        if (progress.runId && prevRunRef.current && progress.runId !== prevRunRef.current) {
            setDisplayStep(0);
            const timer = setTimeout(() => setDisplayStep(progress.currentStep || 0), 80);
            prevRunRef.current = progress.runId;
            return () => clearTimeout(timer);
        }

        prevRunRef.current = progress.runId || null;
        setDisplayStep(progress.currentStep || 0);
    }, [progress?.runId, progress?.currentStep, progress]);

    const totalSteps = progress?.totalSteps || 8;
    const percent = Math.max(0, Math.min(100, Math.round((displayStep / totalSteps) * 100)));
    const labels = [
        lang === 'en' ? '1 Summary' : '1 摘要',
        lang === 'en' ? '2 Switch' : '2 切题',
        lang === 'en' ? '3 Route' : '3 路由',
        lang === 'en' ? '4 Topics' : '4 主题',
        lang === 'en' ? '5 Decide' : '5 决策',
        lang === 'en' ? '6 Rewrite' : '6 改写',
        lang === 'en' ? '7 Retrieve' : '7 召回',
        lang === 'en' ? '8 Output' : '8 输出'
    ];
    const currentLabelMap = {
        summary: lang === 'en' ? 'Summary cache update' : '摘要缓存更新',
        switch: lang === 'en' ? 'Topic switch gate' : '切题判断',
        route: lang === 'en' ? 'Module routing' : '模块路由',
        topics: lang === 'en' ? 'Topic expansion' : '主题展开',
        decision: lang === 'en' ? 'RAG decision' : 'RAG 决策',
        rewrite: lang === 'en' ? 'Query rewrite' : '查询改写',
        retrieve: lang === 'en' ? 'Vector retrieval' : '向量召回',
        answer: lang === 'en' ? 'Main model output' : '主模型输出'
    };
    const statusText = progress?.status === 'completed'
        ? (lang === 'en' ? 'Completed' : '已完成')
        : progress?.status === 'error'
            ? (lang === 'en' ? 'Failed' : '失败')
            : progress?.skipped
                ? (lang === 'en' ? 'Skipped to answer' : '已跳过到回答')
                : (currentLabelMap[progress?.currentKey] || (lang === 'en' ? 'Idle' : '待命'));

    return (
        <div style={{
            flex: 1,
            minWidth: 0,
            padding: '2px 0 0'
        }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px', marginBottom: '7px' }}>
                <span style={{ fontSize: '11px', fontWeight: '700', color: '#55627e', letterSpacing: '0.02em' }}>
                    {lang === 'en' ? 'RAG Pipeline' : 'RAG 流程'}
                </span>
                <span style={{ fontSize: '11px', color: '#8a90a6', whiteSpace: 'nowrap' }}>{percent}% · {statusText}</span>
            </div>
            <div style={{
                position: 'relative',
                height: '12px',
                borderRadius: '999px',
                background: 'rgba(255,255,255,0.88)',
                border: '1px solid rgba(123,159,224,0.16)',
                boxShadow: 'inset 0 1px 2px rgba(0,0,0,0.03)',
                overflow: 'hidden'
            }}>
                <div style={{
                    position: 'absolute',
                    inset: 0,
                    width: `${percent}%`,
                    borderRadius: percent >= 100 ? '999px' : '0 999px 999px 0',
                    background: 'linear-gradient(90deg, rgba(198,223,247,0.98) 0%, rgba(166,200,241,0.96) 35%, rgba(123,159,224,0.92) 100%)',
                    boxShadow: displayStep > 0 ? '0 0 14px rgba(123,159,224,0.20)' : 'none',
                    animation: displayStep > 0 && progress?.status !== 'completed' ? 'ragPulse 1.8s ease-in-out infinite' : 'none',
                    transition: 'width 260ms ease'
                }} />
            </div>
            <div style={{
                display: 'grid',
                gridTemplateColumns: `repeat(${totalSteps}, minmax(0, 1fr))`,
                gap: '6px',
                marginTop: '8px'
            }}>
                {labels.map((label, index) => {
                    const isDone = displayStep > index + 1 || (progress?.status === 'completed' && displayStep >= index + 1);
                    const isCurrent = displayStep === index + 1 && progress?.status !== 'completed';
                    return (
                        <div key={label} style={{
                            fontSize: '10px',
                            lineHeight: '1.25',
                            color: isDone || isCurrent ? '#5c6784' : '#a8adbc',
                            fontWeight: isCurrent ? '700' : '500',
                            whiteSpace: 'nowrap',
                            textAlign: 'center',
                            overflow: 'hidden',
                            textOverflow: 'clip'
                        }}>
                            {label}
                        </div>
                    );
                })}
            </div>
        </div>
    );
}

function ChatWindow({
    contact, allContacts, apiUrl, incomingMessageQueue, engineState,
    onToggleMemo, onToggleDiary, onToggleSettings, userAvatar, onBack,
    onSwitchTab, isGeneratingSchedule, onMessagesChange
}) {
    const { t, lang } = useLanguage();
    const [messages, setMessages] = useState([]);
    const [isTransferModalOpen, setIsTransferModalOpen] = useState(false);
    const [isRecommendModalOpen, setIsRecommendModalOpen] = useState(false);
    const [hasMore, setHasMore] = useState(false);
    const [loadingMore, setLoadingMore] = useState(false);

    const [selectMode, setSelectMode] = useState(false);
    const [selectedIds, setSelectedIds] = useState(new Set());
    const PAGE_SIZE = 100;
    const prevBlockedRef = useRef(false);
    const messagesEndRef = useRef(null);
    // contactRef keeps the current contact ID stable inside async callbacks
    const contactRef = useRef(contact);
    useEffect(() => { contactRef.current = contact; }, [contact]);

    const isCurrentlyBlocked = engineState?.[contact?.id]?.isBlocked === 1;
    const ragProgress = engineState?.[contact?.id]?.ragProgress || {
        runId: null,
        totalSteps: 8,
        currentStep: 0,
        currentKey: 'summary',
        status: 'idle',
        skipped: false
    };
    const emotion = deriveEmotion(contact || {});
    const displayMessages = useMemo(() => collapseRepeatedApiErrors(messages), [messages]);

    // Fetch most recent messages when contact changes
    useEffect(() => {
        if (!contact?.id) return;
        setMessages([]);
        setHasMore(false);
        fetch(`${apiUrl}/messages/${contact.id}?limit=${PAGE_SIZE}`, { headers: { 'Authorization': `Bearer ${localStorage.getItem('cp_token') || ''}` } })
            .then(res => res.json())
            .then(data => {
                setMessages(normalizeMessages(data));
                // If we got a full page, there are probably more older messages
                setHasMore(data.length >= PAGE_SIZE);
            })
            .catch(err => console.error('Failed to load messages:', err));
    }, [contact?.id, apiUrl]);

    useEffect(() => {
        const handleCharacterDataWiped = (event) => {
            if (event.detail?.characterId !== contactRef.current?.id) return;
            setMessages([]);
            setHasMore(false);
            setSelectedIds(new Set());
            setSelectMode(false);
        };
        window.addEventListener('character_data_wiped', handleCharacterDataWiped);
        return () => window.removeEventListener('character_data_wiped', handleCharacterDataWiped);
    }, []);

    const loadMore = async () => {
        if (loadingMore || messages.length === 0) return;
        setLoadingMore(true);
        const oldest = messages[0];
        try {
            const data = await fetch(
                `${apiUrl}/messages/${contactRef.current?.id}?limit=${PAGE_SIZE}&before=${oldest.id}`,
                { headers: { 'Authorization': `Bearer ${localStorage.getItem('cp_token') || ''}` } }
            ).then(r => r.json());
            if (data.length > 0) {
                setMessages(prev => normalizeMessages([...data, ...prev]));
                setHasMore(data.length >= PAGE_SIZE);
            } else {
                setHasMore(false);
            }
        } catch (e) {
            console.error('Failed to load more:', e);
        }
        setLoadingMore(false);
    };

    // Handle new incoming WS messages Queue
    useEffect(() => {
        if (incomingMessageQueue && incomingMessageQueue.length > 0 && contact?.id) {
            const relevantMsgs = incomingMessageQueue.filter(m => m.character_id === contact.id);
            if (relevantMsgs.length > 0) {
                setMessages(prev => normalizeMessages([...prev, ...relevantMsgs]));
            }
        }
    }, [incomingMessageQueue, contact?.id]);

    // Detect when a character goes from unblocked -> blocked mid-session and inject a system message
    useEffect(() => {
        const isBlocked = engineState?.[contact?.id]?.isBlocked === 1;
        if (isBlocked && !prevBlockedRef.current) {
            setMessages(prev => normalizeMessages([...prev, {
                id: `block - event - ${Date.now()} `,
                character_id: contact?.id,
                role: 'system',
                content: `[System] ${contact?.name} 将你拉黑了。`,
                timestamp: Date.now()
            }]));
        }
        prevBlockedRef.current = isBlocked;
    }, [engineState, contact?.id, contact?.name]);

    useEffect(() => {
        if (messagesEndRef.current) {
            messagesEndRef.current.scrollIntoView({ behavior: 'smooth', block: 'end' });
        }
    }, [messages]);



    const handleSend = async (text) => {
        const currentContactId = contactRef.current?.id;
        if (!currentContactId) return;



        try {
            const res = await fetch(`${apiUrl}/messages`, {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${localStorage.getItem('cp_token') || ''}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ characterId: currentContactId, content: text })
            });
            const data = await res.json();
            // Only update state if we're still looking at the same contact
            if (contactRef.current?.id !== currentContactId) return;
            if (data.blocked && data.message) {
                setMessages(prev => normalizeMessages([...prev, { ...data.message, isBlocked: true }]));
            }
        } catch (e) {
            console.error('Failed to send:', e);
        }
    };

    const handleRetry = async (failedMessageId) => {
        const currentContactId = contactRef.current?.id;
        if (!currentContactId) return;

        // Optimistically remove the error message from the UI right away
        setMessages(prev => prev.filter(m => m.id !== failedMessageId));

        try {
            await fetch(`${apiUrl}/messages/${currentContactId}/retry`, {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${localStorage.getItem('cp_token') || ''}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ failedMessageId })
            });
            // We just trigger the retry; the WS will handle pushing the new message when ready
        } catch (e) {
            console.error('Failed to retry message:', e);
        }
    };

    const handleTransfer = async (amount, note) => {
        const currentContactId = contactRef.current?.id;
        setIsTransferModalOpen(false);
        try {
            const res = await fetch(`${apiUrl}/characters/${currentContactId}/transfer`, {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${localStorage.getItem('cp_token') || ''}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ amount, note })
            });
            const data = await res.json();
            if (data.success && contactRef.current?.id === currentContactId) {
                // Refresh messages to pick up the new transfer message with tid
                const updated = await fetch(`${apiUrl}/messages/${currentContactId}`, { headers: { 'Authorization': `Bearer ${localStorage.getItem('cp_token') || ''}` } }).then(r => r.json());
                setMessages(normalizeMessages(updated));
            }
        } catch (e) {
            console.error('Transfer failed:', e);
        }
    };

    const handleRecommendContact = async (targetCharId) => {
        setIsRecommendModalOpen(false);
        try {
            const res = await fetch(`${apiUrl}/characters/${contactRef.current?.id}/friends`, {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${localStorage.getItem('cp_token') || ''}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ target_id: targetCharId })
            });
            const data = await res.json();
            if (data.success) {
                const updated = await fetch(`${apiUrl}/messages/${contactRef.current?.id}`, { headers: { 'Authorization': `Bearer ${localStorage.getItem('cp_token') || ''}` } }).then(r => r.json());
                setMessages(normalizeMessages(updated));
            } else {
                alert(lang === 'en' ? 'Failed to recommend contact: ' + data.error : '推荐联系人失败: ' + data.error);
            }
        } catch (e) {
            console.error('Failed to recommend contact:', e);
            alert(lang === 'en' ? 'Network error.' : '网络错误。');
        }
    };

    // No-op string replacement to remove handleClearMemory



    if (!contact) {
        return (
            <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100%', width: '100%' }}>
                <span className="fa-solid fa-spinner fa-spin" style={{ fontSize: '24px', color: 'var(--accent-color)' }}></span>
            </div>
        );
    }

    return (
        <>
            <div className="chat-header">
                <div className="chat-header-title" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <button className="mobile-back-btn" onClick={onBack} title="Back">
                        <ChevronLeft size={24} />
                    </button>
                    <img
                        src={resolveAvatarUrl(contact.avatar, apiUrl) || `https://api.dicebear.com/7.x/shapes/svg?seed=${contact.id || 'User'}`}
                        alt={contact.name}
                        style={{ width: '32px', height: '32px', borderRadius: '50%', objectFit: 'cover' }}
                    />
                    <div style={{ display: 'flex', alignItems: 'center', gap: '10px', minWidth: 0, flex: 1 }}>
                        <span style={{ fontSize: '16px', fontWeight: '600', color: 'var(--text-primary)', whiteSpace: 'nowrap' }}>{contact.name}</span>
                        <span style={{ fontSize: '12px', color: emotion.color, fontWeight: '600', whiteSpace: 'nowrap', flex: '0 0 auto' }}>{emotion.emoji} {emotion.label}</span>
                        <RagHeaderProgress progress={ragProgress} lang={lang} />
                    </div>
                    {engineState?.[contact.id]?.isBlocked === 1 && <span style={{ color: 'var(--danger)', fontSize: '14px', fontWeight: 'bold' }}>(Blocked) 🚫</span>}
                </div>
                <div className="chat-header-actions">
                    <button onClick={() => { setSelectMode(m => !m); setSelectedIds(new Set()); }} title={lang === 'en' ? 'Select Messages' : '选择消息'}
                        style={selectMode ? { color: 'var(--accent-color)', background: 'rgba(var(--accent-rgb, 74,144,226), 0.12)', borderRadius: '8px' } : {}}>
                        <Trash size={20} />
                    </button>
                    <button onClick={() => setIsRecommendModalOpen(true)} title={lang === 'en' ? 'Recommend Contact' : '推荐联系人'}>
                        <UserPlus size={20} />
                    </button>
                    <button onClick={onToggleMemo} title={t('Memories')}>
                        <Brain size={20} />
                    </button>
                    <button onClick={onToggleDiary} title={t('Secret Diary')}>
                        <BookOpen size={20} />
                    </button>
                    <button onClick={onToggleSettings} title={t('Chat Settings')}>
                        <MoreHorizontal size={20} />
                    </button>
                </div>
            </div>

            {isCurrentlyBlocked && (
                <div style={{ textAlign: 'center', padding: '8px', background: '#ffebeb', color: 'var(--danger)', fontSize: '14px', fontWeight: 'bold', borderBottom: '1px solid #ffcccc' }}>
                    You are blocked by {contact.name}. You cannot send messages.
                </div>
            )}

            <div className="chat-history">
                {hasMore && (
                    <div style={{ textAlign: 'center', padding: '10px' }}>
                        <button
                            onClick={loadMore}
                            disabled={loadingMore}
                            style={{
                                fontSize: '12px', color: '#888', background: '#f5f5f5',
                                border: '1px solid #ddd', borderRadius: '12px',
                                padding: '5px 16px', cursor: 'pointer'
                            }}
                        >
                            {loadingMore ? t('Loading') : (lang === 'en' ? '↑ Load older messages' : '↑ 加载更早的消息')}
                        </button>
                    </div>
                )}
                {displayMessages.map((msg, idx) => {
                    const currentLimit = contact?.context_msg_limit || 60;
                    const isBoundary = idx === Math.max(0, displayMessages.length - currentLimit) && displayMessages.length > currentLimit;
                    const boundaryElement = isBoundary ? (
                        <div key={`boundary-${msg.id}`} style={{ textAlign: 'center', margin: '30px 0', position: 'relative', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                            <div style={{ borderBottom: '1px dashed #ccc', position: 'absolute', top: '20px', left: '10%', right: '10%' }}></div>
                            <span style={{ background: '#f5f5f5', padding: '0 15px', color: '#888', fontSize: '12px', fontWeight: 'bold', position: 'relative', zIndex: 1, textTransform: 'uppercase', letterSpacing: '1px' }}>
                                👀 {lang === 'en' ? 'AI Vision Boundary' : 'AI 视界边界'} 👀
                            </span>
                            <div style={{ fontSize: '11px', color: '#aaa', marginTop: '4px', position: 'relative', zIndex: 1, backgroundColor: '#f5f5f5', padding: '0 10px' }}>
                                {lang === 'en' ? 'AI can only "see" messages below this line' : '模型只能感知此线以下的消息'}
                            </div>
                        </div>
                    ) : null;

                    const isSelected = selectedIds.has(msg.id);
                    return (
                        <React.Fragment key={msg.id}>
                            {boundaryElement}
                            <div style={{
                                display: 'flex', alignItems: 'flex-start', gap: '0px',
                                ...(isSelected ? { backgroundColor: 'rgba(var(--accent-rgb, 74,144,226), 0.08)', borderRadius: '8px' } : {})
                            }}
                            onClick={selectMode ? () => {
                                setSelectedIds(prev => {
                                    const next = new Set(prev);
                                    if (next.has(msg.id)) next.delete(msg.id);
                                    else next.add(msg.id);
                                    return next;
                                });
                            } : undefined}
                        >
                            {selectMode && (
                                <div style={{
                                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                                    minWidth: '32px', paddingTop: '12px', cursor: 'pointer'
                                }}>
                                    <div style={{
                                        width: '20px', height: '20px', borderRadius: '50%',
                                        border: isSelected ? 'none' : '2px solid #ccc',
                                        backgroundColor: isSelected ? 'var(--accent-color, #4a90e2)' : 'transparent',
                                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                                        transition: 'all 0.15s ease'
                                    }}>
                                        {isSelected && <span style={{ color: '#fff', fontSize: '12px', fontWeight: 'bold' }}>✓</span>}
                                    </div>
                                </div>
                            )}
                            <div style={{ flex: 1, minWidth: 0 }}>
                                <MessageBubble
                                    message={msg}
                                    characterName={contact.name}
                                    avatar={msg.role === 'user' ? (userAvatar || 'https://api.dicebear.com/7.x/shapes/svg?seed=User') : (contact.avatar || `https://api.dicebear.com/7.x/shapes/svg?seed=${contact.id}`)}
                                    apiUrl={apiUrl}
                                    onRetry={handleRetry}
                                    contacts={allContacts}
                                />
                            </div>
                        </div>
                        </React.Fragment>
                    );
                })}
                {engineState?.[contact.id]?.countdownMs > 0 && engineState?.[contact.id]?.isBlocked !== 1 && (
                    <div className="message-wrapper character" style={{ marginTop: '10px', opacity: 0.7, transition: 'opacity 0.2s' }}>
                        <div className="message-avatar">
                            <img
                                src={resolveAvatarUrl(contact.avatar, apiUrl)}
                                style={{ objectFit: 'cover' }}
                                alt="Avatar"
                                onError={(e) => { e.target.onerror = null; e.target.src = 'https://api.dicebear.com/7.x/shapes/svg?seed=' + encodeURIComponent(contact.id || 'User'); }}
                            />
                        </div>
                        <div className="message-content">
                            <div className="message-bubble" style={{ fontStyle: 'italic', display: 'flex', alignItems: 'center', gap: '8px' }}>
                                <span style={{ display: 'inline-block', width: '12px', height: '12px', boxSizing: 'border-box', border: '2px solid #ddd', borderTopColor: '#888', borderRadius: '50%', animation: 'spin 1s linear infinite' }}></span>
                                <span>{t('Thinking')} {Math.ceil(engineState[contact.id].countdownMs / 1000)}s</span>
                            </div>
                        </div>
                    </div>
                )}
                <div ref={messagesEndRef} />
            </div>

            {/* Floating delete bar when in select mode */}
            {selectMode && (
                <div style={{
                    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                    padding: '10px 16px', background: '#fff', borderTop: '1px solid #eee',
                    boxShadow: '0 -2px 8px rgba(0,0,0,0.06)'
                }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                        <button
                            onClick={() => {
                                if (selectedIds.size === messages.length) setSelectedIds(new Set());
                                else setSelectedIds(new Set(messages.map(m => m.id)));
                            }}
                            style={{ fontSize: '13px', color: 'var(--accent-color, #4a90e2)', background: 'none', border: 'none', cursor: 'pointer', padding: '4px 0' }}
                        >
                            {selectedIds.size === messages.length ? (lang === 'en' ? 'Deselect All' : '取消全选') : (lang === 'en' ? 'Select All' : '全选')}
                        </button>
                        <span style={{ fontSize: '13px', color: '#888' }}>
                            {lang === 'en' ? `${selectedIds.size} selected` : `已选 ${selectedIds.size} 条`}
                        </span>
                    </div>
                    <div style={{ display: 'flex', gap: '8px' }}>
                        <button
                            onClick={() => { setSelectMode(false); setSelectedIds(new Set()); }}
                            style={{ padding: '6px 16px', fontSize: '13px', background: '#f5f5f5', border: '1px solid #ddd', borderRadius: '8px', cursor: 'pointer', color: '#666' }}
                        >
                            {lang === 'en' ? 'Cancel' : '取消'}
                        </button>
                        <button
                            disabled={selectedIds.size === 0}
                            onClick={async () => {
                                if (selectedIds.size === 0) return;
                                const confirmMsg = lang === 'en'
                                    ? `Permanently delete ${selectedIds.size} message(s)?`
                                    : `确定永久删除 ${selectedIds.size} 条消息？`;
                                if (!confirm(confirmMsg)) return;
                                try {
                                    const res = await fetch(`${apiUrl}/messages/batch-delete`, {
                                        method: 'POST',
                                        headers: { 'Authorization': `Bearer ${localStorage.getItem('cp_token') || ''}`, 'Content-Type': 'application/json' },
                                        body: JSON.stringify({ messageIds: [...selectedIds] })
                                    });
                                    const data = await res.json();
                                    if (data.success) {
                                        setMessages(prev => prev.filter(m => !selectedIds.has(m.id)));
                                        setSelectedIds(new Set());
                                        setSelectMode(false);
                                    }
                                } catch (e) {
                                    console.error('Batch delete failed:', e);
                                }
                            }}
                            style={{
                                padding: '6px 16px', fontSize: '13px', fontWeight: '600',
                                background: selectedIds.size > 0 ? '#e74c3c' : '#ddd',
                                color: '#fff', border: 'none', borderRadius: '8px',
                                cursor: selectedIds.size > 0 ? 'pointer' : 'not-allowed'
                            }}
                        >
                            <Trash size={14} style={{ verticalAlign: 'middle', marginRight: '4px' }} />
                            {lang === 'en' ? 'Delete' : '删除'}
                        </button>
                    </div>
                </div>
            )}

            {/* Normal input bar — hidden while in select mode */}
            {!selectMode && (
                <InputBar
                    onSend={handleSend}
                    onTransfer={() => setIsTransferModalOpen(true)}
                />
            )}
            {isTransferModalOpen && (
                <TransferModal
                    contact={contact}
                    onClose={() => setIsTransferModalOpen(false)}
                    onConfirm={handleTransfer}
                />
            )}
            {isRecommendModalOpen && (
                <RecommendModal
                    apiUrl={apiUrl}
                    currentContact={contact}
                    allContacts={allContacts || []}
                    onClose={() => setIsRecommendModalOpen(false)}
                    onRecommend={handleRecommendContact}
                />
            )}
        </>
    );
}

export default ChatWindow;
