import React, { useRef, useState } from 'react';
import { CreditCard, Paperclip, Smile, X } from 'lucide-react';
import { useLanguage } from '../LanguageContext';

const QUICK_EMOJIS = [
    '\u{1F600}', '\u{1F601}', '\u{1F602}', '\u{1F923}', '\u{1F979}',
    '\u{1F60A}', '\u{1F642}', '\u{1F609}', '\u{1F60D}', '\u{1F618}',
    '\u{1F970}', '\u{1F60E}', '\u{1F914}', '\u{1F644}', '\u{1F634}',
    '\u{1F62D}', '\u{1F621}', '\u{1F624}', '\u{1F97A}', '\u{1F633}',
    '\u{1F917}', '\u{1FAF6}', '\u{1F44D}', '\u{1F44E}', '\u{1F64F}',
    '\u{1F44F}', '\u{1F4AA}', '\u{1F494}', '\u{2764}\u{FE0F}', '\u{1F495}',
    '\u{1F525}', '\u{2728}', '\u{1F389}', '\u{1F38A}', '\u{1F339}',
    '\u{1F35C}', '\u{1F35A}', '\u{1F370}', '\u{2615}', '\u{1F9CB}',
    '\u{1F381}', '\u{1F490}', '\u{1F436}', '\u{1F431}', '\u{1F319}',
    '\u{2600}\u{FE0F}', '\u{26A1}', '\u{1F4A4}', '\u{1F440}', '\u{1F90D}'
];

function InputBar({ onSend, onTransfer }) {
    const { t, lang } = useLanguage();
    const [text, setText] = useState('');
    const [showEmojiPicker, setShowEmojiPicker] = useState(false);
    const fileInputRef = useRef(null);

    const addEmoji = (emoji) => {
        setText(prev => prev + emoji);
        setShowEmojiPicker(false);
    };

    const handleSend = () => {
        if (!text.trim()) return;
        onSend(text);
        setText('');
    };

    const handleKeyDown = (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            handleSend();
        }
    };

    const handleFileChange = (e) => {
        const file = e.target.files[0];
        if (!file) return;
        e.target.value = '';

        const maxSize = 100 * 1024;
        if (file.size > maxSize) {
            const msgen = `File too large (${(file.size / 1024).toFixed(1)} KB). Limited to 100 KB text files.`;
            const msgzh = `文件太大（${(file.size / 1024).toFixed(1)} KB）。只支持 100 KB 以内的文本文件。`;
            alert(lang === 'en' ? msgen : msgzh);
            return;
        }

        const reader = new FileReader();
        reader.onload = (ev) => {
            const content = ev.target.result;
            const snippet = `📎 [${file.name}]\n${content}`;
            setText(prev => (prev ? `${prev}\n${snippet}` : snippet));
        };
        reader.onerror = () => alert(lang === 'en' ? 'Failed to read file' : '读取文件失败');
        reader.readAsText(file, 'utf-8');
    };

    return (
        <div className="input-area">
            <div className="input-toolbar" style={{ position: 'relative' }}>
                <button type="button" onClick={() => setShowEmojiPicker(!showEmojiPicker)} title="Emoji">
                    <Smile size={20} />
                </button>

                <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    title={lang === 'en' ? 'Send text file content' : '发送文本文件内容'}
                >
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
                    <div
                        className="emoji-picker"
                        style={{
                            position: 'absolute',
                            bottom: '50px',
                            left: '10px',
                            backgroundColor: '#fff',
                            border: '1px solid #ddd',
                            borderRadius: '12px',
                            padding: '12px 40px 12px 12px',
                            display: 'grid',
                            gridTemplateColumns: 'repeat(8, minmax(0, 1fr))',
                            gap: '8px',
                            width: 'min(420px, calc(100vw - 40px))',
                            boxShadow: '0 -4px 12px rgba(0,0,0,0.1)',
                            zIndex: 100
                        }}
                    >
                        <div style={{ position: 'absolute', top: '8px', right: '8px' }}>
                            <button type="button" onClick={() => setShowEmojiPicker(false)} style={{ padding: '2px' }}>
                                <X size={14} />
                            </button>
                        </div>
                        {QUICK_EMOJIS.map((emoji) => (
                            <span
                                key={emoji}
                                onClick={() => addEmoji(emoji)}
                                style={{ fontSize: '22px', cursor: 'pointer', padding: '6px', borderRadius: '8px', textAlign: 'center' }}
                            >
                                {emoji}
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
                <button type="button" className="send-button" onClick={handleSend}>
                    {t('Send')}
                </button>
            </div>
        </div>
    );
}

export default InputBar;
