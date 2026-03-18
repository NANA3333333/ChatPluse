import React, { useState, useRef } from 'react';
import { Smile, Paperclip, CreditCard, X } from 'lucide-react';
import { useLanguage } from '../LanguageContext';

function InputBar({ onSend, onTransfer }) {
    const { t, lang } = useLanguage();
    const [text, setText] = useState('');
    const [showEmojiPicker, setShowEmojiPicker] = useState(false);
    const fileInputRef = useRef(null);

    const emojis = ['😀', '😂', '🥺', '😡', '🥰', '👍', '🙏', '💔', '🔥', '✨', '🥳', '😭', '😎', '🙄', '🤔'];

    const addEmoji = (emoji) => {
        setText(prev => prev + emoji);
        setShowEmojiPicker(false);
    };

    const handleSend = () => {
        if (text.trim()) {
            onSend(text);
            setText('');
        }
    };

    const handleKeyDown = (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            handleSend();
        }
    };

    // Read file from user's local device (FileReader runs in browser — works on cloud too)
    const handleFileChange = (e) => {
        const file = e.target.files[0];
        if (!file) return;
        e.target.value = ''; // reset so same file can be re-selected

        const maxSize = 100 * 1024; // 100 KB limit for text
        if (file.size > maxSize) {
            const msgen = `File too large (${(file.size / 1024).toFixed(1)} KB). Limited to 100 KB text files.`;
            const msgzh = `文件太大（${(file.size / 1024).toFixed(1)} KB）。只支持 100 KB 以内的文本文件。`;
            alert(lang === 'en' ? msgen : msgzh);
            return;
        }

        const reader = new FileReader();
        reader.onload = (ev) => {
            const content = ev.target.result;
            // Prepend file name header then append to textarea
            const snippet = `📄 [${file.name}]\n${content}`;
            setText(prev => prev ? prev + '\n' + snippet : snippet);
        };
        reader.onerror = () => alert(lang === 'en' ? 'Failed to read file' : '读取文件失败');
        reader.readAsText(file, 'utf-8');
    };

    return (
        <div className="input-area">
            <div className="input-toolbar" style={{ position: 'relative' }}>
                <button type="button" onClick={() => setShowEmojiPicker(!showEmojiPicker)} title="Emoji"><Smile size={20} /></button>

                {/* File button — reads from user's local device via browser FileReader */}
                <button type="button" onClick={() => fileInputRef.current?.click()} title={lang === 'en' ? 'Send text file content' : '发送文件内容'}>
                    <Paperclip size={20} />
                </button>
                <input
                    ref={fileInputRef}
                    type="file"
                    accept=".txt,.md,.csv,.json,.log,.py,.js,.ts,.html,.css,.xml,.yaml,.yml"
                    style={{ display: 'none' }}
                    onChange={handleFileChange}
                />

                {onTransfer && (
                    <button type="button" onClick={onTransfer} title={t('Send Transfer')}>
                        <CreditCard size={20} color="var(--accent-color)" />
                    </button>
                )}


                {showEmojiPicker && (
                    <div className="emoji-picker" style={{
                        position: 'absolute', bottom: '50px', left: '10px', backgroundColor: '#fff',
                        border: '1px solid #ddd', borderRadius: '8px', padding: '10px', display: 'flex',
                        flexWrap: 'wrap', gap: '5px', width: '220px', boxShadow: '0 -4px 12px rgba(0,0,0,0.1)',
                        zIndex: 100
                    }}>
                        <div style={{ width: '100%', display: 'flex', justifyContent: 'flex-end', marginBottom: '5px' }}>
                            <button type="button" onClick={() => setShowEmojiPicker(false)} style={{ padding: '2px' }}><X size={14} /></button>
                        </div>
                        {emojis.map(e => (
                            <span key={e} onClick={() => addEmoji(e)} style={{ fontSize: '20px', cursor: 'pointer', padding: '4px', borderRadius: '4px' }}>
                                {e}
                            </span>
                        ))}
                    </div>
                )}
            </div>
            <div className="input-textarea-wrapper">
                <textarea
                    className="input-textarea"
                    value={text}
                    onChange={(e) => setText(e.target.value)}
                    onKeyDown={handleKeyDown}
                    placeholder={lang === 'en' ? 'Type a message...' : '输入消息...'}
                />
            </div>
            <div className="input-actions">
                <button type="button" className="send-button" onClick={handleSend}>{t('Send')}</button>
            </div>
        </div>
    );
}

export default InputBar;
