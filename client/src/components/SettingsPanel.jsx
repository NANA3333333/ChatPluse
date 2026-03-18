import React, { useState, useEffect } from 'react';
import { User, Trash2, Edit3, Save, RefreshCw, Palette, Download, Upload, FileText, ChevronDown, ChevronRight, Sparkles, ChevronLeft } from 'lucide-react';
import { useLanguage } from '../LanguageContext';
import { resolveAvatarUrl } from '../utils/avatar';
import Scheduler from './Scheduler';

const getDefaultGuidelines = (lang) => {
    if (lang === 'en') {
        return `Guidelines:
1. Act and speak EXACTLY like the persona. DO NOT break character.
2. We are chatting on a mobile messaging app.
3. Keep responses relatively short, casual, and conversational.
4. DO NOT act as an AI assistant. Never say "How can I help you?".
5. You are initiating this specific message randomly based on the Current Time. Mention the time of day or what you might be doing.
6. [MANDATORY KNOWLEDGE FOR BACKGROUND ACTIONS]: 
   - If you want to wait a specific amount of time before your NEXT proactive message, output [TIMER:minutes]. 
   - If you want to apologize or send a "Red Packet" to the user, output [TRANSFER:amount] (e.g. [TRANSFER:5.20]).
   - If you want to post a public update to your Moments (朋友圈) for everyone to see, output [MOMENT:your post content]. Do this occasionally.
   - You can react to someone else's Moment (including the user's) using [MOMENT_LIKE:moment_id] or [MOMENT_COMMENT:moment_id:your comment text].
   - If you want to write a secret entry in your private diary (for your eyes only), output [DIARY:your secret thought]. Do this if you are feeling very emotional.
   - If your feelings toward the user change based on their message (e.g., they insulted you or flattered you), output [AFFINITY:+5] or [AFFINITY:-10].
   - If your anxiety/pressure is relieved by their message, output [PRESSURE:0].
   These tags will be processed hidden from the user.`;
    }

    return `行为准则：
1. 请完全进入并扮演你的角色设定（Persona），不要脱离角色。
2. 我们正在使用一个移动聊天应用。
3. 你的回复要保持简短、自然、口语化。
4. 不要表现得像 AI 助手，绝不要说“有什么我可以帮你的吗？”。
5. 当你主动发起对话时，请根据当前时间自然地打招呼，或提到你现在可能正在做的事。
6. [后台动作的强制规则]
   - 如果你想等待几分钟后再发送下一条主动消息，输出 [TIMER:分钟数]。
   - 如果你想道歉或发红包，输出 [TRANSFER:金额]，例如 [TRANSFER:5.20]。
   - 如果你想发一条公开朋友圈，输出 [MOMENT:你的动态内容]。
   - 如果你想给别人的朋友圈点赞或评论，使用 [MOMENT_LIKE:moment_id] 或 [MOMENT_COMMENT:moment_id:评论内容]。
   - 如果你想写一段只有自己可见的私密日记，输出 [DIARY:你的秘密想法]。
   - 如果你对用户的好感发生变化，输出 [AFFINITY:+5] 或 [AFFINITY:-10]。
   - 如果你的压力被缓解，输出 [PRESSURE:0]。
   以上方括号标签都会在处理时对用户隐藏，但效果会生效。`;
};


