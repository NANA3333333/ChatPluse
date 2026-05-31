import React, { useState } from 'react';
import { useAuth } from '../AuthContext';
import { MessageCircle, RotateCcw, ShieldCheck, Sparkles } from 'lucide-react';

function Login({ apiUrl }) {
    const { login } = useAuth();
    const [isRegistering, setIsRegistering] = useState(false);
    const [username, setUsername] = useState('');
    const [password, setPassword] = useState('');
    const [inviteCode, setInviteCode] = useState('');
    const [error, setError] = useState('');
    const [loading, setLoading] = useState(false);

    const handleResetLocalState = () => {
        [
            'cp_custom_css',
            'cp_theme_config',
            'cp_theme',
            'cp_avatar',
        ].forEach((key) => localStorage.removeItem(key));

        window.location.reload();
    };

    const handleSubmit = async (e) => {
        e.preventDefault();
        setError('');
        setLoading(true);

        const endpoint = isRegistering ? '/api/auth/register' : '/api/auth/login';

        try {
            const cleanApiUrl = apiUrl.replace(/\/api\/?$/, '');
            const payload = isRegistering ? { username, password, inviteCode } : { username, password };

            const res = await fetch(`${cleanApiUrl}${endpoint}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
            const data = await res.json();

            if (data.success) {
                login(data.token, data.user);
            } else {
                setError(data.error || 'Authentication failed');
            }
        } catch {
            setError('Network error. Please check if the server is running.');
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="login-container">
            <div className="login-shell">
                <aside className="login-brand-panel" aria-hidden="true">
                    <div className="login-brand-mark">
                        <MessageCircle size={34} />
                    </div>
                    <div>
                        <p className="login-eyebrow">ChatPulse</p>
                        <h1>让每段对话继续生长</h1>
                    </div>
                    <div className="login-preview-card">
                        <div className="login-preview-top">
                            <span></span>
                            <span></span>
                            <span></span>
                        </div>
                        <div className="login-preview-row">
                            <div className="login-preview-avatar"></div>
                            <div className="login-preview-bubble wide"></div>
                        </div>
                        <div className="login-preview-row reverse">
                            <div className="login-preview-bubble short"></div>
                        </div>
                        <div className="login-preview-pulse">
                            <Sparkles size={16} />
                            <span>Pulse ready</span>
                        </div>
                    </div>
                </aside>

                <main className="login-glass-panel">
                    <div className="login-header">
                        <div className="login-logo">
                            <MessageCircle size={32} />
                        </div>
                        <h1>ChatPulse</h1>
                        <p className="login-subtitle">Immersive AI social simulation.</p>
                    </div>

                    <div className="login-mode-switch" role="tablist" aria-label="Authentication mode">
                        <button
                            type="button"
                            className={!isRegistering ? 'active' : ''}
                            onClick={() => { setIsRegistering(false); setError(''); }}
                        >
                            登录
                        </button>
                        <button
                            type="button"
                            className={isRegistering ? 'active' : ''}
                            onClick={() => { setIsRegistering(true); setError(''); }}
                        >
                            注册
                        </button>
                    </div>

                    <form className="login-form" onSubmit={handleSubmit}>
                        {!isRegistering && (
                            <div className="login-note">
                                <ShieldCheck size={16} />
                                <span>请使用管理员提供的账号登录。首次部署请先在服务器环境中设置管理员密码。</span>
                            </div>
                        )}
                        <div className="input-group">
                            <label>账号 (Username)</label>
                            <input
                                type="text"
                                required
                                autoFocus
                                autoComplete="username"
                                value={username}
                                onChange={(e) => setUsername(e.target.value.trim())}
                                placeholder="输入你的账号"
                            />
                        </div>
                        <div className="input-group">
                            <label>密码 (Password)</label>
                            <input
                                type="password"
                                required
                                autoComplete={isRegistering ? 'new-password' : 'current-password'}
                                value={password}
                                onChange={(e) => setPassword(e.target.value)}
                                placeholder="输入密码"
                            />
                        </div>

                        {isRegistering && (
                            <div className="input-group">
                                <label>邀请码 (Invite Code)</label>
                                <input
                                    type="text"
                                    value={inviteCode}
                                    onChange={(e) => setInviteCode(e.target.value.trim())}
                                    placeholder="输入邀请码"
                                    required
                                />
                            </div>
                        )}

                        {error && <div className="login-error">{error}</div>}

                        <button type="submit" className="login-submit-btn" disabled={loading}>
                            {loading ? <div className="btn-spinner"></div> : (isRegistering ? '注册 / Register' : '登录 / Login')}
                        </button>
                    </form>

                    <div className="login-footer">
                        <button className="text-btn toggle-mode-btn" type="button" onClick={() => { setIsRegistering(!isRegistering); setError(''); }}>
                            {isRegistering ? '已有账号？立即登录' : '没有账号？使用邀请码注册'}
                        </button>
                        <button className="text-btn reset-local-btn" type="button" onClick={handleResetLocalState}>
                            <RotateCcw size={13} />
                            <span>重置本地界面状态 / Reset Local UI State</span>
                        </button>
                    </div>
                </main>
            </div>
        </div>
    );
}

export default Login;
