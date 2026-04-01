import React, { useState, useEffect } from 'react';
import { AlertCircle, ArrowRightLeft } from 'lucide-react';
import { useLanguage } from '../LanguageContext';
import { resolveAvatarUrl } from '../utils/avatar';

function MemoryRecallDisclosure({ memories = [], expanded = false }) {
    const { lang } = useLanguage();

    return (
        <div style={{
            marginTop: '6px',
            padding: '0',
            display: 'flex',
            flexDirection: 'column',
            gap: '6px'
        }}>
            {expanded && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                    {memories.map((mem, idx) => {
                        const eventTime = String(mem.time || '').trim();
                        const sourceTime = String(mem.source_time_text || '').trim();
                        return (
                            <div key={`${mem.id || mem.event || idx}-${idx}`} style={{
                                background: 'rgba(255,255,255,0.38)',
                                borderRadius: '8px',
                                padding: '6px 8px'
                            }}>
                                <div style={{ display: 'flex', justifyContent: 'space-between', gap: '8px', alignItems: 'flex-start' }}>
                                    <div style={{ fontSize: '11px', fontWeight: '500', color: '#79839a', lineHeight: '1.35' }}>
                                        {mem.summary || mem.event || (lang === 'en' ? `Memory ${idx + 1}` : `记忆 ${idx + 1}`)}
                                    </div>
                                    {mem.retrieval_count > 0 && (
                                        <div style={{ fontSize: '10px', color: '#b1b7c5', whiteSpace: 'nowrap' }}>
                                            {lang === 'en' ? `used ${mem.retrieval_count}x` : `调用 ${mem.retrieval_count} 次`}
                                        </div>
                                    )}
                                </div>
                                {(eventTime || sourceTime) && (
                                    <div style={{ marginTop: '5px', fontSize: '10px', color: '#a8afbf', lineHeight: '1.5' }}>
                                        {eventTime && (
                                            <div>{lang === 'en' ? 'Event time:' : '事件时间：'} {eventTime}</div>
                                        )}
                                        {sourceTime && (
                                            <div>{lang === 'en' ? 'Source dialogue:' : '来源对话：'} {sourceTime}</div>
                                        )}
                                    </div>
                                )}
                                {mem.content && (
                                    <div style={{ marginTop: '5px', fontSize: '10px', color: '#9199ab', lineHeight: '1.5' }}>
                                        {mem.content}
                                    </div>
                                )}
                                {mem.matched_query && (
                                    <div style={{ marginTop: '5px', fontSize: '10px', color: '#b0b7c6', lineHeight: '1.4' }}>
                                        {lang === 'en' ? 'Matched query:' : '命中查询：'} {mem.matched_query}
                                    </div>
                                )}
                            </div>
                        );
                    })}
                </div>
            )}
        </div>
    );
}

function BlockedSystemMessage({ name }) {
    return (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', margin: '20px 0', gap: '8px' }}>
            <div style={{
                display: 'flex', alignItems: 'center', gap: '8px',
                backgroundColor: '#fff1f1', border: '1px solid #ffc0c0',
                borderRadius: '10px', padding: '10px 18px',
                color: '#c0392b', fontSize: '13px', fontWeight: '500'
            }}>
                🚫 {name} 已将你拉黑。消息已发出，但对方不会收到。
            </div>
            <div style={{ fontSize: '11px', color: '#bbb' }}>
                尝试转账来解锁对话。
            </div>
        </div>
    );
}

