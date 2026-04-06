import React from 'react';
import { resolveAvatarUrl } from '../utils/avatar';

function ContactList({ apiUrl, contacts, activeId, onSelect, engineState = {} }) {
    return (
        <>
            {contacts.map((contact) => {
                const state = engineState[contact.id];
                const countdown = state?.countdownMs ? Math.ceil(state.countdownMs / 1000) : null;

                return (
                    <div
                        key={contact.id}
                        className={`contact-item ${activeId === contact.id ? 'active' : ''}`}
                        onClick={() => onSelect(contact.id)}
                    >
                        <div className="contact-avatar" style={{ position: 'relative' }}>
                            <img
                                src={resolveAvatarUrl(contact.avatar, apiUrl)}
                                alt={contact.name}
                                style={{ objectFit: 'cover' }}
                                onError={(e) => {
                                    e.target.onerror = null;
                                    e.target.src = `https://api.dicebear.com/7.x/shapes/svg?seed=${encodeURIComponent(contact.id || 'User')}`;
                                }}
                            />
                            <div className={`autopulse-status-dot ${state?.isThinking ? 'thinking' : 'connected'}`} />
                        </div>
                        <div className="contact-info">
                            <div className="contact-header">
                                <span
                                    className="contact-name"
                                    style={{ minWidth: 0, display: 'inline-flex', alignItems: 'center' }}
                                >
                                    <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                                        {contact.name}
                                    </span>
                                </span>
                                <span
                                    className="contact-time"
                                    style={{
                                        color: countdown ? (state?.isThinking ? '#ff9800' : 'var(--accent-color)') : undefined,
                                        fontWeight: countdown ? 'bold' : 'normal',
                                        whiteSpace: 'nowrap',
                                        flexShrink: 0,
                                        marginLeft: '8px'
                                    }}
                                >
                                    {countdown ? (state?.isThinking ? '思考中' : `${countdown}s`) : contact.time}
                                </span>
                            </div>
                            <div className="contact-last-msg">
                                {contact.lastMessage}
                                {contact.unread > 0 && <span className="unread-badge">{contact.unread}</span>}
                                {state?.isBlocked === 1 && (
                                    <span style={{ marginLeft: 5, color: 'var(--danger)', fontSize: '11px' }} title="Blocked">
                                        已拉黑
                                    </span>
                                )}
                            </div>
                        </div>
                    </div>
                );
            })}
        </>
    );
}

export default ContactList;
