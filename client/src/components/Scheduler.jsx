import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Plus, Pencil, Trash2, Clock3, Brain } from 'lucide-react';
import { useLanguage } from '../LanguageContext';

const actionOptions = [
    { value: 'chat', en: 'Proactive Chat', zh: '主动私聊' },
    { value: 'moment', en: 'Post Moment', zh: '发布朋友圈' },
    { value: 'diary', en: 'Write Diary', zh: '写日记' },
    { value: 'memory_aggregation', en: 'Daily Memory Aggregation', zh: '每日记忆汇总' }
];

const cardStyle = {
    backgroundColor: '#fff',
    padding: '20px',
    borderRadius: '8px',
    border: '1px solid #eee',
    marginTop: '20px'
};

const buttonBase = {
    border: '1px solid #ddd',
    background: '#fff',
    color: '#333',
    borderRadius: '8px',
    padding: '8px 12px',
    cursor: 'pointer',
    display: 'inline-flex',
    alignItems: 'center',
    gap: '6px',
    fontSize: '13px'
};

function Scheduler({ apiUrl, contacts }) {
    const { lang } = useLanguage();
    const token = localStorage.getItem('cp_token') || '';

    const [tasks, setTasks] = useState([]);
    const [isFormOpen, setIsFormOpen] = useState(false);
    const [editId, setEditId] = useState(null);
    const [formCharId, setFormCharId] = useState('');
    const [formTime, setFormTime] = useState('09:00');
    const [formAction, setFormAction] = useState('chat');
    const [formPrompt, setFormPrompt] = useState('');
    const [formBatchSize, setFormBatchSize] = useState(80);
    const [formEnabled, setFormEnabled] = useState(true);
    const [isSaving, setIsSaving] = useState(false);

    const headers = useMemo(() => ({
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
    }), [token]);

    const resetForm = useCallback(() => {
        setEditId(null);
        setFormCharId(contacts?.[0]?.id || '');
        setFormTime('09:00');
        setFormAction('chat');
        setFormPrompt('');
        setFormBatchSize(80);
        setFormEnabled(true);
    }, [contacts]);

    const fetchTasks = useCallback(async () => {
        const res = await fetch(`${apiUrl}/scheduler/all`, { headers: { Authorization: `Bearer ${token}` } });
        if (!res.ok) {
            throw new Error(`Failed to load scheduler tasks: ${res.status}`);
        }
        const data = await res.json();
        setTasks(Array.isArray(data) ? data : []);
    }, [apiUrl, token]);

    useEffect(() => {
        resetForm();
    }, [resetForm]);

    useEffect(() => {
        if (!token) return;
        fetchTasks().catch((e) => console.error('[Scheduler] load failed:', e));
    }, [fetchTasks, token]);

    const dailyMemoryTasks = useMemo(
        () => tasks.filter((task) => task.action_type === 'memory_aggregation' && Number(task.is_enabled) === 1),
        [tasks]
    );

    const getCharacterName = useCallback((characterId) => {
        return contacts?.find((c) => String(c.id) === String(characterId))?.name || characterId;
    }, [contacts]);

    const getActionLabel = useCallback((actionType) => {
        const found = actionOptions.find((item) => item.value === actionType);
        if (!found) return actionType;
        return lang === 'en' ? found.en : found.zh;
    }, [lang]);

    const openCreate = () => {
        resetForm();
        setIsFormOpen(true);
    };

    const openEdit = (task) => {
        setEditId(task.id);
        setFormCharId(task.character_id);
        setFormTime(task.cron_expr || '09:00');
        setFormAction(task.action_type || 'chat');
        setFormPrompt(task.task_prompt || '');
        setFormBatchSize(Number(task.batch_size) || 80);
        setFormEnabled(Number(task.is_enabled) === 1);
        setIsFormOpen(true);
    };

    const saveTask = async () => {
        if (!formCharId || !formTime || !formAction) {
            alert(lang === 'en' ? 'Character, time, and action are required.' : '角色、时间和动作类型不能为空。');
            return;
        }

        setIsSaving(true);
        try {
            const payload = {
                character_id: formCharId,
                cron_expr: formTime,
                action_type: formAction,
                task_prompt: formPrompt,
                batch_size: formAction === 'memory_aggregation' ? Math.max(10, Math.min(500, Number(formBatchSize) || 80)) : 80,
                is_enabled: formEnabled ? 1 : 0
            };

            const url = editId ? `${apiUrl}/scheduler/${editId}` : `${apiUrl}/scheduler`;
            const method = editId ? 'PUT' : 'POST';
            const res = await fetch(url, { method, headers, body: JSON.stringify(payload) });
            if (!res.ok) {
                throw new Error(`Save failed: ${res.status}`);
            }
            await fetchTasks();
            setIsFormOpen(false);
            resetForm();
        } catch (e) {
            console.error('[Scheduler] save failed:', e);
            alert(lang === 'en' ? 'Failed to save scheduled task.' : '保存定时任务失败。');
        } finally {
            setIsSaving(false);
        }
    };

    const deleteTask = async (id) => {
        const confirmed = window.confirm(lang === 'en' ? 'Delete this scheduled task?' : '确定删除这条定时任务吗？');
        if (!confirmed) return;
        try {
            const res = await fetch(`${apiUrl}/scheduler/${id}`, {
                method: 'DELETE',
                headers: { Authorization: `Bearer ${token}` }
            });
            if (!res.ok) {
                throw new Error(`Delete failed: ${res.status}`);
            }
            await fetchTasks();
        } catch (e) {
            console.error('[Scheduler] delete failed:', e);
            alert(lang === 'en' ? 'Failed to delete scheduled task.' : '删除定时任务失败。');
        }
    };

    const toggleTask = async (task) => {
        try {
            const res = await fetch(`${apiUrl}/scheduler/${task.id}`, {
                method: 'PUT',
                headers,
                body: JSON.stringify({
                    character_id: task.character_id,
                    cron_expr: task.cron_expr,
                    action_type: task.action_type,
                    task_prompt: task.task_prompt || '',
                    batch_size: Number(task.batch_size) || 80,
                    is_enabled: Number(task.is_enabled) === 1 ? 0 : 1
                })
            });
            if (!res.ok) {
                throw new Error(`Toggle failed: ${res.status}`);
            }
            await fetchTasks();
        } catch (e) {
            console.error('[Scheduler] toggle failed:', e);
            alert(lang === 'en' ? 'Failed to update scheduled task.' : '更新定时任务失败。');
        }
    };

    return (
        <div style={cardStyle}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '12px', marginBottom: '16px' }}>
                <div>
                    <h2 style={{ margin: 0, fontSize: '18px' }}>
                        {lang === 'en' ? 'Scheduled Tasks' : '定时任务'}
                    </h2>
                    <div style={{ marginTop: '6px', fontSize: '12px', color: '#666' }}>
                        {lang === 'en'
                            ? 'Create per-character timed actions. Daily memory aggregation is retained here. Overflow sweep is no longer shown as a separate card.'
                            : '为每个角色创建定时动作。每日记忆汇总仍在这里展示，重复的长时记忆清扫卡片已移除。'}
                    </div>
                </div>
                <button type="button" style={{ ...buttonBase, background: 'var(--accent-color)', color: '#fff', borderColor: 'var(--accent-color)' }} onClick={openCreate}>
                    <Plus size={16} />
                    {lang === 'en' ? 'New Task' : '新建任务'}
                </button>
            </div>

            <div style={{ ...cardStyle, marginTop: 0, background: '#fafcff', borderColor: '#dbe7ff' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '10px' }}>
                    <Brain size={16} color="#4f7cff" />
                    <strong>{lang === 'en' ? 'Daily Memory Aggregation' : '每日记忆汇总'}</strong>
                </div>
                {dailyMemoryTasks.length === 0 ? (
                    <div style={{ fontSize: '13px', color: '#666' }}>
                        {lang === 'en'
                            ? 'No enabled daily memory aggregation tasks.'
                            : '当前没有启用中的每日记忆汇总任务。'}
                    </div>
                ) : (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                        {dailyMemoryTasks.map((task) => (
                            <div key={task.id} style={{ display: 'flex', justifyContent: 'space-between', gap: '12px', fontSize: '13px' }}>
                                <span>{getCharacterName(task.character_id)}</span>
                                <span style={{ color: '#4f7cff', fontWeight: 600 }}>
                                    {task.cron_expr}
                                    <span style={{ color: '#666', fontWeight: 400, marginLeft: '8px' }}>
                                        {lang === 'en' ? `Batch ${Number(task.batch_size) || 80}` : `每批 ${Number(task.batch_size) || 80} 条`}
                                    </span>
                                </span>
                            </div>
                        ))}
                    </div>
                )}
            </div>

            {isFormOpen && (
                <div style={{ marginTop: '16px', padding: '16px', border: '1px solid #eee', borderRadius: '8px', background: '#fafafa' }}>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: '12px' }}>
                        <label style={{ display: 'flex', flexDirection: 'column', gap: '6px', fontSize: '13px' }}>
                            <span>{lang === 'en' ? 'Character' : '角色'}</span>
                            <select value={formCharId} onChange={(e) => setFormCharId(e.target.value)} style={{ padding: '10px', borderRadius: '8px', border: '1px solid #ddd' }}>
                                {contacts?.map((contact) => (
                                    <option key={contact.id} value={contact.id}>{contact.name}</option>
                                ))}
                            </select>
                        </label>
                        <label style={{ display: 'flex', flexDirection: 'column', gap: '6px', fontSize: '13px' }}>
                            <span>{lang === 'en' ? 'Time (HH:MM)' : '时间（HH:MM）'}</span>
                            <input type="time" value={formTime} onChange={(e) => setFormTime(e.target.value)} style={{ padding: '10px', borderRadius: '8px', border: '1px solid #ddd' }} />
                        </label>
                        <label style={{ display: 'flex', flexDirection: 'column', gap: '6px', fontSize: '13px' }}>
                            <span>{lang === 'en' ? 'Action Type' : '动作类型'}</span>
                            <select value={formAction} onChange={(e) => setFormAction(e.target.value)} style={{ padding: '10px', borderRadius: '8px', border: '1px solid #ddd' }}>
                                {actionOptions.map((option) => (
                                    <option key={option.value} value={option.value}>
                                        {lang === 'en' ? option.en : option.zh}
                                    </option>
                                ))}
                            </select>
                        </label>
                        <label style={{ display: 'flex', flexDirection: 'column', gap: '6px', fontSize: '13px', justifyContent: 'center' }}>
                            <span>{lang === 'en' ? 'Enabled' : '启用'}</span>
                            <input type="checkbox" checked={formEnabled} onChange={(e) => setFormEnabled(e.target.checked)} />
                        </label>
                    </div>

                    <label style={{ display: 'flex', flexDirection: 'column', gap: '6px', fontSize: '13px', marginTop: '12px' }}>
                        <span>{lang === 'en' ? 'Prompt / Notes' : '提示词 / 备注'}</span>
                        <textarea
                            value={formPrompt}
                            onChange={(e) => setFormPrompt(e.target.value)}
                            rows={4}
                            placeholder={lang === 'en' ? 'Optional instruction for the scheduled task.' : '可选的任务补充说明。'}
                            style={{ padding: '10px', borderRadius: '8px', border: '1px solid #ddd', resize: 'vertical' }}
                        />
                    </label>

                    {formAction === 'memory_aggregation' && (
                        <label style={{ display: 'flex', flexDirection: 'column', gap: '6px', fontSize: '13px', marginTop: '12px' }}>
                            <span>{lang === 'en' ? 'Items per batch' : '每批读取条数'}</span>
                            <input
                                type="number"
                                min={10}
                                max={500}
                                step={10}
                                value={formBatchSize}
                                onChange={(e) => setFormBatchSize(e.target.value)}
                                style={{ padding: '10px', borderRadius: '8px', border: '1px solid #ddd' }}
                            />
                            <span style={{ fontSize: '12px', color: '#666' }}>
                                {lang === 'en'
                                    ? 'The memory model reads this many activity items per API call, then continues batch by batch until the day is fully processed.'
                                    : '记忆小模型每次只读取这么多条活动，再分批调用 API，一直整理到当天内容读完为止。'}
                            </span>
                        </label>
                    )}

                    <div style={{ display: 'flex', gap: '10px', marginTop: '14px' }}>
                        <button type="button" style={{ ...buttonBase, background: 'var(--accent-color)', color: '#fff', borderColor: 'var(--accent-color)' }} onClick={saveTask} disabled={isSaving}>
                            {lang === 'en' ? (isSaving ? 'Saving...' : 'Save Task') : (isSaving ? '保存中...' : '保存任务')}
                        </button>
                        <button type="button" style={buttonBase} onClick={() => { setIsFormOpen(false); resetForm(); }}>
                            {lang === 'en' ? 'Cancel' : '取消'}
                        </button>
                    </div>
                </div>
            )}

            <div style={{ marginTop: '18px', display: 'flex', flexDirection: 'column', gap: '10px' }}>
                {tasks.length === 0 ? (
                    <div style={{ fontSize: '13px', color: '#666' }}>
                        {lang === 'en' ? 'No scheduled tasks yet.' : '还没有定时任务。'}
                    </div>
                ) : (
                    tasks.map((task) => (
                        <div key={task.id} style={{ border: '1px solid #eee', borderRadius: '8px', padding: '14px' }}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', gap: '12px', alignItems: 'flex-start' }}>
                                <div style={{ minWidth: 0 }}>
                                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                                        <strong>{getCharacterName(task.character_id)}</strong>
                                        <span style={{ fontSize: '12px', color: '#4f7cff', display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
                                            <Clock3 size={12} />
                                            {task.cron_expr}
                                        </span>
                                        <span style={{ fontSize: '12px', color: '#666' }}>{getActionLabel(task.action_type)}</span>
                                        <span style={{ fontSize: '12px', color: Number(task.is_enabled) === 1 ? '#19a35b' : '#999' }}>
                                            {Number(task.is_enabled) === 1
                                                ? (lang === 'en' ? 'Enabled' : '已启用')
                                                : (lang === 'en' ? 'Disabled' : '已停用')}
                                        </span>
                                    </div>
                                    {task.task_prompt ? (
                                        <div style={{ marginTop: '8px', fontSize: '13px', color: '#555', whiteSpace: 'pre-wrap' }}>
                                            {task.task_prompt}
                                        </div>
                                    ) : null}
                                    {task.action_type === 'memory_aggregation' ? (
                                        <div style={{ marginTop: '8px', fontSize: '12px', color: '#666' }}>
                                            {lang === 'en' ? `Items per batch: ${Number(task.batch_size) || 80}` : `每批读取条数：${Number(task.batch_size) || 80}`}
                                        </div>
                                    ) : null}
                                </div>
                                <div style={{ display: 'flex', gap: '8px', flexShrink: 0 }}>
                                    <button type="button" style={buttonBase} onClick={() => toggleTask(task)}>
                                        {Number(task.is_enabled) === 1
                                            ? (lang === 'en' ? 'Disable' : '停用')
                                            : (lang === 'en' ? 'Enable' : '启用')}
                                    </button>
                                    <button type="button" style={buttonBase} onClick={() => openEdit(task)}>
                                        <Pencil size={14} />
                                    </button>
                                    <button type="button" style={{ ...buttonBase, color: '#c53030', borderColor: '#f3c2c2' }} onClick={() => deleteTask(task.id)}>
                                        <Trash2 size={14} />
                                    </button>
                                </div>
                            </div>
                        </div>
                    ))
                )}
            </div>
        </div>
    );
}

export default Scheduler;
