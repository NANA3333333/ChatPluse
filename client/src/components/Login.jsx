import React, { useState } from 'react';
import { useAuth } from '../AuthContext';

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
            'cp_token',
            'cp_user',
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
        } catch (err) {
            setError('Network error. Please check if the server is running.');
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="login-container">
            <div className="login-glass-panel">
                <div className="login-header">
                    <div className="login-logo">
                        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path>
                        </svg>
                    </div>
                    <h1>ChatPulse</h1>
                    <p className="login-subtitle">Immersive AI social simulation.</p>
                </div>

                <form className="login-form" onSubmit={handleSubmit}>
                    {!isRegistering && (
                        <div style={{ marginBottom: '12px', color: 'rgba(255,255,255,0.72)', fontSize: '13px', lineHeight: 1.4, textAlign: 'center' }}>
                            首次部署默认账号 Nana，默认密码 12345
                        </div>
                    )}
                    <div className="input-group">
                        <label>账号 (Username)</label>
                        <input
                            type="text"
                            required
                            autoFocus
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
                        重置本地界面状态 / Reset Local UI State
                    </button>
                </div>
            </div>
        </div>
    );
}

export default Login;