/* Interactive Transfer Card 鈥?handles both old and new formats */
function TransferCardInteractive({ content, isUser, apiUrl }) {
    const { lang } = useLanguage();
    const raw = content.replace('[TRANSFER]', '').trim();
    const parts = raw.split('|');

    // Detect format: new has tid|amount|note (tid is numeric), old has amount|note
    let tid = null, amount = '0', note = 'Transfer';
    if (parts.length >= 3 && /^\d+$/.test(parts[0].trim())) {
        tid = parseInt(parts[0].trim());
        amount = parts[1].trim();
        note = parts.slice(2).join('|').trim() || 'Transfer';
    } else if (parts.length >= 1) {
        amount = parts[0].trim();
        note = parts.length > 1 ? parts.slice(1).join('|').trim() : 'Transfer';
    }

    const [transferInfo, setTransferInfo] = useState(null);
    const [actionDone, setActionDone] = useState(false);

    useEffect(() => {
        if (!tid || !apiUrl) return;
        let cancelled = false;
        let pollCount = 0;
        const fetchStatus = () => {
            fetch(`${apiUrl}/transfers/${tid}`)
                .then(r => r.ok ? r.json() : null)
                .then(d => { if (d && !cancelled) setTransferInfo(d); })
                .catch(() => { });
        };
        fetchStatus();
        // Poll every 5s up to 30 times (~2.5 min) to catch AI's claim/refund decision
        const interval = setInterval(() => {
            pollCount++;
            if (pollCount > 30) { clearInterval(interval); return; }
            fetchStatus();
        }, 5000);
        return () => { cancelled = true; clearInterval(interval); };
    }, [tid, apiUrl]);

    // Auto-update UI when status resolves
    // DB returns: claimed (0/1), refunded (0/1) 鈥?NOT a 'status' string
    const isClaimed = !!(transferInfo?.claimed);
    const isRefunded = !!(transferInfo?.refunded);
    const isPending = transferInfo ? (!isClaimed && !isRefunded) : true;

    useEffect(() => {
        if (isClaimed || isRefunded) setActionDone(true);
    }, [isClaimed, isRefunded]);

    const handleClaim = async () => {
        if (!tid) return;
        try {
            await fetch(`${apiUrl}/transfers/${tid}/claim`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
            setActionDone(true);
            const r = await fetch(`${apiUrl}/transfers/${tid}`);
            if (r.ok) setTransferInfo(await r.json());
        } catch (e) { console.error(e); }
    };

    const handleRefund = async () => {
        if (!tid) return;
        try {
            await fetch(`${apiUrl}/transfers/${tid}/refund`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
            setActionDone(true);
            const r = await fetch(`${apiUrl}/transfers/${tid}`);
            if (r.ok) setTransferInfo(await r.json());
        } catch (e) { console.error(e); }
    };

    return (
        <div style={{ background: 'linear-gradient(135deg, #fff5f0 0%, #ffe8d8 100%)', borderRadius: '12px', padding: '12px 15px', width: '220px', boxSizing: 'border-box', border: '1px solid #ffd4a8' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '6px' }}>
                <span style={{ fontSize: '24px' }}>💰</span>
                <div>
                    <div style={{ fontWeight: '600', fontSize: '15px', color: '#e67e22' }}>¥{amount}</div>
                    <div style={{ fontSize: '12px', color: '#999' }}>{note}</div>
                </div>
            </div>
            {/* Status badge 鈥?shown when claimed or refunded */}
            {(isClaimed || isRefunded) && (
                <div style={{ fontSize: '12px', color: '#999', textAlign: 'center', padding: '4px 0' }}>
                    {isClaimed
                        ? (lang === 'en' ? '✅ Claimed' : '✅ 已领取')
                        : (lang === 'en' ? '↩️ Refunded' : '↩️ 已退回')}
                </div>
            )}
            {/* Buttons: only for recipient (not sender) when still pending */}
            {tid && isPending && !actionDone && !isUser && (
                <div style={{ display: 'flex', gap: '6px', marginTop: '6px' }}>
                    <button onClick={handleClaim}
                        title={lang === 'en' ? 'Accept this transfer and add to your wallet' : '接受转账，入账到你的钱包'}
                        style={{ flex: 1, padding: '7px', fontSize: '12px', background: '#e67e22', color: '#fff', border: 'none', borderRadius: '8px', cursor: 'pointer', fontWeight: '600' }}>
                        {lang === 'en' ? '💰 Claim' : '💰 领取'}
                    </button>
                    <button onClick={handleRefund}
                        title={lang === 'en' ? 'Return this transfer back to the sender' : '将转账退回给发送者'}
                        style={{ flex: 1, padding: '7px', fontSize: '12px', background: '#fff', color: '#e67e22', border: '1px solid #e67e22', borderRadius: '8px', cursor: 'pointer', fontWeight: '500' }}>
                        {lang === 'en' ? '↩️ Refund' : '↩️ 退回'}
                    </button>
                </div>
            )}
            {/* Sender sees waiting status when still pending */}
            {tid && isPending && !actionDone && isUser && (
                <div style={{ fontSize: '11px', color: '#bbb', textAlign: 'center', marginTop: '4px', fontStyle: 'italic' }}>
                    {lang === 'en' ? '⏳ Waiting for response...' : '⏳ 等待对方回应...'}
                </div>
            )}
        </div>
    );
}

function MessageBubble({ message, avatar, characterName, apiUrl, onRetry, contacts }) {
    const isUser = message.role === 'user';
    const content = message.content || '';  // null-safe: old DB records may have null content
    const { lang } = useLanguage();
    const memoryDisclosureKey = message?.id ? `memory_disclosure_${message.id}` : '';
    const [showMemories, setShowMemories] = useState(() => {
        if (!memoryDisclosureKey || typeof window === 'undefined') return false;
        try {
            return window.sessionStorage.getItem(memoryDisclosureKey) === 'open';
        } catch {
            return false;
        }
    });
    const recalledMemories = !isUser && Array.isArray(message.metadata?.retrievedMemories)
        ? message.metadata.retrievedMemories
        : [];
    const hasRecalledMemories = recalledMemories.length > 0;

    useEffect(() => {
        if (!memoryDisclosureKey || typeof window === 'undefined') return;
        try {
            window.sessionStorage.setItem(memoryDisclosureKey, showMemories ? 'open' : 'closed');
        } catch {
            // Ignore storage failures; the disclosure can still work in-memory.
        }
    }, [memoryDisclosureKey, showMemories]);

    if (message.role === 'system') {
        const isApiError = content.includes('API Error');
        return (
            <div style={{ textAlign: 'center', margin: '8px 0', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '6px' }}>
                <span style={{
                    fontSize: '12px',
                    color: isApiError ? '#c0392b' : '#aaa',
                    backgroundColor: isApiError ? '#fff1f1' : '#f0f0f0',
                    padding: '5px 12px',
                    borderRadius: '10px',
                    border: isApiError ? '1px solid #ffc0c0' : 'none',
                    maxWidth: '85%',
                    wordBreak: 'break-word'
                }}>
                    {content.replace('[System] ', '')}
                </span>
                {isApiError && onRetry && (
                    <button
                        onClick={() => onRetry(message.id)}
                        style={{
                            background: '#fff', border: '1px solid #ffc0c0', color: '#c0392b',
                            borderRadius: '12px', padding: '4px 12px', fontSize: '11px',
                            cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '4px',
                            boxShadow: '0 2px 4px rgba(255,192,192,0.2)'
                        }}
                    >
                        🔄 {lang === 'en' ? 'Retry Generation' : '重新生成'}
                    </button>
                )}
            </div>
        );
    }

    return (
        <>
            <div className={`message-wrapper ${isUser ? 'user' : 'character'}`}>
                <div className="message-avatar">
                    <img
                        src={resolveAvatarUrl(avatar, apiUrl)}
                        style={{ objectFit: 'cover' }}
                        alt="Avatar"
                        onError={(e) => { e.target.onerror = null; e.target.src = 'https://api.dicebear.com/7.x/shapes/svg?seed=' + encodeURIComponent(isUser ? 'User' : (message.character_id || 'User')); }}
                    />
                </div>
                <div className="message-content">
                    {content.startsWith('[TRANSFER]') ? (
                        <TransferCardInteractive content={content} isUser={isUser} apiUrl={apiUrl} />
                    ) : content.startsWith('[CONTACT_CARD:') ? (
                        (() => {
                            const parts = content.split(':');
                            if (parts.length >= 4) {
                                const cardId = parts[1];
                                const cardName = parts[2];
                                let cardAvatar = parts.slice(3).join(':');

                                // Fetch real-time avatar if available to fix stale URLs in old messages
                                if (contacts && Array.isArray(contacts)) {
                                    const match = contacts.find(c => String(c.id) === String(cardId));
                                    if (match && match.avatar) cardAvatar = match.avatar;
                                }

                                return (
                                    <div className="message-bubble" style={{ padding: 0, overflow: 'hidden', backgroundColor: '#fff', color: '#333', textAlign: 'left', width: '220px', boxSizing: 'border-box', border: '1px solid #eaeaea' }}>
                                        <div style={{ padding: '12px 15px', display: 'flex', alignItems: 'center', gap: '12px', borderBottom: '1px solid #f0f0f0' }}>
                                            <img
                                                src={resolveAvatarUrl(cardAvatar.replace(']', ''), apiUrl)}
                                                alt={cardName}
                                                style={{ width: '40px', height: '40px', borderRadius: '50%', objectFit: 'cover' }}
                                                onError={(e) => { e.target.onerror = null; e.target.src = 'https://api.dicebear.com/7.x/shapes/svg?seed=' + encodeURIComponent(cardId || 'User'); }}
                                            />
                                            <div style={{ fontSize: '16px', fontWeight: '400' }}>{cardName}</div>
                                        </div>
                                        <div style={{ padding: '4px 15px 6px', fontSize: '12px', color: '#999' }}>
                                            涓汉鍚嶇墖
                                        </div>
                                    </div>
                                );
                            }
                            return <div className="message-bubble">{content}</div>;
                        })()
                    ) : (
                        <div className="message-bubble">
                            {content}
                        </div>
                    )}
                    {message.timestamp && (
                        <div style={{
                            fontSize: '11px', color: '#bbb', marginTop: '4px',
                            display: 'flex', gap: '6px', alignItems: 'center',
                            justifyContent: isUser ? 'flex-end' : 'flex-start'
                        }}>
                            <span>{new Date(message.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                        </div>
                    )}
                    {hasRecalledMemories && (
                        <div style={{
                            marginTop: '2px',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'space-between',
                            gap: '8px',
                            fontSize: '10px',
                            color: '#b2bbcd'
                        }}>
                            <span>{lang === 'en' ? `Used ${recalledMemories.length} memories` : `调用了 ${recalledMemories.length} 条记忆`}</span>
                            <button
                                onClick={() => setShowMemories(value => !value)}
                                style={{
                                    background: 'none',
                                    border: 'none',
                                    padding: 0,
                                    cursor: 'pointer',
                                    fontSize: '10px',
                                    color: '#b2bbcd',
                                    whiteSpace: 'nowrap'
                                }}
                            >
                                {showMemories
                                    ? (lang === 'en' ? 'Hide' : '收起')
                                    : (lang === 'en' ? 'View' : '查看')}
                            </button>
                        </div>
                    )}
                    {hasRecalledMemories && (
                        <MemoryRecallDisclosure memories={recalledMemories} expanded={showMemories} />
                    )}
                </div>
                {message.isBlocked && (
                    <div className="message-blocked-icon" title="消息已发出，但被对方拒收了。">
                        <AlertCircle size={20} color="var(--danger)" />
                    </div>
                )}
            </div>
            {message.isBlocked && isUser && (
                <BlockedSystemMessage name={characterName || '对方'} />
            )}
        </>
    );
}

export default MessageBubble;

