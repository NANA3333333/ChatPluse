import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useAuth } from '../AuthContext';
import { Ban, Copy, Database, Key, RefreshCw, Search, Send, Shield, Trash2, Users } from 'lucide-react';

const cardStyle = {
    background: 'var(--card-bg)',
    border: '1px solid var(--card-border)',
    borderRadius: '12px',
    padding: '24px',
    boxShadow: '0 4px 12px rgba(0,0,0,0.05)',
};

function actionButtonStyle(background, color, disabled = false) {
    return {
        background,
        border: 'none',
        cursor: disabled ? 'wait' : 'pointer',
        color,
        padding: '6px 10px',
        borderRadius: '6px',
        opacity: disabled ? 0.6 : 1,
    };
}

function badgeStyle(bg, color) {
    return { display: 'inline-block', padding: '3px 8px', borderRadius: '999px', background: bg, color };
}

function formatStatus(status) {
    return status === 'banned' ? '已封禁' : '正常';
}

function formatRole(role) {
    if (role === 'root') return '根管理员';
    if (role === 'admin') return '管理员';
    return '普通用户';
}

function timeAgo(timestamp) {
    if (!timestamp) return '从未';
    const seconds = Math.floor((Date.now() - Number(timestamp)) / 1000);
    if (seconds < 60) return `${seconds} 秒前`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)} 小时前`;
    return `${Math.floor(seconds / 86400)} 天前`;
}

function showActionError(setError, fallbackMessage, error) {
    const message = String(error || fallbackMessage || '操作失败').trim();
    setError(message);
    window.alert(message);
}

export default function AdminDashboard({ apiUrl }) {
    const { user, token } = useAuth();
    const [users, setUsers] = useState([]);
    const [inviteCodes, setInviteCodes] = useState([]);
    const [qdrantStatus, setQdrantStatus] = useState(null);
    const [error, setError] = useState('');
    const [loading, setLoading] = useState(false);
    const [busyUserId, setBusyUserId] = useState('');
    const [copiedCode, setCopiedCode] = useState('');
    const [announcementMsg, setAnnouncementMsg] = useState('');
    const [userQuery, setUserQuery] = useState('');

    const cleanApiUrl = apiUrl.replace(/\/api\/?$/, '');
    const isAdmin = user?.role === 'root' || user?.role === 'admin';
    const isRoot = user?.role === 'root';
    const authHeaders = useMemo(() => ({ Authorization: `Bearer ${token}` }), [token]);

    const fetchUsers = useCallback(async () => {
        try {
            const res = await fetch(`${cleanApiUrl}/api/admin/users`, { headers: authHeaders });
            const data = await res.json();
            if (!data.success) throw new Error(data.error || '加载用户失败');
            setUsers(data.users || []);
        } catch (e) {
            setError(e.message || '加载用户失败');
        }
    }, [authHeaders, cleanApiUrl]);

    const fetchInvites = useCallback(async () => {
        try {
            const res = await fetch(`${cleanApiUrl}/api/admin/invites/all`, { headers: authHeaders });
            const data = await res.json();
            if (!data.success) throw new Error(data.error || '加载邀请码失败');
            setInviteCodes(data.codes || []);
        } catch (e) {
            setError(e.message || '加载邀请码失败');
        }
    }, [authHeaders, cleanApiUrl]);

    const fetchQdrantStatus = useCallback(async () => {
        try {
            const res = await fetch(`${cleanApiUrl}/api/admin/qdrant/status`, { headers: authHeaders });
            const data = await res.json();
            if (!data.success) throw new Error(data.error || '加载 Qdrant 状态失败');
            setQdrantStatus(data.status || null);
        } catch (e) {
            setError(e.message || '加载 Qdrant 状态失败');
        }
    }, [authHeaders, cleanApiUrl]);

    useEffect(() => {
        if (!isAdmin) return;
        fetchUsers();
        fetchInvites();
        fetchQdrantStatus();
    }, [isAdmin, fetchUsers, fetchInvites, fetchQdrantStatus]);

    const filteredUsers = useMemo(() => {
        const q = userQuery.trim().toLowerCase();
        if (!q) return users;
        return users.filter((item) =>
            String(item.username || '').toLowerCase().includes(q) ||
            String(item.id || '').toLowerCase().includes(q) ||
            String(item.role || '').toLowerCase().includes(q) ||
            String(item.status || '').toLowerCase().includes(q)
        );
    }, [userQuery, users]);

    const handleDeleteUser = async (target) => {
        if (!window.confirm(`危险操作：确定删除账号「${target.username}」并清空其全部数据吗？此操作不可恢复。`)) return;
        setBusyUserId(target.id);
        setError('');
        try {
            const res = await fetch(`${cleanApiUrl}/api/admin/users/${target.id}`, {
                method: 'DELETE',
                headers: authHeaders,
            });
            const data = await res.json();
            if (!data.success) throw new Error(data.error || '删除用户失败');
            setUsers((prev) => prev.filter((item) => item.id !== target.id));
            window.alert(`已删除用户：${target.username}`);
        } catch (e) {
            showActionError(setError, '删除用户失败', e?.message);
        } finally {
            setBusyUserId('');
        }
    };

    const handleToggleBan = async (target) => {
        const nextBanned = target.status !== 'banned';
        try {
            const res = await fetch(`${cleanApiUrl}/api/admin/users/${target.id}/ban`, {
                method: 'POST',
                headers: { ...authHeaders, 'Content-Type': 'application/json' },
                body: JSON.stringify({ banned: nextBanned }),
            });
            const data = await res.json();
            if (!data.success) throw new Error(data.error || '更新状态失败');
            setUsers((prev) => prev.map((item) => item.id === target.id ? { ...item, status: data.status } : item));
        } catch (e) {
            showActionError(setError, '更新状态失败', e?.message);
        }
    };

    const handleRoleChange = async (target, role) => {
        if (target.role === role) return;
        try {
            const res = await fetch(`${cleanApiUrl}/api/admin/users/${target.id}/role`, {
                method: 'POST',
                headers: { ...authHeaders, 'Content-Type': 'application/json' },
                body: JSON.stringify({ role }),
            });
            const data = await res.json();
            if (!data.success) throw new Error(data.error || '修改角色失败');
            setUsers((prev) => prev.map((item) => item.id === target.id ? { ...item, role: data.role } : item));
        } catch (e) {
            showActionError(setError, '修改角色失败', e?.message);
        }
    };

    const handleGenerateInvite = async () => {
        setLoading(true);
        try {
            const res = await fetch(`${cleanApiUrl}/api/admin/invites`, { headers: authHeaders });
            const data = await res.json();
            if (!data.success) throw new Error(data.error || '生成邀请码失败');
            await fetchInvites();
            window.alert(`已生成邀请码：${data.code}`);
        } catch (e) {
            showActionError(setError, '生成邀请码失败', e?.message);
        } finally {
            setLoading(false);
        }
    };

    const handleRevokeInvite = async (code) => {
        if (!window.confirm('确定要撤销这条邀请码吗？')) return;
        try {
            const res = await fetch(`${cleanApiUrl}/api/admin/invites/${code}`, {
                method: 'DELETE',
                headers: authHeaders,
            });
            const data = await res.json();
            if (!data.success) throw new Error(data.error || '撤销邀请码失败');
            setInviteCodes((prev) => prev.filter((item) => item.code !== code));
        } catch (e) {
            showActionError(setError, '撤销邀请码失败', e?.message);
        }
    };

    const handlePostAnnouncement = async () => {
        if (!announcementMsg.trim()) return;
        setLoading(true);
        try {
            const res = await fetch(`${cleanApiUrl}/api/admin/announcement`, {
                method: 'POST',
                headers: { ...authHeaders, 'Content-Type': 'application/json' },
                body: JSON.stringify({ content: announcementMsg }),
            });
            const data = await res.json();
            if (!data.success) throw new Error(data.error || '发布公告失败');
            setAnnouncementMsg('');
            window.alert('全站公告已发布');
        } catch (e) {
            showActionError(setError, '发布公告失败', e?.message);
        } finally {
            setLoading(false);
        }
    };

    const copyToClipboard = (code) => {
        navigator.clipboard.writeText(code);
        setCopiedCode(code);
        setTimeout(() => setCopiedCode(''), 1500);
    };

    if (!isAdmin) {
        return <div style={{ padding: 40, color: 'var(--danger)' }}>无权访问管理员后台。</div>;
    }

    return (
        <div style={{ padding: '30px', maxWidth: '1150px', margin: '0 auto', overflowY: 'auto', height: '100%' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '30px', color: 'var(--text-primary)' }}>
                <Shield size={32} color="var(--primary)" />
                <h1 style={{ margin: 0 }}>{isRoot ? '根管理员后台' : '管理员后台'}</h1>
            </div>

            {error && <div style={{ padding: 14, marginBottom: 20, borderRadius: 8, background: '#ffebeb', color: 'var(--danger)' }}>{error}</div>}

            <div style={{ ...cardStyle, marginBottom: 30 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
                    <h2 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 8 }}><Database size={20} /> Qdrant Status</h2>
                    <button onClick={fetchQdrantStatus} style={{ background: 'none', border: 'none', cursor: 'pointer' }}><RefreshCw size={18} /></button>
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12 }}>
                    <div>Reachability: {qdrantStatus?.reachable ? 'Online' : 'Offline'}</div>
                    <div>Mode: {qdrantStatus?.mode || '-'}</div>
                    <div>Collections: {qdrantStatus?.collectionsCount ?? '-'}</div>
                    <div>Indexed Points: {Number(qdrantStatus?.indexedPoints || 0).toLocaleString()}</div>
                </div>
            </div>

            <div style={{ ...cardStyle, marginBottom: 30 }}>
                <h2 style={{ marginTop: 0, display: 'flex', alignItems: 'center', gap: 8 }}><Key size={20} /> 邀请码管理</h2>
                <div style={{ display: 'flex', gap: 10, marginBottom: 16 }}>
                    <button onClick={handleGenerateInvite} disabled={loading} style={{ padding: '10px 16px', borderRadius: 8, border: 'none', background: 'var(--primary)', color: '#fff', cursor: 'pointer' }}>生成邀请码</button>
                </div>
                <div style={{ display: 'grid', gap: 10 }}>
                    {inviteCodes.map((invite) => (
                        <div key={invite.code} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: 12, borderRadius: 8, border: '1px solid var(--card-border)' }}>
                            <div>
                                <div style={{ fontWeight: 700 }}>{invite.code}</div>
                                <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>状态：{invite.status || 'active'}</div>
                            </div>
                            <div style={{ display: 'flex', gap: 12 }}>
                                <button onClick={() => copyToClipboard(invite.code)} style={{ background: 'none', border: 'none', cursor: 'pointer' }}>{copiedCode === invite.code ? <Ban size={18} /> : <Copy size={18} />}</button>
                                <button onClick={() => handleRevokeInvite(invite.code)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--danger)' }}><Trash2 size={18} /></button>
                            </div>
                        </div>
                    ))}
                </div>
            </div>

            <div style={{ ...cardStyle, marginBottom: 30 }}>
                <h2 style={{ marginTop: 0, display: 'flex', alignItems: 'center', gap: 8 }}><Send size={20} /> 全站公告</h2>
                <div style={{ display: 'flex', gap: 10 }}>
                    <input value={announcementMsg} onChange={(e) => setAnnouncementMsg(e.target.value)} placeholder="向所有用户发送一条公告..." style={{ flex: 1, padding: 12, borderRadius: 8, border: '1px solid var(--border-color)' }} />
                    <button onClick={handlePostAnnouncement} disabled={loading || !announcementMsg.trim()} style={{ padding: '0 20px', borderRadius: 8, border: 'none', background: 'var(--primary)', color: '#fff', cursor: 'pointer' }}>发布</button>
                </div>
            </div>

            <div style={cardStyle}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
                    <h2 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 8 }}><Users size={20} /> 用户管理</h2>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', borderRadius: 8, border: '1px solid var(--card-border)' }}>
                        <Search size={16} />
                        <input value={userQuery} onChange={(e) => setUserQuery(e.target.value)} placeholder="搜索用户名 / ID / 角色 / 状态" style={{ border: 'none', outline: 'none', background: 'transparent', width: 260 }} />
                    </div>
                </div>

                <div style={{ overflowX: 'auto' }}>
                    <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left' }}>
                        <thead>
                            <tr style={{ borderBottom: '2px solid var(--card-border)' }}>
                                <th style={{ padding: '12px 8px' }}>用户名</th>
                                <th style={{ padding: '12px 8px' }}>角色</th>
                                <th style={{ padding: '12px 8px' }}>状态</th>
                                <th style={{ padding: '12px 8px' }}>最近活跃</th>
                                <th style={{ padding: '12px 8px', textAlign: 'right' }}>操作</th>
                            </tr>
                        </thead>
                        <tbody>
                            {filteredUsers.map((item) => (
                                <tr key={item.id} style={{ borderBottom: '1px solid var(--card-border)' }}>
                                    <td style={{ padding: '12px 8px' }}>
                                        <div style={{ fontWeight: 600 }}>{item.username}</div>
                                        <div style={{ fontSize: 11, color: 'var(--text-muted)', fontFamily: 'monospace' }}>{item.id}</div>
                                    </td>
                                    <td style={{ padding: '12px 8px' }}>
                                        {isRoot && item.role !== 'root' ? (
                                            <select value={item.role || 'user'} onChange={(e) => handleRoleChange(item, e.target.value)}>
                                                <option value="user">普通用户</option>
                                                <option value="admin">管理员</option>
                                            </select>
                                        ) : formatRole(item.role)}
                                    </td>
                                    <td style={{ padding: '12px 8px' }}>
                                        <span style={item.status === 'banned' ? badgeStyle('rgba(239,68,68,0.12)', 'var(--danger)') : badgeStyle('rgba(34,197,94,0.12)', 'var(--success)')}>
                                            {formatStatus(item.status)}
                                        </span>
                                    </td>
                                    <td style={{ padding: '12px 8px', color: 'var(--text-secondary)' }}>{timeAgo(item.last_active_at)}</td>
                                    <td style={{ padding: '12px 8px', textAlign: 'right' }}>
                                        {item.role !== 'root' && (
                                            <div style={{ display: 'inline-flex', gap: 8 }}>
                                                <button onClick={() => handleToggleBan(item)} title="封禁 / 解封" style={actionButtonStyle('rgba(245,158,11,0.12)', '#d97706')}>
                                                    <Ban size={16} />
                                                </button>
                                                <button
                                                    onClick={() => handleDeleteUser(item)}
                                                    title={busyUserId === item.id ? '删除中...' : '删除用户并清空数据'}
                                                    disabled={busyUserId === item.id}
                                                    style={actionButtonStyle('rgba(239,68,68,0.1)', 'var(--danger)', busyUserId === item.id)}
                                                >
                                                    <Trash2 size={16} />
                                                </button>
                                            </div>
                                        )}
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            </div>
        </div>
    );
}