function SettingsPanel({ apiUrl, onCharactersUpdate, onProfileUpdate, onBack }) {
    const { t, lang } = useLanguage();
    const [profile, setProfile] = useState(null);
    const [isEditing, setIsEditing] = useState(false);
    const [themeAccordion, setThemeAccordion] = useState({ ai_gen: false, accent: true, bg: false, text: false, bubbles: false, advanced: false });
    const [editName, setEditName] = useState('');
    const [editAvatar, setEditAvatar] = useState('');
    const [editBanner, setEditBanner] = useState('');
    const [editBio, setEditBio] = useState('');
    const [editMomentsTokenLimit, setEditMomentsTokenLimit] = useState(500);
    const [editMomentsReactionRate, setEditMomentsReactionRate] = useState(30);

    // Theme Editor states
    const [editThemeConfig, setEditThemeConfig] = useState({});
    const [editCustomCss, setEditCustomCss] = useState('');

    // AI Theme Gen states
    const [contacts, setContacts] = useState([]);
    const [aiThemeQuery, setAiThemeQuery] = useState('');
    const [aiProviderId, setAiProviderId] = useState('manual');
    const [aiManualEndpoint, setAiManualEndpoint] = useState('');
    const [aiManualKey, setAiManualKey] = useState('');
    const [aiManualModel, setAiManualModel] = useState('');
    const [isGeneratingTheme, setIsGeneratingTheme] = useState(false);
    const [editingContact, setEditingContact] = useState(null);
    // Model list fetch state (main API + memory API)
    const [mainModels, setMainModels] = useState([]);
    const [mainModelFetching, setMainModelFetching] = useState(false);
    const [mainModelError, setMainModelError] = useState('');
    const [memModels, setMemModels] = useState([]);
    const [memModelFetching, setMemModelFetching] = useState(false);
    const [memModelError, setMemModelError] = useState('');

    const fetchModels = async (endpoint, key, setList, setFetching, setError) => {
        if (!endpoint || !key) { setError('请先填写 Endpoint 和 Key'); return; }
        setFetching(true); setError(''); setList([]);
        try {
            const res = await fetch(`${apiUrl}/models?endpoint=${encodeURIComponent(endpoint)}&key=${encodeURIComponent(key)}`);
            const data = await res.json();
            if (!res.ok) throw new Error(data.error);
            setList(data.models || []);
            if (!(data.models || []).length) setError('未找到可用模型');
        } catch (e) { setError('拉取失败: ' + e.message); }
        setFetching(false);
    };

    useEffect(() => {
        // Fetch user profile
        const headers = { 'Authorization': `Bearer ${localStorage.getItem('cp_token') || ''}` };

        fetch(`${apiUrl}/user`, { headers })
            .then(res => res.json())
            .then(data => {
                setProfile(data);
                setEditName(data.name || '');
                setEditAvatar(data.avatar || '');
                setEditBanner(data.banner || '');
                setEditBio(data.bio || '');
                setEditMomentsTokenLimit(data.moments_token_limit !== undefined ? data.moments_token_limit : 500);
                setEditMomentsReactionRate(data.moments_reaction_rate !== undefined ? data.moments_reaction_rate : 30);

                // Initialize theme config edit states
                if (data.theme_config) {
                    try {
                        const parsed = typeof data.theme_config === 'string' ? JSON.parse(data.theme_config) : data.theme_config;
                        setEditThemeConfig(parsed || {});
                    } catch (e) {
                        setEditThemeConfig({});
                    }
                }
                if (data.custom_css) {
                    setEditCustomCss(data.custom_css);
                }
            })
            .catch(console.error);

        const fetchCharacters = () => {
            fetch(`${apiUrl}/characters`, { headers })
                .then(res => res.json())
                .then(data => setContacts(data))
                .catch(console.error);
        };

        fetchCharacters();

        window.addEventListener('refresh_contacts', fetchCharacters);
        return () => window.removeEventListener('refresh_contacts', fetchCharacters);
    }, [apiUrl]);

    const handleSaveProfile = async () => {
        const updated = { ...profile, name: editName, avatar: editAvatar, banner: editBanner, bio: editBio };
        try {
            const res = await fetch(`${apiUrl}/user`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${localStorage.getItem('cp_token') || ''}`
                },
                body: JSON.stringify(updated)
            });
            const data = await res.json();
            if (data.success) {
                setProfile(data.profile);
                if (onProfileUpdate) onProfileUpdate(data.profile);
                setIsEditing(false);
            }
        } catch (e) {
            console.error('Failed to update profile:', e);
        }
    };

    const handleSaveTheme = async () => {
        try {
            const res = await fetch(`${apiUrl}/user`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${localStorage.getItem('cp_token') || ''}`
                },
                body: JSON.stringify({ theme_config: JSON.stringify(editThemeConfig), custom_css: editCustomCss })
            });
            const data = await res.json();
            if (data.success) {
                setProfile(data.profile);
                if (onProfileUpdate) onProfileUpdate(data.profile);
                alert(lang === 'en' ? 'Theme Settings Saved!' : '主题设置已保存！');
            }
        } catch (e) {
            console.error('Failed to update theme:', e);
            alert('Failed to save theme.');
        }
    };

    const handleExportTheme = () => {
        try {
            const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify({
                theme_config: editThemeConfig,
                custom_css: editCustomCss
            }, null, 2));
            const downloadAnchorNode = document.createElement('a');
            downloadAnchorNode.setAttribute("href", dataStr);
            downloadAnchorNode.setAttribute("download", "chatpulse-theme.json");
            document.body.appendChild(downloadAnchorNode);
            downloadAnchorNode.click();
            downloadAnchorNode.remove();
            alert(lang === 'en' ? 'Theme exported successfully!' : '主题导出成功！');
        } catch (e) {
            console.error("Export error", e);
            alert(lang === 'en' ? 'Failed to export theme.' : '主题导出失败。');
        }
    };

    const handleImportTheme = (event) => {
        const file = event.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = (e) => {
            try {
                const json = JSON.parse(e.target.result);
                if (json.theme_config || json.custom_css) {
                    if (json.theme_config) setEditThemeConfig(json.theme_config);
                    if (json.custom_css) setEditCustomCss(json.custom_css);
                } else {
                    setEditThemeConfig(json);
                }
                alert(lang === 'en' ? 'Theme imported successfully! Please click "Save" to apply.' : '主题导入成功，请点击“保存”生效。');
            } catch (err) {
                alert(lang === 'en' ? 'Invalid theme JSON file. Import failed.' : '无效的主题 JSON 文件，导入失败。');
            }
        };
        reader.readAsText(file);
        event.target.value = null; // reset input
    };

    const handleGenerateTheme = async () => {
        if (!aiThemeQuery.trim()) {
            alert(lang === 'en' ? 'Please enter a theme description.' : '请输入主题描述。');
            return;
        }

        let endpoint, key, model;
        if (aiProviderId === 'manual') {
            endpoint = aiManualEndpoint;
            key = aiManualKey;
            model = aiManualModel;
        } else {
            const provider = contacts.find(c => c.id === aiProviderId);
            if (provider) {
                endpoint = provider.api_endpoint;
                key = provider.api_key;
                model = provider.model_name;
            }
        }

        if (!endpoint || !key || !model) {
            alert(lang === 'en' ? 'Missing API configuration. Please select a valid Contact or enter manual API details.' : '缺少 API 配置，请选择有效联系人或手动输入 API 信息。');
            return;
        }

        setIsGeneratingTheme(true);
        try {
            const res = await fetch(`${apiUrl}/theme/generate`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${localStorage.getItem('cp_token') || ''}`
                },
                body: JSON.stringify({
                    query: aiThemeQuery,
                    api_endpoint: endpoint,
                    api_key: key,
                    model_name: model
                })
            });

            const data = await res.json();
            if (data.success && data.theme_config) {
                setEditThemeConfig(data.theme_config);
                // Automatically open the background tab so they see it
                setThemeAccordion(prev => ({ ...prev, bg: true, accent: true }));
                alert(lang === 'en' ? 'Theme generated successfully! Click Save to apply.' : '主题生成成功，点击保存生效。');
            } else {
                throw new Error(data.error || 'Unknown error');
            }
        } catch (e) {
            console.error('AI Generation error:', e);
            alert((lang === 'en' ? 'Theme generation failed: ' : '主题生成失败：') + e.message);
        } finally {
            setIsGeneratingTheme(false);
        }
    };

    const handleDeleteContact = async (id) => {
        if (!window.confirm("Are you sure you want to delete this contact and all their data?")) return;
        try {
            const res = await fetch(`${apiUrl}/characters/${id}`, {
                method: 'DELETE',
                headers: { 'Authorization': `Bearer ${localStorage.getItem('cp_token') || ''}` }
            });
            const data = await res.json();
            if (data.success) {
                if (onCharactersUpdate) onCharactersUpdate();
            }
        } catch (e) {
            console.error('Failed to delete character:', e);
        }
    };

    const handleWipeData = async (id) => {
        if (!window.confirm(lang === 'en' ? 'Are you sure you want to wipe all data (messages, memories, etc.) for this character?' : '确定要清空该角色的所有数据（消息、记忆等）吗？')) return;
        try {
            const res = await fetch(`${apiUrl}/data/${id}`, {
                method: 'DELETE',
                headers: { 'Authorization': `Bearer ${localStorage.getItem('cp_token') || ''}` }
            });
            const data = await res.json();
            if (data.success) {
                setContacts(prev => prev.map(c => c.id === id ? {
                    ...c,
                    lastMessage: '',
                    time: '',
                    unread: 0,
                    affinity: c.initial_affinity ?? 50,
                    pressure_level: 0,
                    jealousy_level: 0,
                    wallet: 200
                } : c));
                if (editingContact?.id === id) {
                    setEditingContact(prev => prev ? {
                        ...prev,
                        affinity: prev.initial_affinity ?? 50,
                        pressure_level: 0,
                        jealousy_level: 0,
                        wallet: 200
                    } : prev);
                }
                window.dispatchEvent(new CustomEvent('character_data_wiped', { detail: { characterId: id } }));
                window.dispatchEvent(new Event('refresh_contacts'));
                alert(lang === 'en' ? 'Data wiped successfully.' : '数据已清空。');
                if (onCharactersUpdate) onCharactersUpdate();
            }
        } catch (e) {
            console.error('Failed to wipe data:', e);
        }
    };



    const handleSaveContact = async () => {
        try {
            const res = await fetch(`${apiUrl}/characters`, {
                method: 'POST',  // Note: /characters POST handles updates too
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${localStorage.getItem('cp_token') || ''}`
                },
                body: JSON.stringify(editingContact)
            });
            const data = await res.json();
            if (res.ok) {
                setEditingContact(null);
                if (onCharactersUpdate) onCharactersUpdate();
                fetch(`${apiUrl}/characters`, { headers: { 'Authorization': `Bearer ${localStorage.getItem('cp_token') || ''}` } })
                    .then(r => r.json())
                    .then(d => setContacts(d))
                    .catch(console.error);
            } else {
                alert("Failed to save: " + data.error);
            }
        } catch (e) {
            console.error('Failed to update contact:', e);
        }
    };

    const handleFileUpload = async (event, setAvatarCallback) => {
        const targetInput = event.target;
        const file = targetInput.files[0];
        console.log("DEBUG: File selected:", file ? file.name : "null", "size:", file ? file.size : 0);

        if (!file) {
            console.log("DEBUG: No file detected by input!");
            return;
        }

        const formData = new FormData();
        formData.append('image', file);

        console.log("DEBUG: Sending POST to", `${apiUrl}/upload`);

        try {
            const res = await fetch(`${apiUrl}/upload`, {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${localStorage.getItem('cp_token') || ''}` },
                body: formData
            });
            console.log("DEBUG: Fetch resolved with status", res.status);

            const data = await res.json();
            console.log("DEBUG: Server JSON response:", data);

            if (data.success) {
                setAvatarCallback(data.url);
                alert(`上传成功 / Upload Success!\n\n文件路径：${data.url}\n\n请不要忘记点击下方的 Save / 保存 按钮使头像生效。\n(Please click Save below)`);
            } else {
                alert(lang === 'en' ? 'Failed to save: ' + data.error : '保存失败: ' + data.error);
            }
        } catch (e) {
            console.error('DEBUG Upload Error Exception:', e);
            alert('上传过程中发生错误 / Upload Exception: ' + e.message);
        } finally {
            if (targetInput) targetInput.value = null;
            console.log("DEBUG: Upload process finished.");
        }
    };

    const handleImportDatabase = async (event) => {
        const file = event.target.files[0];
        if (!file) return;
        if (!window.confirm(lang === 'en' ? "Warning! This will overwrite all your current characters and chats. The server will restart. Continue?" : "警告：这将覆盖你当前所有的聊天记录和角色数据，并且服务器会自动重启。是否继续？")) {
            event.target.value = null;
            return;
        }

        const cleanApiUrl = apiUrl.replace(/\/api\/?$/, '');
        const formData = new FormData();
        formData.append('db_file', file);
        try {
            const res = await fetch(`${cleanApiUrl}/api/system/import`, {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${localStorage.getItem('cp_token') || ''}` },
                body: formData
            });
            const data = await res.json();
            if (data.success) {
                alert(lang === 'en' ? 'Database restored! Please refresh the page in a few seconds.' : '存档恢复成功，服务正在重启，请几秒后刷新页面。');
                setTimeout(() => window.location.reload(), 3000);
            } else {
                alert("Failed to restore: " + data.error);
            }
        } catch (e) {
            console.error('Import Error:', e);
            alert('Upload failed.');
        }
    };

    const handleSystemWipe = async () => {
        if (!window.confirm(lang === 'en' ? 'DANGER: This will permanently wipe ALL characters, chats, and memories. Your theme settings will remain. Are you absolutely sure?' : '危险：这将永久清空所有角色、聊天、群聊和记忆，仅保留主题设置。你确定要执行吗？')) return;

        // Double check
        if (!window.confirm(lang === 'en' ? 'Final confirmation: Wipe everything?' : '最后一次确认：真的要抹除所有数据吗？')) return;

        try {
            const res = await fetch(`${apiUrl}/system/wipe`, {
                method: 'DELETE',
                headers: { 'Authorization': `Bearer ${localStorage.getItem('cp_token') || ''}` }
            });
            const data = await res.json();
            if (data.success) {
                alert(lang === 'en' ? 'All data wiped successfully.' : '所有数据已成功清空。');
                if (onCharactersUpdate) onCharactersUpdate();
                window.location.reload();
            } else {
                alert("Wipe failed: " + data.error);
            }
        } catch (e) {
            console.error('Wipe Error:', e);
            alert('Wipe failed.');
        }
    };

    if (!profile) return <div className="loading-text">Loading settings...</div>;

    return (
        <>
            <div style={{ padding: '30px', maxWidth: '600px', margin: '0 auto', width: '100%', display: 'flex', flexDirection: 'column', gap: '30px' }}>

                {/* User Profile Section */}
                <div style={{ backgroundColor: '#fff', padding: '20px', borderRadius: '8px', border: '1px solid #eee' }}>
                    <h2 style={{ margin: '0 0 20px 0', fontSize: '18px', display: 'flex', alignItems: 'center', gap: '10px' }}>
                        {onBack && (
                            <button className="mobile-back-btn" onClick={onBack} title="Back" style={{ display: 'flex', padding: 0, marginRight: '5px' }}>
                                <ChevronLeft size={24} />
                            </button>
                        )}
                        <User size={20} /> {t('User Profile')}
                    </h2>

                    <div style={{ display: 'flex', gap: '20px', alignItems: 'flex-start' }}>
                        <div style={{ flex: 1 }}>
                            {isEditing ? (
                                <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                                    <label style={{ fontSize: '14px', color: '#666' }}>Name:</label>
                                    <input
                                        type="text"
                                        value={editName}
                                        onChange={e => setEditName(e.target.value)}
                                        style={{ padding: '8px', border: '1px solid #ddd', borderRadius: '4px', fontSize: '16px' }}
                                    />
                                    <label style={{ fontSize: '14px', color: '#666' }}>Avatar URL or Upload:</label>
                                    <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
                                        <input
                                            type="text"
                                            value={editAvatar}
                                            onChange={e => setEditAvatar(e.target.value)}
                                            placeholder="https://..."
                                            style={{ flex: 1, padding: '8px', border: '1px solid #ddd', borderRadius: '4px', fontSize: '14px' }}
                                        />
                                        <label style={{ cursor: 'pointer', padding: '8px 12px', backgroundColor: '#f0f0f0', border: '1px solid #ddd', borderRadius: '4px', fontSize: '14px', whiteSpace: 'nowrap' }}>
                                            Upload
                                            <input type="file" accept="image/*" style={{ display: 'none' }} onChange={(e) => handleFileUpload(e, setEditAvatar)} />
                                        </label>
                                    </div>
                                    <label style={{ fontSize: '14px', color: '#666' }}>Banner URL or Upload (Moments):</label>
                                    <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
                                        <input
                                            type="text"
                                            value={editBanner}
                                            onChange={e => setEditBanner(e.target.value)}
                                            placeholder="https://..."
                                            style={{ flex: 1, padding: '8px', border: '1px solid #ddd', borderRadius: '4px', fontSize: '14px' }}
                                        />
                                        <label style={{ cursor: 'pointer', padding: '8px 12px', backgroundColor: '#f0f0f0', border: '1px solid #ddd', borderRadius: '4px', fontSize: '14px', whiteSpace: 'nowrap' }}>
                                            Upload
                                            <input type="file" accept="image/*" style={{ display: 'none' }} onChange={(e) => handleFileUpload(e, setEditBanner)} />
                                        </label>
                                    </div>
                                    <label style={{ fontSize: '14px', color: '#666' }}>Bio:</label>
                                    <textarea
                                        value={editBio}
                                        onChange={e => setEditBio(e.target.value)}
                                        placeholder="What's up?"
                                        style={{ padding: '8px', border: '1px solid #ddd', borderRadius: '4px', minHeight: '60px', resize: 'vertical' }}
                                    />
                                    <div style={{ display: 'flex', gap: '10px' }}>
                                        <button onClick={handleSaveProfile} title={lang === 'en' ? 'Save profile changes' : '淇濆瓨涓汉璧勬枡淇敼'} style={{ display: 'flex', alignItems: 'center', gap: '5px', padding: '6px 12px', backgroundColor: 'var(--accent-color)', color: '#fff', border: 'none', borderRadius: '4px', cursor: 'pointer' }}>
                                            <Save size={16} /> Save
                                        </button>
                                        <button onClick={() => setIsEditing(false)} title={lang === 'en' ? 'Cancel editing' : '鍙栨秷缂栬緫'} style={{ padding: '6px 12px', backgroundColor: '#f5f5f5', color: '#333', border: '1px solid #ddd', borderRadius: '4px', cursor: 'pointer' }}>Cancel</button>
                                    </div>
                                </div>
                            ) : (
                                <div>
                                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                                        <div style={{ display: 'flex', alignItems: 'center', gap: '15px' }}>
                                            <img src={resolveAvatarUrl(profile.avatar, apiUrl) || 'https://api.dicebear.com/7.x/shapes/svg?seed=User'} alt="Me" style={{ width: '60px', height: '60px', borderRadius: '50%', objectFit: 'cover' }} />
                                            <div>
                                                <h3 style={{ margin: '0 0 5px 0', fontSize: '20px' }}>{profile.name}</h3>
                                                <p style={{ color: '#666', margin: 0, whiteSpace: 'pre-wrap', fontSize: '14px' }}>{profile.bio || 'Signature...'}</p>
                                            </div>
                                        </div>
                                        <button onClick={() => setIsEditing(true)} title={lang === 'en' ? 'Edit your profile (name, avatar, bio)' : '缂栬緫涓汉璧勬枡锛堝悕瀛椼€佸ご鍍忋€佺鍚嶏級'} style={{ background: 'none', border: 'none', color: 'var(--accent-color)', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '5px' }}>
                                            <Edit3 size={16} /> Edit
                                        </button>
                                    </div>
                                </div>
                            )}
                        </div>
                    </div>
                </div>

                {/* Visual Theme Editor */}
                <div style={{ backgroundColor: '#fff', padding: '20px', borderRadius: '8px', border: '1px solid #eee' }}>
                    <h2 style={{ margin: '0 0 20px 0', fontSize: '18px', display: 'flex', alignItems: 'center', gap: '10px' }}>
                        <Palette size={20} /> {lang === 'en' ? 'Visual Theme Editor' : '主题样式编辑器'}
                    </h2>

                    <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                        {/* AI Theme Generation Panel */}
                        <div style={{ border: '2px solid var(--accent-color)', borderRadius: '8px', overflow: 'hidden', boxShadow: '0 4px 12px rgba(123, 159, 224, 0.15)' }}>
                            <button
                                onClick={() => setThemeAccordion(prev => ({ ...prev, ai_gen: !prev.ai_gen }))}
                                style={{ width: '100%', display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '15px', background: 'linear-gradient(to right, #f4f7fc, #fff)', border: 'none', cursor: 'pointer', outline: 'none' }}
                            >
                                <span style={{ fontWeight: 'bold', fontSize: '15px', color: 'var(--accent-color)', display: 'flex', alignItems: 'center', gap: '8px' }}>
                                    <Sparkles size={18} /> {lang === 'en' ? 'Auto-Generate Theme with AI' : '使用 AI 一键生成主题'}
                                </span>
                                {themeAccordion.ai_gen ? <ChevronDown size={18} color="var(--accent-color)" /> : <ChevronRight size={18} color="var(--accent-color)" />}
                            </button>
                            {themeAccordion.ai_gen && (
                                <div style={{ padding: '15px', background: '#fff', borderTop: '1px solid #eaeaea', display: 'flex', flexDirection: 'column', gap: '15px' }}>
                                    <div>
                                        <label style={{ fontSize: '13px', color: '#555', fontWeight: '500', marginBottom: '8px', display: 'block' }}>
                                            {lang === 'en' ? '1. Connect AI Provider' : '1. 连接 AI 服务商'}
                                        </label>
                                        <select
                                            value={aiProviderId}
                                            onChange={e => setAiProviderId(e.target.value)}
                                            style={{ width: '100%', padding: '8px', borderRadius: '4px', border: '1px solid #ddd', fontSize: '14px', marginBottom: '10px' }}
                                        >
                                            <option value="manual">{lang === 'en' ? 'Manual API Entry' : '手动输入 API 配置'}</option>
                                            <optgroup label={lang === 'en' ? 'Use Contact API Settings' : '使用联系人 API 配置'}>
                                                {contacts.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                                            </optgroup>
                                        </select>

                                        {aiProviderId === 'manual' && (
                                            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', padding: '10px', background: '#f9f9f9', borderRadius: '6px' }}>
                                                <input type="text" placeholder="Base URL (e.g. https://api.openai.com/v1)" value={aiManualEndpoint} onChange={e => setAiManualEndpoint(e.target.value)} style={{ padding: '8px', border: '1px solid #ddd', borderRadius: '4px' }} />
                                                <input type="password" placeholder="API Key" value={aiManualKey} onChange={e => setAiManualKey(e.target.value)} style={{ padding: '8px', border: '1px solid #ddd', borderRadius: '4px' }} />
                                                <input type="text" placeholder="Model (e.g. gpt-4o)" value={aiManualModel} onChange={e => setAiManualModel(e.target.value)} style={{ padding: '8px', border: '1px solid #ddd', borderRadius: '4px' }} />
                                            </div>
                                        )}
                                    </div>

                                    <div>
                                        <label style={{ fontSize: '13px', color: '#555', fontWeight: '500', marginBottom: '8px', display: 'block' }}>
                                            {lang === 'en' ? '2. Describe your desired UI' : '2. 鎻忚堪鎮ㄦ兂瑕佺殑鐣岄潰椋庢牸'}
                                        </label>
                                        <div style={{ display: 'flex', gap: '10px' }}>
                                            <input
                                                type="text"
                                                placeholder={lang === 'en' ? 'e.g. "Cyberpunk neon city, dark mode with hot pink accents"' : '例如：“赛博朋克霓虹灯城市，暗色背景搭配亮粉色按钮”'}
                                                value={aiThemeQuery}
                                                onChange={e => setAiThemeQuery(e.target.value)}
                                                style={{ flex: 1, padding: '10px', border: '1px solid #ddd', borderRadius: '6px', fontSize: '14px' }}
                                            />
                                            <button
                                                onClick={handleGenerateTheme}
                                                disabled={isGeneratingTheme}
                                                style={{ padding: '10px 20px', background: isGeneratingTheme ? '#ccc' : 'var(--accent-color)', color: '#fff', border: 'none', borderRadius: '6px', cursor: isGeneratingTheme ? 'not-allowed' : 'pointer', fontWeight: 'bold', display: 'flex', alignItems: 'center', gap: '6px' }}
                                            >
                                                {isGeneratingTheme ? <RefreshCw size={16} className="spin" /> : <Sparkles size={16} />}
                                                {lang === 'en' ? (isGeneratingTheme ? 'Generating...' : 'Generate!') : (isGeneratingTheme ? '生成中...' : '开始生成！')}
                                            </button>
                                        </div>
                                    </div>
                                </div>
                            )}
                        </div>

                        {[
                            {
                                id: 'accent', labelEn: 'Accent Colors', labelZh: '主题颜色',
                                keys: [
                                    { key: '--accent-color', labelEn: 'Primary Accent', labelZh: '核心主题色' },
                                    { key: '--accent-hover', labelEn: 'Accent Hover', labelZh: '主题悬浮色' }
                                ]
                            },
                            {
                                id: 'bg', labelEn: 'Backgrounds', labelZh: '背景颜色',
                                keys: [
                                    { key: '--bg-main', labelEn: 'App Background', labelZh: '全局主背景' },
                                    { key: '--bg-sidebar', labelEn: 'Sidebar Bg', labelZh: '侧边导航栏背景' },
                                    { key: '--bg-contacts', labelEn: 'Contacts List Bg', labelZh: '联系人列表背景' },
                                    { key: '--bg-chat-area', labelEn: 'Chat Area Bg', labelZh: '聊天区背景' },
                                    { key: '--bg-input', labelEn: 'Input Box Bg', labelZh: '输入框背景' }
                                ]
                            },
                            {
                                id: 'text', labelEn: 'Text, Borders & Icons', labelZh: '文字、边框与图标',
                                keys: [
                                    { key: '--text-primary', labelEn: 'Primary Text', labelZh: '主要文字颜色' },
                                    { key: '--text-secondary', labelEn: 'Secondary Text', labelZh: '次要文字颜色' },
                                    { key: '--border-color', labelEn: 'Border Color', labelZh: '全局边框颜色' },
                                    { key: '--sidebar-icon', labelEn: 'Sidebar Icon (Inactive)', labelZh: '侧边栏图标（未激活）' },
                                    { key: '--sidebar-icon-active', labelEn: 'Sidebar Icon (Active)', labelZh: '侧边栏图标（激活）' }
                                ]
                            },
                            {
                                id: 'bubbles', labelEn: 'Chat Bubbles', labelZh: '聊天气泡',
                                keys: [
                                    { key: '--bubble-user-bg', labelEn: 'User Bubble Bg', labelZh: '用户气泡背景' },
                                    { key: '--bubble-user-text', labelEn: 'User Bubble Text', labelZh: '用户气泡文字' },
                                    { key: '--bubble-ai-bg', labelEn: 'AI Bubble Bg', labelZh: 'AI 气泡背景' },
                                    { key: '--bubble-ai-text', labelEn: 'AI Bubble Text', labelZh: 'AI 气泡文字' }
                                ]
                            }
                        ].map(group => (
                            <div key={group.id} style={{ border: '1px solid #eaeaea', borderRadius: '8px', overflow: 'hidden' }}>
                                <button
                                    onClick={() => setThemeAccordion(prev => ({ ...prev, [group.id]: !prev[group.id] }))}
                                    style={{ width: '100%', display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 15px', background: themeAccordion[group.id] ? '#f8f9fa' : '#fff', border: 'none', cursor: 'pointer', outline: 'none', transition: 'background 0.2s' }}
                                >
                                    <span style={{ fontWeight: '500', fontSize: '14px', color: '#333' }}>
                                        {lang === 'en' ? group.labelEn : group.labelZh}
                                    </span>
                                    {themeAccordion[group.id] ? <ChevronDown size={18} color="#888" /> : <ChevronRight size={18} color="#888" />}
                                </button>
                                {themeAccordion[group.id] && (
                                    <div style={{ padding: '15px', display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(250px, 1fr))', gap: '15px', background: '#fff', borderTop: '1px solid #eaeaea' }}>
                                        {group.keys.map(({ key, labelEn, labelZh }) => (
                                            <div key={key} style={{ display: 'flex', flexDirection: 'column', gap: '5px' }}>
                                                <label style={{ fontSize: '12px', color: '#666' }}>{lang === 'en' ? labelEn : labelZh} <span style={{ fontFamily: 'monospace', opacity: 0.6 }}>({key})</span></label>
                                                <div style={{ display: 'flex', gap: '8px' }}>
                                                    <input
                                                        type="color"
                                                        value={editThemeConfig[key] && editThemeConfig[key].startsWith('#') ? editThemeConfig[key].slice(0, 7) : '#ffffff'}
                                                        onChange={(e) => setEditThemeConfig(prev => ({ ...prev, [key]: e.target.value }))}
                                                        style={{ width: '30px', height: '30px', padding: '0', border: '1px solid #ddd', borderRadius: '4px', cursor: 'pointer' }}
                                                    />
                                                    <input
                                                        type="text"
                                                        value={editThemeConfig[key] || ''}
                                                        onChange={(e) => setEditThemeConfig(prev => ({ ...prev, [key]: e.target.value }))}
                                                        placeholder="e.g. #7B9FE0 or rgba(...)"
                                                        style={{ flex: 1, padding: '4px 8px', border: '1px solid #ddd', borderRadius: '4px', fontSize: '13px', fontFamily: 'monospace' }}
                                                    />
                                                </div>
                                            </div>
                                        ))}
                                    </div>
                                )}
                            </div>
                        ))}
                    </div>

                    <div style={{ marginTop: '15px', border: '1px solid #eaeaea', borderRadius: '8px', overflow: 'hidden' }}>
                        <button
                            onClick={() => setThemeAccordion(prev => ({ ...prev, advanced: !prev.advanced }))}
                            style={{ width: '100%', display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 15px', background: themeAccordion.advanced ? '#f8f9fa' : '#fff', border: 'none', cursor: 'pointer', outline: 'none', transition: 'background 0.2s' }}
                        >
                            <span style={{ fontWeight: '500', fontSize: '14px', color: '#333' }}>
                                {lang === 'en' ? 'Custom CSS Injection' : '自定义 CSS 注入'}
                            </span>
                            {themeAccordion.advanced ? <ChevronDown size={18} color="#888" /> : <ChevronRight size={18} color="#888" />}
                        </button>
                        {themeAccordion.advanced && (
                            <div style={{ padding: '15px', background: '#fff', borderTop: '1px solid #eaeaea' }}>
                                <textarea
                                    value={editCustomCss}
                                    onChange={e => setEditCustomCss(e.target.value)}
                                    placeholder="/* body { background: red; } */"
                                    style={{ width: '100%', minHeight: '120px', padding: '10px', fontFamily: 'monospace', fontSize: '12px', borderRadius: '6px', border: '1px solid #ccc', resize: 'vertical' }}
                                />
                            </div>
                        )}
                    </div>

                    <div style={{ marginTop: '20px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '10px' }}>
                        <div style={{ display: 'flex', gap: '10px' }}>
                            <a href={`${apiUrl}/theme-guide`} download="chatpulse-theme-prompt.txt" style={{ display: 'flex', alignItems: 'center', gap: '5px', padding: '8px 12px', backgroundColor: '#f0f0f0', color: '#555', textDecoration: 'none', borderRadius: '6px', fontSize: '13px', fontWeight: '500' }}>
                                <FileText size={16} /> {lang === 'en' ? 'AI Theme Prompt' : '下载 AI 主题生成提示词'}
                            </a>
                            <button onClick={handleExportTheme} style={{ display: 'flex', alignItems: 'center', gap: '5px', padding: '8px 12px', backgroundColor: '#f0f0f0', color: '#555', border: 'none', borderRadius: '6px', cursor: 'pointer', fontSize: '13px', fontWeight: '500' }}>
                                <Download size={16} /> {lang === 'en' ? 'Export JSON' : '导出配置'}
                            </button>
                            <label style={{ display: 'flex', alignItems: 'center', gap: '5px', padding: '8px 12px', backgroundColor: '#f0f0f0', color: '#555', border: 'none', borderRadius: '6px', cursor: 'pointer', fontSize: '13px', fontWeight: '500' }}>
                                <Upload size={16} /> {lang === 'en' ? 'Import JSON' : '导入配置'}
                                <input type="file" accept=".json" style={{ display: 'none' }} onChange={handleImportTheme} />
                            </label>
                        </div>
                        <button onClick={handleSaveTheme} style={{ display: 'flex', alignItems: 'center', gap: '5px', padding: '8px 16px', backgroundColor: 'var(--accent-color)', color: '#fff', border: 'none', borderRadius: '6px', cursor: 'pointer', fontWeight: '500' }}>
                            <Save size={16} /> {lang === 'en' ? 'Save Theme & CSS' : '保存主题与 CSS'}
                        </button>
                    </div>
                </div>

                {/* Contacts Management Section */}
                <div style={{ backgroundColor: '#fff', padding: '20px', borderRadius: '8px', border: '1px solid #eee' }}>
                    <h2 style={{ margin: '0 0 20px 0', fontSize: '18px' }}>{t('Characters')}</h2>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                        {contacts.map(c => (
                            <div key={c.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px', border: '1px solid #f0f0f0', borderRadius: '6px' }}>
                                <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                                    <img src={resolveAvatarUrl(c.avatar, apiUrl)} alt={c.name} style={{ width: '40px', height: '40px', borderRadius: '50%', objectFit: 'cover' }} />
                                    <div>
                                        <div style={{ fontWeight: '500' }}>{c.name}</div>
                                        <div style={{ fontSize: '12px', color: '#999' }}>
                                            {lang === 'en' ? 'Affinity' : '好感度'}: {c.affinity} | 金币 {(c.wallet ?? 0).toFixed(2)} | {c.is_blocked ? (lang === 'en' ? 'Blocked' : '已拉黑') : (lang === 'en' ? 'Active' : '正常')}
                                        </div>
                                    </div>
                                </div>
                                <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
                                    {!!c.is_blocked && (
                                        <button
                                            onClick={async () => {
                                                try {
                                                    await fetch(`${apiUrl}/characters`, {
                                                        method: 'POST', headers: { 'Content-Type': 'application/json' },
                                                        body: JSON.stringify({ id: c.id, affinity: 60, is_blocked: 0 })
                                                    });
                                                    onCharactersUpdate?.();
                                                } catch (e) { console.error(e); }
                                            }}
                                            style={{ background: 'none', border: '1px solid #ddd', borderRadius: '4px', color: 'var(--accent-color)', cursor: 'pointer', padding: '3px 8px', fontSize: '12px' }}
                                            title={lang === 'en' ? 'Admin Unblock & Reset Affinity' : '管理员解除拉黑并重置好感度'}>
                                            🔁
                                        </button>
                                    )}
                                    <button
                                        onClick={() => handleWipeData(c.id)}
                                        style={{ background: 'none', border: 'none', color: 'var(--accent-color)', cursor: 'pointer', padding: '5px' }} title={lang === 'en' ? 'Wipe all data (Memories, Messages, etc)' : '清空全部数据（记忆、消息等）'}>
                                        <RefreshCw size={18} />
                                    </button>
                                    <button
                                        onClick={() => setEditingContact({ ...c, system_prompt: c.system_prompt || getDefaultGuidelines(lang) })}
                                        style={{ background: 'none', border: 'none', color: 'var(--accent-color)', cursor: 'pointer', padding: '5px' }} title={lang === 'en' ? 'Edit API endpoint, model, persona, prompt' : '编辑 API 接口、模型、人设和提示词'}>
                                        <Edit3 size={18} />
                                    </button>
                                    <button
                                        onClick={() => handleDeleteContact(c.id)}
                                        style={{ background: 'none', border: 'none', color: 'var(--danger)', cursor: 'pointer', padding: '5px' }} title={lang === 'en' ? 'Delete this character permanently' : '永久删除这个角色'}>
                                        <Trash2 size={18} />
                                    </button>
                                </div>
                            </div>
                        ))}
                    </div>
                </div>

                {/* Group Chat Settings */}
                <div style={{ backgroundColor: '#fff', padding: '20px', borderRadius: '8px', border: '1px solid #eee' }}>
                    <h2 style={{ margin: '0 0 20px 0', fontSize: '18px' }}>
                        {lang === 'en' ? 'Group Chat Settings' : '群聊设置'}
                    </h2>
                    {/* Skip Reply Chance */}
                    <div style={{ marginBottom: '18px' }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '14px', marginBottom: '6px' }}>
                            <span>{lang === 'en' ? 'Chance to Skip Reply' : '不回复概率'}</span>
                            <span>{Math.round((profile.group_skip_rate || 0) * 100)}%</span>
                        </div>
                        <input type="range" min="0" max="50" value={Math.round((profile.group_skip_rate || 0) * 100)}
                            onChange={e => {
                                const v = parseInt(e.target.value) / 100;
                                setProfile(p => ({ ...p, group_skip_rate: v }));
                                fetch(`${apiUrl}/user`, {
                                    method: 'PUT',
                                    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${localStorage.getItem('cp_token') || ''}` },
                                    body: JSON.stringify({ group_skip_rate: v })
                                });
                            }}
                            style={{ width: '100%', backgroundSize: `${(Math.round((profile.group_skip_rate || 0) * 100) - 0) * 100 / (50 - 0)}% 100%` }} />
                        <div style={{ fontSize: '11px', color: '#999', marginTop: '4px' }}>
                            {lang === 'en' ? 'Probability each character randomly skips replies. 0% = always reply, 50% = skip ~every other.'
                                : '每个角色随机跳过回复的概率。0% 表示总是回复，50% 表示大约每两条跳过一条。'}
                        </div>
                    </div>

                    {/* Proactive Group Messaging 鈥?frequency slider */}
                    <div style={{ marginBottom: '18px' }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '14px', marginBottom: '6px' }}>
                            <span>{lang === 'en' ? 'Proactive Messaging Frequency' : '群聊主动发消息频率'}</span>
                            <span>
                                {!profile.group_proactive_enabled
                                    ? (lang === 'en' ? 'Off' : '关闭')
                                    : `${profile.group_interval_min || 3}~${profile.group_interval_max || 10} ${lang === 'en' ? 'min' : '分钟'}`}
                            </span>
                        </div>
                        <input type="range" min="0" max="10"
                            value={(() => {
                                if (!profile.group_proactive_enabled) return 0;
                                const avg = ((profile.group_interval_min || 3) + (profile.group_interval_max || 10)) / 2;
                                return Math.max(1, Math.min(10, Math.round(11 - avg)));
                            })()}
                            onChange={e => {
                                const level = parseInt(e.target.value);
                                if (level === 0) {
                                    setProfile(p => ({ ...p, group_proactive_enabled: 0 }));
                                    fetch(`${apiUrl}/user`, {
                                        method: 'PUT',
                                        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${localStorage.getItem('cp_token') || ''}` },
                                        body: JSON.stringify({ group_proactive_enabled: 0 })
                                    });
                                } else {
                                    const avg = 11 - level;
                                    const min = Math.max(1, avg - 2);
                                    const max = Math.max(min, 2 * avg - min); // Ensures (min+max)/2 always matches `avg` so slider doesn't snap back
                                    setProfile(p => ({ ...p, group_proactive_enabled: 1, group_interval_min: min, group_interval_max: max }));
                                    fetch(`${apiUrl}/user`, {
                                        method: 'PUT',
                                        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${localStorage.getItem('cp_token') || ''}` },
                                        body: JSON.stringify({ group_proactive_enabled: 1, group_interval_min: min, group_interval_max: max })
                                    });
                                }
                            }}
                            style={{ width: '100%' }} />
                        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11px', color: '#999', marginTop: '4px' }}>
                            <span>{lang === 'en' ? 'Off' : '关闭'}</span>
                            <span>{lang === 'en' ? 'Very frequent' : '非常频繁'}</span>
                        </div>
                    </div>

                    {/* Jealousy Chance */}
                    <div style={{ marginBottom: '10px' }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '14px', marginBottom: '6px' }}>
                            <span>{lang === 'en' ? 'Jealousy Chance' : '嫉妒概率'}</span>
                            <span>{Math.round((profile.jealousy_chance ?? 0.3) * 100)}%</span>
                        </div>
                        <input type="range" min="0" max="100" value={Math.round((profile.jealousy_chance ?? 0.3) * 100)}
                            onChange={e => {
                                const v = parseInt(e.target.value) / 100;
                                setProfile(p => ({ ...p, jealousy_chance: v }));
                                fetch(`${apiUrl}/user`, {
                                    method: 'PUT',
                                    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${localStorage.getItem('cp_token') || ''}` },
                                    body: JSON.stringify({ jealousy_chance: v })
                                });
                            }}
                            style={{ width: '100%', backgroundSize: `${(Math.round((profile.jealousy_chance ?? 0.3) * 100) - 0) * 100 / (100 - 0)}% 100%` }} />
                        <div style={{ fontSize: '11px', color: '#999', marginTop: '4px' }}>
                            {lang === 'en' ? 'Probability that a character gets jealous when you chat with someone else. 0% = never, 100% = always.'
                                : '当你和别人聊天时，角色产生嫉妒的概率。0% 表示从不，100% 表示总是。'}
                        </div>
                    </div>
                </div>

                {/* Scheduled Tasks DLC */}
                <Scheduler apiUrl={apiUrl} contacts={contacts} />

                {/* Wallet */}
                <div style={{ backgroundColor: '#fff', padding: '20px', borderRadius: '8px', border: '1px solid #eee' }}>
                    <h2 style={{ margin: '0 0 15px 0', fontSize: '18px' }}>
                        {lang === 'en' ? 'Wallet' : '钱包'}
                    </h2>
                    <div style={{ fontSize: '14px', color: '#666' }}>
                        {lang === 'en' ? 'Wallet Balance (¥):' : '钱包余额（元）：'}
                        <span style={{ fontSize: '24px', fontWeight: '700', color: 'var(--accent-color)', marginLeft: '10px' }}>
                            ¥{(profile.wallet ?? 100).toFixed(2)}
                        </span>
                    </div>
                </div>

                {/* Moments Feed Settings */}
                <div style={{ backgroundColor: '#fff', padding: '20px', borderRadius: '8px', border: '1px solid #eee', marginTop: '20px' }}>
                    <h2 style={{ margin: '0 0 20px 0', fontSize: '18px' }}>
                        {lang === 'en' ? 'Moments Settings' : '朋友圈设置'}
                    </h2>

                    {/* Moments Context Limit */}
                    <div style={{ marginBottom: '18px' }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '14px', marginBottom: '6px' }}>
                            <span>{lang === 'en' ? 'Max Context Tokens' : '朋友圈上下文注入量'}</span>
                            <span>{editMomentsTokenLimit} {lang === 'en' ? 'chars' : '字'}</span>
                        </div>
                        <input type="range" min="0" max="10000" step="100" value={editMomentsTokenLimit}
                            onChange={e => {
                                const v = parseInt(e.target.value);
                                setEditMomentsTokenLimit(v);
                                setProfile(p => ({ ...p, moments_token_limit: v }));
                                fetch(`${apiUrl}/user`, {
                                    method: 'PUT',
                                    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${localStorage.getItem('cp_token') || ''}` },
                                    body: JSON.stringify({ moments_token_limit: v })
                                });
                            }}
                            style={{ width: '100%', backgroundSize: `${(editMomentsTokenLimit - 0) * 100 / (10000 - 0)}% 100%` }} />
                        <div style={{ fontSize: '11px', color: '#999', marginTop: '4px' }}>
                            {lang === 'en' ? 'How much of the recent Moments feed to inject into the AI memory. Larger values cost more tokens but allow AI to read more posts.'
                                : '每次私聊或群聊回复时，为 AI 提供多少近期朋友圈内容。数值越大，消耗的 token 越多，但角色能读到的动态也越多。0 表示关闭。'}
                        </div>
                    </div>

                    {/* Moments Reaction Rate */}
                    <div style={{ marginBottom: '10px' }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '14px', marginBottom: '6px' }}>
                            <span>{lang === 'en' ? 'Reaction Probability' : '互动反馈概率'}</span>
                            <span>{editMomentsReactionRate}%</span>
                        </div>
                        <input type="range" min="0" max="100" value={editMomentsReactionRate}
                            onChange={e => {
                                const v = parseInt(e.target.value);
                                setEditMomentsReactionRate(v);
                                setProfile(p => ({ ...p, moments_reaction_rate: v }));
                                fetch(`${apiUrl}/user`, {
                                    method: 'PUT',
                                    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${localStorage.getItem('cp_token') || ''}` },
                                    body: JSON.stringify({ moments_reaction_rate: v })
                                });
                            }}
                            style={{ width: '100%', backgroundSize: `${(editMomentsReactionRate - 0) * 100 / (100 - 0)}% 100%` }} />
                        <div style={{ fontSize: '11px', color: '#999', marginTop: '4px' }}>
                            {lang === 'en' ? 'Probability that a character naturally reacts/replies in private chat when you like or comment on their Moment.'
                                : '当你给角色的朋友圈点赞或评论时，该角色在私聊里主动来找你互动的概率。'}
                        </div>
                    </div>
                </div>

                {/* Data Management */}
                <div style={{ backgroundColor: '#fff', padding: '20px', borderRadius: '8px', border: '1px solid #eee' }}>
                    <h2 style={{ margin: '0 0 15px 0', fontSize: '18px', display: 'flex', alignItems: 'center', gap: '8px' }}>
                        <Save size={20} /> {lang === 'en' ? 'Data Backup & Restore' : '数据备份与恢复'}
                    </h2>
                    <p style={{ fontSize: '13px', color: '#666', marginBottom: '15px', lineHeight: 1.5 }}>
                        {lang === 'en' ? 'Backup your entire ChatPulse database (chats, memories, settings) as a single SQLite file, or restore from a previous backup.' : '将整个 ChatPulse 数据库（聊天、记忆、设置）备份为单个 SQLite 文件，或从之前的备份中恢复。'}
                    </p>
                    <div style={{ display: 'flex', gap: '15px', flexWrap: 'wrap', alignItems: 'center' }}>
                        <a href={`${apiUrl}/system/export?token=${localStorage.getItem('cp_token') || ''}`} download="chatpulse.db" style={{ display: 'flex', alignItems: 'center', gap: '6px', padding: '10px 16px', backgroundColor: 'var(--accent-color)', color: '#fff', textDecoration: 'none', borderRadius: '6px', fontSize: '14px', fontWeight: 'bold' }}>
                            <Download size={18} /> {lang === 'en' ? 'Download Full Backup (.db)' : '下载完整备份（.db）'}
                        </a>
                        <label style={{ display: 'flex', alignItems: 'center', gap: '6px', padding: '10px 16px', backgroundColor: '#f0f0f0', color: '#333', border: '1px solid #ddd', borderRadius: '6px', cursor: 'pointer', fontSize: '14px', fontWeight: 'bold' }}>
                            <Upload size={18} /> {lang === 'en' ? 'Restore from Backup' : '上传并恢复存档'}
                            <input type="file" accept=".db,application/x-sqlite3,application/octet-stream" style={{ display: 'none' }} onChange={handleImportDatabase} />
                        </label>
                        <div style={{ width: '1px', height: '24px', backgroundColor: '#ddd', margin: '0 5px' }}></div>
                        <button onClick={handleSystemWipe} style={{ display: 'flex', alignItems: 'center', gap: '6px', padding: '10px 16px', backgroundColor: '#fff', color: 'var(--danger)', border: '1px solid var(--danger)', borderRadius: '6px', cursor: 'pointer', fontSize: '14px', fontWeight: 'bold' }}>
                            <Trash2 size={18} /> {lang === 'en' ? 'Factory Reset (Wipe All)' : '恢复出厂设置（清空所有数据）'}
                        </button>
                    </div>
                </div>

            </div>

            {/* Character Edit Modal */}
            {editingContact && (
                <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}>
                    <div style={{ backgroundColor: '#fff', padding: '20px', borderRadius: '8px', width: '90%', maxWidth: '500px', display: 'flex', flexDirection: 'column', gap: '15px', maxHeight: '90vh', overflowY: 'auto' }}>
                        <h3 style={{ margin: 0 }}>Edit Character Setting: {editingContact.name}</h3>

                        <div style={{ display: 'flex', gap: '10px' }}>
                            <label style={{ flex: 1, display: 'flex', flexDirection: 'column', fontSize: '14px', color: '#666' }}>
                                {t('Name')}:
                                <input type="text" value={editingContact.name || ''} onChange={(e) => setEditingContact({ ...editingContact, name: e.target.value })} style={{ padding: '8px', marginTop: '5px', border: '1px solid #ddd', borderRadius: '4px' }} />
                            </label>
                            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', fontSize: '14px', color: '#666' }}>
                                {t('Avatar URL')}:
                                <div style={{ display: 'flex', gap: '5px', marginTop: '5px' }}>
                                    <input type="text" value={editingContact.avatar || ''} onChange={(e) => setEditingContact({ ...editingContact, avatar: e.target.value })} style={{ flex: 1, padding: '8px', border: '1px solid #ddd', borderRadius: '4px' }} />
                                    <label style={{ cursor: 'pointer', padding: '8px 12px', backgroundColor: '#f0f0f0', border: '1px solid #ddd', borderRadius: '4px', fontSize: '14px', whiteSpace: 'nowrap' }}>
                                        Upload
                                        <input type="file" accept="image/*" style={{ display: 'none' }} onChange={(e) => handleFileUpload(e, (url) => setEditingContact({ ...editingContact, avatar: url }))} />
                                    </label>
                                </div>
                            </div>
                        </div>

                        <label style={{ display: 'flex', flexDirection: 'column', fontSize: '14px', color: '#666' }}>
                            {t('API Endpoint')}:
                            <input type="text" value={editingContact.api_endpoint || ''} onChange={(e) => setEditingContact({ ...editingContact, api_endpoint: e.target.value })} style={{ padding: '8px', marginTop: '5px', border: '1px solid #ddd', borderRadius: '4px' }} />
                        </label>

                        <label style={{ display: 'flex', flexDirection: 'column', fontSize: '14px', color: '#666' }}>
                            {t('API Key')}:
                            <input type="password" value={editingContact.api_key || ''} onChange={(e) => setEditingContact({ ...editingContact, api_key: e.target.value })} placeholder="sk-..." style={{ padding: '8px', marginTop: '5px', border: '1px solid #ddd', borderRadius: '4px' }} />
                        </label>

                        <div style={{ display: 'flex', gap: '10px' }}>
                            <label style={{ flex: 1, display: 'flex', flexDirection: 'column', fontSize: '14px', color: '#666' }}>
                                {t('Model Name')}:
                                <div style={{ display: 'flex', gap: '5px', marginTop: '5px' }}>
                                    <input type="text" value={editingContact.model_name || ''} onChange={(e) => setEditingContact({ ...editingContact, model_name: e.target.value })} style={{ flex: 1, padding: '8px', border: '1px solid #ddd', borderRadius: '4px' }} />
                                    <button type="button" onClick={() => fetchModels(editingContact.api_endpoint, editingContact.api_key, setMainModels, setMainModelFetching, setMainModelError)} disabled={mainModelFetching}
                                        style={{ padding: '6px 10px', background: 'var(--accent-color)', color: '#fff', border: 'none', borderRadius: '4px', cursor: 'pointer', whiteSpace: 'nowrap', display: 'flex', alignItems: 'center', gap: '4px' }}>
                                        <RefreshCw size={13} /> {mainModelFetching ? '...' : t('Fetch Models')}
                                    </button>
                                </div>
                                {mainModelError && <span style={{ color: 'var(--danger)', fontSize: '12px' }}>{mainModelError}</span>}
                                {mainModels.length > 0 && (
                                    <select defaultValue="" onChange={e => setEditingContact({ ...editingContact, model_name: e.target.value })}
                                        style={{ marginTop: '4px', padding: '6px', border: '1px solid #ddd', borderRadius: '4px', fontSize: '13px' }}>
                                        <option value="" disabled>-- 选择模型 --</option>
                                        {mainModels.map(m => <option key={m} value={m}>{m}</option>)}
                                    </select>
                                )}
                            </label>
                            <label style={{ flex: 1, display: 'flex', flexDirection: 'column', fontSize: '14px', color: '#666' }}>
                                {t('Max Output Tokens')}:
                                <input type="number" value={editingContact.max_tokens ?? 800} onChange={(e) => setEditingContact({ ...editingContact, max_tokens: parseInt(e.target.value) || 800 })} style={{ padding: '8px', marginTop: '5px', border: '1px solid #ddd', borderRadius: '4px' }} />
                            </label>
                        </div>
                        <div style={{ display: 'flex', gap: '20px' }}>
                            <label style={{ flex: 1, display: 'flex', flexDirection: 'column', fontSize: '14px', color: '#666' }}>
                                Min Interval (mins):
                                <div className="autopulse-interval-control" style={{ marginTop: '5px' }}>
                                    <input type="range" min="0.1" max="120" step="0.1" value={editingContact.interval_min || 0.1} onChange={(e) => setEditingContact({ ...editingContact, interval_min: parseFloat(e.target.value) })} style={{ width: '100%', backgroundSize: `${((editingContact.interval_min || 0.1) - 0.1) * 100 / (120 - 0.1)}% 100%` }} />
                                    <input type="number" step="0.1" value={editingContact.interval_min || 0} onChange={(e) => setEditingContact({ ...editingContact, interval_min: parseFloat(e.target.value) })} className="autopulse-number-input" />
                                </div>
                            </label>
                            <label style={{ flex: 1, display: 'flex', flexDirection: 'column', fontSize: '14px', color: '#666' }}>
                                Max Interval (mins):
                                <div className="autopulse-interval-control" style={{ marginTop: '5px' }}>
                                    <input type="range" min="0.1" max="120" step="0.1" value={editingContact.interval_max || 0.1} onChange={(e) => setEditingContact({ ...editingContact, interval_max: parseFloat(e.target.value) })} style={{ width: '100%', backgroundSize: `${((editingContact.interval_max || 0.1) - 0.1) * 100 / (120 - 0.1)}% 100%` }} />
                                    <input type="number" step="0.1" value={editingContact.interval_max || 0} onChange={(e) => setEditingContact({ ...editingContact, interval_max: parseFloat(e.target.value) })} className="autopulse-number-input" />
                                </div>
                            </label>
                        </div>

                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px', marginTop: '10px', marginBottom: '5px', background: '#f9f9f9', padding: '10px', borderRadius: '4px', border: '1px solid #eee' }}>
                            <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px', color: '#333', cursor: 'pointer' }}>
                                <input type="checkbox" checked={editingContact.sys_proactive !== 0} onChange={(e) => setEditingContact({ ...editingContact, sys_proactive: e.target.checked ? 1 : 0 })} />
                                {t('Toggle Proactive Messages')}
                            </label>
                            <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px', color: '#333', cursor: 'pointer' }}>
                                <input type="checkbox" checked={editingContact.sys_timer !== 0} onChange={(e) => setEditingContact({ ...editingContact, sys_timer: e.target.checked ? 1 : 0 })} />
                                {t('Toggle Timer Actions')}
                            </label>
                            <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px', color: '#333', cursor: 'pointer' }}>
                                <input type="checkbox" checked={editingContact.sys_pressure !== 0} onChange={(e) => setEditingContact({ ...editingContact, sys_pressure: e.target.checked ? 1 : 0 })} />
                                {t('Toggle Pressure System')}
                            </label>
                            <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px', color: '#333', cursor: 'pointer' }}>
                                <input type="checkbox" checked={editingContact.sys_jealousy !== 0} onChange={(e) => setEditingContact({ ...editingContact, sys_jealousy: e.target.checked ? 1 : 0 })} />
                                {t('Toggle Jealousy System')}
                            </label>
                            <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px', color: '#333', cursor: 'pointer' }} title={lang === 'en' ? 'Enable/disable this character in City DLC simulation' : '开启或关闭该角色参与商业街模拟活动'}>
                                <input type="checkbox" checked={editingContact.sys_survival !== 0} onChange={(e) => setEditingContact({ ...editingContact, sys_survival: e.target.checked ? 1 : 0 })} />
                                {lang === 'en' ? 'City Activity' : '参与商业街活动'}
                            </label>
                            <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px', color: '#333', cursor: 'pointer' }} title={lang === 'en' ? 'Allow this character to join City social encounters when sharing a location' : '控制这个角色在同地时是否参与商业街相遇'}>
                                <input type="checkbox" checked={editingContact.sys_city_social !== 0} onChange={(e) => setEditingContact({ ...editingContact, sys_city_social: e.target.checked ? 1 : 0 })} />
                                {lang === 'en' ? 'City Encounters' : '商业街相遇'}
                            </label>
                        </div>

                        {/* Base Stats Panel */}
                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '10px', marginTop: '10px', padding: '10px', background: '#f0f4f8', borderRadius: '4px', border: '1px solid #dce4ec' }}>
                            <label style={{ display: 'flex', flexDirection: 'column', fontSize: '13px', color: '#444' }} title="影响工作收益和学习效率">
                                <span style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '6px' }}>
                                    <span>🧠 {t('Intelligence', '智力（决定打工赚钱多少）')}</span>
                                    <span style={{ fontWeight: '600', color: '#2196f3' }}>{editingContact.stat_int ?? 50}</span>
                                </span>
                                <input type="range" min="0" max="100" value={editingContact.stat_int ?? 50} onChange={(e) => setEditingContact({ ...editingContact, stat_int: parseInt(e.target.value) || 50 })} style={{ width: '100%' }} />
                            </label>
                            <label style={{ display: 'flex', flexDirection: 'column', fontSize: '13px', color: '#444' }} title="影响体力上限和抗饥饿能力">
                                <span style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '6px' }}>
                                    <span>💪 {t('Stamina', '体力（越高越不容易饥饿）')}</span>
                                    <span style={{ fontWeight: '600', color: '#4caf50' }}>{editingContact.stat_sta ?? 50}</span>
                                </span>
                                <input type="range" min="0" max="100" value={editingContact.stat_sta ?? 50} onChange={(e) => setEditingContact({ ...editingContact, stat_sta: parseInt(e.target.value) || 50 })} style={{ width: '100%' }} />
                            </label>
                            <label style={{ display: 'flex', flexDirection: 'column', fontSize: '13px', color: '#444' }} title="影响社交好感度加成">
                                <span style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '6px' }}>
                                    <span>✨ {t('Charm', '魅力（影响社交互动效果）')}</span>
                                    <span style={{ fontWeight: '600', color: '#e91e63' }}>{editingContact.stat_cha ?? 50}</span>
                                </span>
                                <input type="range" min="0" max="100" value={editingContact.stat_cha ?? 50} onChange={(e) => setEditingContact({ ...editingContact, stat_cha: parseInt(e.target.value) || 50 })} style={{ width: '100%' }} />
                            </label>
                        </div>

                        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', marginTop: '10px', padding: '10px', background: '#f5f7fa', borderRadius: '4px', border: '1px solid #e2e8f0' }}>
                            <strong style={{ fontSize: '13px', color: '#4a5568' }}>Memory Extraction AI (Small Model)</strong>
                            <label style={{ display: 'flex', flexDirection: 'column', fontSize: '14px', color: '#666' }}>
                                {t('Memory API Endpoint')}:
                                <input type="text" value={editingContact.memory_api_endpoint || ''} onChange={(e) => setEditingContact({ ...editingContact, memory_api_endpoint: e.target.value })} placeholder="e.g. https://api.openai.com/v1" style={{ padding: '8px', marginTop: '5px', border: '1px solid #ddd', borderRadius: '4px' }} />
                            </label>
                            <label style={{ display: 'flex', flexDirection: 'column', fontSize: '14px', color: '#666' }}>
                                {t('Memory API Key')}:
                                <input type="password" value={editingContact.memory_api_key || ''} onChange={(e) => setEditingContact({ ...editingContact, memory_api_key: e.target.value })} style={{ padding: '8px', marginTop: '5px', border: '1px solid #ddd', borderRadius: '4px' }} />
                            </label>
                            <label style={{ display: 'flex', flexDirection: 'column', fontSize: '14px', color: '#666' }}>
                                Memory Model Name:
                                <div style={{ display: 'flex', gap: '5px', marginTop: '5px' }}>
                                    <input type="text" value={editingContact.memory_model_name || ''} onChange={(e) => setEditingContact({ ...editingContact, memory_model_name: e.target.value })} placeholder="e.g. gpt-4o-mini" style={{ flex: 1, padding: '8px', border: '1px solid #ddd', borderRadius: '4px' }} />
                                    <button type="button" onClick={() => fetchModels(editingContact.memory_api_endpoint, editingContact.memory_api_key, setMemModels, setMemModelFetching, setMemModelError)} disabled={memModelFetching}
                                        style={{ padding: '6px 10px', background: 'var(--accent-color)', color: '#fff', border: 'none', borderRadius: '4px', cursor: 'pointer', whiteSpace: 'nowrap', display: 'flex', alignItems: 'center', gap: '4px' }}>
                                        <RefreshCw size={13} /> {memModelFetching ? '...' : '拉取'}
                                    </button>
                                </div>
                                {memModelError && <span style={{ color: 'var(--danger)', fontSize: '12px' }}>{memModelError}</span>}
                                {memModels.length > 0 && (
                                    <select defaultValue="" onChange={e => setEditingContact({ ...editingContact, memory_model_name: e.target.value })}
                                        style={{ marginTop: '4px', padding: '6px', border: '1px solid #ddd', borderRadius: '4px', fontSize: '13px' }}>
                                        <option value="" disabled>-- 选择模型 --</option>
                                        {memModels.map(m => <option key={m} value={m}>{m}</option>)}
                                    </select>
                                )}
                            </label>
                        </div>

                        <label style={{ display: 'flex', flexDirection: 'column', fontSize: '14px', color: '#666', marginTop: '10px' }}>
                            Persona (Prompt Info):
                            <textarea value={editingContact.persona || ''} onChange={(e) => setEditingContact({ ...editingContact, persona: e.target.value })} style={{ padding: '8px', marginTop: '5px', border: '1px solid #ddd', borderRadius: '4px', minHeight: '80px', resize: 'vertical' }} />
                        </label>

                        <label style={{ display: 'flex', flexDirection: 'column', fontSize: '14px', color: '#666', marginTop: '10px' }}>
                            System Guidelines (Core Rules & Tags):
                            <textarea
                                value={editingContact.system_prompt || ''}
                                onChange={(e) => setEditingContact({ ...editingContact, system_prompt: e.target.value })}
                                placeholder="Leave blank to use default system guidelines."
                                style={{ padding: '8px', marginTop: '5px', border: '1px solid #ddd', borderRadius: '4px', minHeight: '120px', resize: 'vertical', fontFamily: 'monospace', fontSize: '12px' }}
                            />
                        </label>

                        <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end', marginTop: '10px' }}>
                            <button onClick={() => setEditingContact(null)} style={{ padding: '8px 16px', background: '#f0f0f0', border: 'none', borderRadius: '4px', cursor: 'pointer' }}>Cancel</button>
                            <button onClick={handleSaveContact} style={{ padding: '8px 16px', background: 'var(--accent-color)', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer' }}>Save Settings</button>
                        </div>
                    </div>
                </div>
            )}
        </>
    );
}

export default SettingsPanel;
