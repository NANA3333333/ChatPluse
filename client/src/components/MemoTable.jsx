import React, { useState, useEffect } from 'react';
import { Trash2, RefreshCw, Wand2, Download, Upload, X } from 'lucide-react';
import { useLanguage } from '../LanguageContext';

function buildAuthHeaders() {
    return {
        'Authorization': `Bearer ${localStorage.getItem('cp_token') || ''}`
    };
}

function MemoTable({ contact, apiUrl, onClose }) {
    const { t, lang } = useLanguage();
    const [memories, setMemories] = useState([]);
    const [loading, setLoading] = useState(false);
    const [isExtracting, setIsExtracting] = useState(false);
    const [isImporting, setIsImporting] = useState(false);
    const [isExporting, setIsExporting] = useState(false);
    const importFileInputRef = React.useRef(null);

    const fetchMemories = React.useCallback(() => {
        if (!contact) return;
        setLoading(true);
        fetch(`${apiUrl}/memories/${contact.id}`, { headers: buildAuthHeaders() })
            .then(res => res.json())
            .then(data => {
                if (!Array.isArray(data)) {
                    console.error('API Error:', data);
                    data = [];
                }
                setMemories(data.filter(mem => Number(mem?.is_archived || 0) === 0));
                setLoading(false);
            })
            .catch(err => {
                console.error('Failed to load memories:', err);
                setLoading(false);
            });
    }, [contact, apiUrl]);

    useEffect(() => {
        fetchMemories();

        const handleMemoryUpdate = (event) => {
            if (contact && event.detail.characterId === contact.id) {
                fetchMemories();
            }
        };

        const handleCharacterDataWiped = (event) => {
            if (contact && event.detail?.characterId === contact.id) {
                setMemories([]);
                setLoading(false);
            }
        };

        window.addEventListener('memory_update', handleMemoryUpdate);
        window.addEventListener('character_data_wiped', handleCharacterDataWiped);

        return () => {
            window.removeEventListener('memory_update', handleMemoryUpdate);
            window.removeEventListener('character_data_wiped', handleCharacterDataWiped);
        };
    }, [contact, fetchMemories]);

    const handleDelete = async (id) => {
        try {
            const res = await fetch(`${apiUrl}/memories/${id}`, { method: 'DELETE', headers: buildAuthHeaders() });
            const data = await res.json().catch(() => ({}));
            if (!res.ok || !data?.success) {
                alert(lang === 'en' ? `Delete failed:\n${data?.error || 'Unknown error'}` : `删除失败:\n${data?.error || '未知错误'}`);
                return;
            }
            setMemories(prev => prev.filter(m => m.id !== id));
            fetchMemories();
        } catch (e) {
            console.error('Failed to delete memory:', e);
            alert(lang === 'en' ? 'Failed to connect to the server while deleting memory.' : '删除记忆时无法连接服务器。');
        }
    };

    const handleExtract = async () => {
        if (!contact) return;
        setIsExtracting(true);
        try {
            const res = await fetch(`${apiUrl}/memories/${contact.id}/extract`, { method: 'POST', headers: buildAuthHeaders() });
            const data = await res.json();

            if (!res.ok) {
                alert(lang === 'en' ? `Extraction Failed:\n${data.error}` : `提取失败:\n${data.error}`);
            } else {
                alert(lang === 'en' ? `Extraction Complete:\n${data.message}` : `提取完成:\n${data.message}`);
                fetchMemories(); // Refresh the list if successful
            }
        } catch (e) {
            console.error('Failed to extract memories:', e);
            alert(lang === 'en' ? 'Failed to connect to the server for memory extraction.' : '无法连接服务器进行记忆提取。');
        } finally {
            setIsExtracting(false);
        }
    };

    const handleImportCharacterArchive = async (event) => {
        if (!contact) return;
        const file = event.target.files?.[0];
        event.target.value = '';
        if (!file) return;
        if (!window.confirm(lang === 'en'
            ? `Import this character archive into ${contact.name}?\n\nThis will replace chats, memories, moments, moment interactions, and diaries, then rebuild the Qdrant memory index.`
            : `确定把这个角色包导入到 ${contact.name} 吗？\n\n这会覆盖当前角色的聊天记录、记忆、朋友圈及互动、日记，并重建 Qdrant 记忆索引。`)) return;

        setIsImporting(true);
        try {
            const formData = new FormData();
            formData.append('file', file);
            formData.append('mode', 'replace');
            const res = await fetch(`${apiUrl}/data/${contact.id}/import?mode=replace`, {
                method: 'POST',
                headers: buildAuthHeaders(),
                body: formData
            });
            const data = await res.json().catch(() => ({}));

            if (!res.ok || !data?.success) {
                const detail = data?.error || data?.errors?.[0]?.error || 'Unknown error';
                alert(lang === 'en' ? `Import failed:\n${detail}` : `导入失败:\n${detail}`);
                return;
            }

            const counts = data.imported || {};
            const indexNote = data.rebuiltMemoryIndex
                ? ''
                : (lang === 'en' ? '\nMemory index rebuild needs attention.' : '\n记忆索引重建需要检查。');
            alert(lang === 'en'
                ? `Import complete. Messages: ${counts.messages || 0}, memories: ${counts.memories || 0}, moments: ${counts.moments || 0}, diaries: ${counts.diaries || 0}.${indexNote}`
                : `导入完成。聊天 ${counts.messages || 0} 条，记忆 ${counts.memories || 0} 条，朋友圈 ${counts.moments || 0} 条，日记 ${counts.diaries || 0} 条。${indexNote}`);
            window.dispatchEvent(new Event('refresh_contacts'));
            window.location.reload();
        } catch (e) {
            console.error('Failed to import character archive:', e);
            alert(lang === 'en' ? 'Failed to connect to the server while importing the character archive.' : '导入角色包时无法连接服务器。');
        } finally {
            setIsImporting(false);
        }
    };

    const handleExportCharacterArchive = async () => {
        if (!contact) return;
        setIsExporting(true);
        try {
            const res = await fetch(`${apiUrl}/data/${contact.id}/export`, {
                headers: buildAuthHeaders()
            });
            if (!res.ok) {
                const data = await res.json().catch(() => ({}));
                alert(lang === 'en' ? `Export failed:\n${data?.error || res.statusText}` : `导出失败:\n${data?.error || res.statusText}`);
                return;
            }
            const blob = await res.blob();
            const disposition = res.headers.get('Content-Disposition') || '';
            const match = disposition.match(/filename="?([^";]+)"?/i);
            const fallbackName = `${contact.name || contact.id}_${contact.id}_character_export.json`;
            const filename = match?.[1] || fallbackName;
            const url = URL.createObjectURL(blob);
            const link = document.createElement('a');
            link.href = url;
            link.download = filename;
            document.body.appendChild(link);
            link.click();
            link.remove();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
        } catch (e) {
            console.error('Failed to export character archive:', e);
            alert(lang === 'en' ? 'Failed to export character archive.' : '导出角色包失败。');
        } finally {
            setIsExporting(false);
        }
    };

    if (!contact) return null;

    const isBusy = isExporting || isImporting || isExtracting;

    return (
        <div className="drawer-container memory-drawer memory-table-drawer">
            <div className="memory-header">
                <h3>{contact.name} {lang === 'en' ? "'s Memories" : '的记忆'}</h3>
                <div className="memory-header-actions">
                    <button
                        className="memory-action-btn"
                        onClick={handleExportCharacterArchive}
                        disabled={isBusy}
                        title={lang === 'en' ? 'Export chats, memories, moments, diaries, and rebuildable Qdrant memory index data' : '导出聊天、记忆、朋友圈、日记，以及可重建 Qdrant 索引的记忆数据'}
                    >
                        <Download size={14} /> {isExporting ? (lang === 'en' ? 'Exporting...' : '导出中...') : (lang === 'en' ? 'Export all' : '导出全部')}
                    </button>
                    <button
                        className="memory-action-btn"
                        onClick={() => importFileInputRef.current?.click()}
                        disabled={isBusy}
                        title={lang === 'en' ? 'Import a full character archive JSON and replace current data' : '导入完整角色包 JSON，并覆盖当前数据'}
                    >
                        <Upload size={14} /> {isImporting ? (lang === 'en' ? 'Importing...' : '导入中...') : (lang === 'en' ? 'Import all' : '导入全部')}
                    </button>
                    <input
                        ref={importFileInputRef}
                        type="file"
                        accept=".json,application/json"
                        style={{ display: 'none' }}
                        onChange={handleImportCharacterArchive}
                    />
                    <button
                        className="memory-action-btn"
                        onClick={handleExtract}
                        disabled={isBusy}
                    >
                        <Wand2 size={14} /> {isExtracting ? (lang === 'en' ? 'Extracting...' : '提取中...') : (lang === 'en' ? 'Extract' : '提取')}
                    </button>
                    <button className="icon-btn" onClick={fetchMemories} title={lang === 'en' ? "Refresh" : '刷新'}>
                        <RefreshCw size={16} />
                    </button>
                    <button className="icon-btn" onClick={onClose} title={t('Cancel')}>
                        <X size={16} />
                    </button>
                </div>
            </div>

            <div className="memory-content">
                {loading || isExtracting || isImporting ? (
                    <p className="loading-text">
                        {isImporting
                            ? (lang === 'en' ? 'Importing character archive...' : '导入角色包中...')
                            : isExtracting
                            ? (lang === 'en' ? 'Analyzing recent context...' : '分析最近的上下文...')
                            : (lang === 'en' ? 'Loading memories...' : '加载记忆中...')}
                    </p>
                ) : memories.length === 0 ? (
                    <div style={{ padding: '20px', textAlign: 'center', color: '#888' }}>
                        <p>{t('No memories yet')}</p>
                        <p style={{ fontSize: '12px', marginTop: '10px' }}>
                            {lang === 'en'
                                ? 'The AI usually extracts them in the background, but you can force an extraction now.'
                                : 'AI 通常会在后台提取记忆，但你也可以点击上方按钮立即强制提取。'}
                        </p>
                    </div>
                ) : (
                    <div className="memory-list">
                        {memories.map(mem => (
                            <div key={mem.id} className="memory-card">
                                <div className="memory-card-header">
                                    <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                                        <span className="memory-time">{new Date(mem.created_at).toLocaleString()}</span>
                                        {(mem.last_retrieved_at || mem.retrieval_count > 0) && (
                                            <span style={{ fontSize: '10px', color: 'var(--accent-color)', fontWeight: 600 }}>
                                                {lang === 'en'
                                                    ? `Recently used ${mem.retrieval_count || 0} times`
                                                    : `最近被调用 ${mem.retrieval_count || 0} 次`}
                                                {mem.last_retrieved_at
                                                    ? ` · ${lang === 'en' ? 'Last used' : '最后调用'} ${new Date(mem.last_retrieved_at).toLocaleString()}`
                                                    : ''}
                                            </span>
                                        )}
                                    </div>
                                    <button className="icon-btn danger" onClick={() => handleDelete(mem.id)}>
                                        <Trash2 size={14} />
                                    </button>
                                </div>
                                <div className="memory-card-body">
                                    <div style={{ fontWeight: 700, color: 'var(--accent-color)', lineHeight: 1.5 }}>
                                        {mem.summary || mem.event || mem.content}
                                    </div>
                                    {mem.event && mem.summary !== mem.event && (
                                        <div style={{ marginTop: '8px', fontSize: '12px', color: '#888', lineHeight: 1.5 }}>
                                            <strong>{lang === 'en' ? 'Internal tag' : '内部标签'}:</strong> {mem.event}
                                        </div>
                                    )}
                                    {mem.content && mem.content !== mem.summary && (
                                        <div style={{ marginTop: '8px', fontSize: '12px', color: '#666', lineHeight: 1.6 }}>
                                            {mem.content}
                                        </div>
                                    )}
                                </div>
                                {(mem.time || mem.location || mem.people || mem.source_time_text) && (
                                    <div className="memory-card-footer">
                                        {mem.source_time_text && <span>🕒 {mem.source_time_text}</span>}
                                        {mem.time && <span>🕒 {mem.time}</span>}
                                        {mem.location && <span>📍 {mem.location}</span>}
                                        {mem.people && <span>👥 {mem.people}</span>}
                                    </div>
                                )}
                            </div>
                        ))}
                    </div>
                )}
            </div>
        </div>
    );
}

export default MemoTable;

