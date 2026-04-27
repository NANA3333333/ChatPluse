import React, { useState, useEffect, useRef, useMemo } from 'react';
import MessageBubble from './MessageBubble';
import InputBar from './InputBar';
import TransferModal from './TransferModal';
import RecommendModal from './RecommendModal';
import { Send, Smile, Paperclip, Bell, Users, ShieldBan, Trash, BookOpen, Brain, MoreHorizontal, UserPlus, Gift, Heart, UserMinus, ShieldAlert, BadgeInfo, ChevronLeft } from 'lucide-react';
import { useLanguage } from '../LanguageContext';
import { resolveAvatarUrl } from '../utils/avatar';
import { deriveEmotion, derivePhysicalState } from '../utils/emotion';

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

function createSystemErrorMessage(message, characterId) {
    return {
        id: `system-error-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        character_id: characterId,
        role: 'system',
        content: `[System] API Error: ${message}`,
        timestamp: Date.now()
    };
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
        lang === 'en' ? '1 Summary' : '1 \u6458\u8981',
        lang === 'en' ? '2 Switch' : '2 \u5207\u9898',
        lang === 'en' ? '3 Route' : '3 \u8DEF\u7531',
        lang === 'en' ? '4 Topics' : '4 \u4E3B\u9898',
        lang === 'en' ? '5 Decide' : '5 \u51B3\u7B56',
        lang === 'en' ? '6 Rewrite' : '6 \u6539\u5199',
        lang === 'en' ? '7 Retrieve' : '7 \u53EC\u56DE',
        lang === 'en' ? '8 Output' : '8 \u8F93\u51FA'
    ];
    const currentLabelMap = {
        summary: lang === 'en' ? 'Summary cache update' : '\u6458\u8981\u7F13\u5B58\u66F4\u65B0',
        switch: lang === 'en' ? 'Topic switch gate' : '\u5207\u9898\u5224\u65AD',
        route: lang === 'en' ? 'Module routing' : '\u6A21\u5757\u8DEF\u7531',
        topics: lang === 'en' ? 'Topic expansion' : '\u4E3B\u9898\u6269\u5C55',
        decision: lang === 'en' ? 'RAG decision' : 'RAG \u51B3\u7B56',
        rewrite: lang === 'en' ? 'Query rewrite' : '\u67E5\u8BE2\u6539\u5199',
        retrieve: lang === 'en' ? 'Vector retrieval' : '\u5411\u91CF\u53EC\u56DE',
        answer: lang === 'en' ? 'Main model output' : '\u4E3B\u6A21\u578B\u8F93\u51FA'
    };
    const statusText = progress?.status === 'completed'
        ? (lang === 'en' ? 'Completed' : '\u5DF2\u5B8C\u6210')
        : progress?.status === 'error'
            ? (lang === 'en' ? 'Failed' : '\u5931\u8D25')
            : progress?.skipped
                ? (lang === 'en' ? 'Skipped to answer' : '\u8DF3\u8FC7\u524D\u7F6E\u9636\u6BB5')
                : (currentLabelMap[progress?.currentKey] || (lang === 'en' ? 'Idle' : '\u7A7A\u95F2')); 

    return (
        <div style={{
            flex: 1,
            minWidth: 0,
            padding: '2px 0 0'
        }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px', marginBottom: '7px' }}>
                <span style={{ fontSize: '11px', fontWeight: '700', color: '#55627e', letterSpacing: '0.02em' }}>
                    {lang === 'en' ? 'RAG Pipeline' : 'RAG \u6D41\u7A0B'}
                </span>
                <span style={{ fontSize: '11px', color: '#8a90a6', whiteSpace: 'nowrap' }}>{percent}% - {statusText}</span>
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
    const physical = derivePhysicalState(contact || {});
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
                content: `[System] ${contact?.name} \u5DF2\u5C06\u4F60\u62C9\u9ED1\u3002`,
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
        if (!currentContactId) return false;
        const optimisticId = `temp-user-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const optimisticMessage = {
            id: optimisticId,
            character_id: currentContactId,
            role: 'user',
            content: text,
            timestamp: Date.now()
        };

        setMessages(prev => normalizeMessages([...prev, optimisticMessage]));

        try {
            const res = await fetch(`${apiUrl}/messages`, {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${localStorage.getItem('cp_token') || ''}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ characterId: currentContactId, content: text })
            });
            const data = await res.json().catch(() => ({}));
            // Only update state if we're still looking at the same contact
            if (contactRef.current?.id !== currentContactId) return false;
            if (!res.ok) {
                const errorText = String(data?.error || data?.message || `HTTP ${res.status}`);
                setMessages(prev => normalizeMessages([
                    ...prev.filter(msg => msg.id !== optimisticId),
                    createSystemErrorMessage(errorText, currentContactId)
                ]));
                return false;
            }
            const savedMessage = data.blocked && data.message
                ? { ...data.message, isBlocked: true }
                : data.message;
            if (savedMessage) {
                setMessages(prev => normalizeMessages([
                    ...prev.filter(msg => msg.id !== optimisticId),
                    savedMessage
                ]));
            } else {
                setMessages(prev => prev.filter(msg => msg.id !== optimisticId));
            }
            if (data.blocked && data.message) {
                return true;
            }
            return true;
        } catch (e) {
            console.error('Failed to send:', e);
            if (contactRef.current?.id === currentContactId) {
                setMessages(prev => normalizeMessages([
                    ...prev.filter(msg => msg.id !== optimisticId),
                    createSystemErrorMessage(e?.message || 'Network error', currentContactId)
                ]));
            }
            return false;
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
                        <span title="心理状态" style={{ fontSize: '12px', color: emotion.color, fontWeight: '600', whiteSpace: 'nowrap', flex: '0 0 auto' }}>{emotion.emoji} {emotion.label}</span>
                        <span title="生理状态" style={{ fontSize: '12px', color: physical.color, fontWeight: '600', whiteSpace: 'nowrap', flex: '0 0 auto' }}>{physical.emoji} {physical.label}</span>
                        <RagHeaderProgress progress={ragProgress} lang={lang} />
                        {engineState?.[contact.id]?.isBlocked === 1 && <span style={{ color: 'var(--danger)', fontSize: '14px', fontWeight: 'bold' }}>(Blocked) [X]</span>}
                    </div>

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
                                [AI] {lang === 'en' ? 'AI Vision Boundary' : 'AI \u89C6\u754C\u8FB9\u754C'} [AI]
                            </span>
                            <div style={{ fontSize: '11px', color: '#aaa', marginTop: '4px', position: 'relative', zIndex: 1, backgroundColor: '#f5f5f5', padding: '0 10px' }}>
                                {lang === 'en' ? 'AI can only "see" messages below this line' : '\u6A21\u578B\u53EA\u80FD\u611F\u77E5\u6B64\u7EBF\u4EE5\u4E0B\u7684\u6D88\u606F'}
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
                                        {isSelected && <span style={{ color: '#fff', fontSize: '12px', fontWeight: 'bold' }}>\u2713</span>}
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
                            {selectedIds.size === messages.length ? (lang === 'en' ? 'Deselect All' : '\u53D6\u6D88\u5168\u9009') : (lang === 'en' ? 'Select All' : '\u5168\u9009')}
                        </button>
                        <span style={{ fontSize: '13px', color: '#888' }}>
                            {lang === 'en' ? `${selectedIds.size} selected` : `\u5DF2\u9009\u62E9 ${selectedIds.size} \u6761`}
                        </span>
                    </div>
                    <div style={{ display: 'flex', gap: '8px' }}>
                        <button
                            onClick={() => { setSelectMode(false); setSelectedIds(new Set()); }}
                            style={{ padding: '6px 16px', fontSize: '13px', background: '#f5f5f5', border: '1px solid #ddd', borderRadius: '8px', cursor: 'pointer', color: '#666' }}
                        >
                            {lang === 'en' ? 'Cancel' : '\u53D6\u6D88'}
                        </button>
                        <button
                            disabled={selectedIds.size === 0}
                            onClick={async () => {
                                if (selectedIds.size === 0) return;
                                const confirmMsg = lang === 'en'
                                    ? `Permanently delete ${selectedIds.size} message(s)?`
                                    : `\u786E\u5B9A\u6C38\u4E45\u5220\u9664 ${selectedIds.size} \u6761\u6D88\u606F\u5417\uFF1F`; 
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
                            {lang === 'en' ? 'Delete' : '\u5220\u9664'}
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
