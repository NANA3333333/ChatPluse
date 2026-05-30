import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { CheckCircle2, Clock3, Database, ExternalLink, KeyRound, Play, RefreshCw, Save, Search, Trash2, Wifi } from 'lucide-react';

const panel = {
  height: '100%',
  background: '#f7f9fc',
  color: '#1f2937',
  display: 'flex',
  flexDirection: 'column',
  overflow: 'hidden'
};

const toolbar = {
  display: 'flex',
  alignItems: 'center',
  gap: '8px',
  padding: '12px 16px',
  borderBottom: '1px solid #d8e0ea',
  background: '#fff'
};

const iconButton = {
  width: '34px',
  height: '34px',
  border: '1px solid #cbd5e1',
  borderRadius: '6px',
  background: '#fff',
  color: '#475569',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  cursor: 'pointer'
};

const primaryButton = {
  ...iconButton,
  width: 'auto',
  padding: '0 12px',
  gap: '6px',
  background: '#2563eb',
  borderColor: '#2563eb',
  color: '#fff',
  fontWeight: 600
};

const inputStyle = {
  height: '34px',
  border: '1px solid #cbd5e1',
  borderRadius: '6px',
  padding: '0 10px',
  fontSize: '13px',
  outline: 'none',
  background: '#fff',
  minWidth: 0
};

const textAreaStyle = {
  ...inputStyle,
  height: '96px',
  resize: 'vertical',
  padding: '8px 10px',
  lineHeight: 1.45
};

const sectionStyle = {
  background: '#fff',
  border: '1px solid #d8e0ea',
  borderRadius: '8px',
  padding: '12px'
};

const badgeStyle = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: '4px',
  height: '22px',
  padding: '0 8px',
  borderRadius: '999px',
  border: '1px solid #dbe4ef',
  background: '#f8fafc',
  color: '#475569',
  fontSize: '11px',
  whiteSpace: 'nowrap'
};

function getHeaders() {
  const token = localStorage.getItem('cp_token') || '';
  return {
    'Content-Type': 'application/json',
    Authorization: token ? `Bearer ${token}` : ''
  };
}

function endpoint(apiUrl, path) {
  return `${String(apiUrl || '/api').replace(/\/$/, '')}${path}`;
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.success === false) throw new Error(data.error || `请求失败 ${response.status}`);
  return data;
}

function formatTime(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString([], { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function providerLabel(providerId, providers = []) {
  if (providerId === 'duckduckgo' || providerId === 'duckduckgo_instant_answer') return 'DuckDuckGo';
  return providers.find(item => item.id === providerId)?.label || providerId || 'Auto';
}

function normalizeProviderId(source) {
  if (!source) return '';
  if (source === 'duckduckgo_instant_answer') return 'duckduckgo';
  if (source.startsWith('serper')) return 'serper';
  if (source.startsWith('tavily')) return 'tavily';
  if (source.startsWith('brave')) return 'brave';
  if (source.startsWith('bing')) return 'bing';
  return source;
}

function taskKindLabel(kind) {
  if (kind === 'private_web_search') return '私聊联网';
  if (kind === 'city_web_search') return '商业街联网';
  if (kind === 'web_search') return '手动查询';
  if (kind === 'fetch_url') return '网页抓取';
  return kind || '任务';
}

function formatRawJson(value) {
  if (!value) return '';
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

const rawBlockStyle = {
  marginTop: '6px',
  padding: '8px',
  border: '1px solid #dbe4ef',
  borderRadius: '6px',
  background: '#fff',
  color: '#334155',
  fontSize: '11px',
  lineHeight: 1.45,
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
  maxHeight: '320px',
  overflow: 'auto'
};

function TaskRecord({ task, selected, providers, onSelect, onRerun, onDelete }) {
  const source = task.output?.source || task.input?.provider || '';
  const statusColor = task.status === 'done' ? '#16a34a' : task.status === 'error' ? '#dc2626' : '#64748b';
  const outputResults = Array.isArray(task.output?.results) ? task.output.results : [];
  const outputText = task.output?.text || task.output?.url || '';
  return (
    <div
      style={{
        border: selected ? '1px solid #2563eb' : '1px solid #e2e8f0',
        borderRadius: '7px',
        padding: '8px',
        background: selected ? '#eff6ff' : '#fff'
      }}
    >
      <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
        <button
          style={{ ...iconButton, width: '28px', height: '28px', flexShrink: 0 }}
          onClick={() => onSelect(task)}
          title="查看任务输出"
        >
          {task.status === 'done' ? <CheckCircle2 size={14} /> : <Clock3 size={14} />}
        </button>
        <div style={{ flex: 1, minWidth: 0, cursor: 'pointer' }} onClick={() => onSelect(task)}>
          <div style={{ fontWeight: 700, fontSize: '12px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{task.title}</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', marginTop: '4px', alignItems: 'center' }}>
            <span style={{ ...badgeStyle, color: statusColor }}>{taskKindLabel(task.kind)} / {task.status}</span>
            {source && <span style={badgeStyle}>{providerLabel(normalizeProviderId(String(source)), providers)}</span>}
            <span style={badgeStyle}>{formatTime(task.finished_at || task.created_at)}</span>
          </div>
        </div>
        <button style={{ ...iconButton, width: '28px', height: '28px' }} onClick={() => onRerun(task)} title="重新执行"><Play size={14} /></button>
        <button style={{ ...iconButton, width: '28px', height: '28px' }} onClick={() => onDelete(task)} title="删除"><Trash2 size={14} /></button>
      </div>
      {task.error && <div style={{ color: '#dc2626', fontSize: '11px', marginTop: '6px' }}>{task.error}</div>}
      {selected && (outputResults.length > 0 || outputText) && (
        <div style={{ marginTop: '8px', paddingTop: '8px', borderTop: '1px solid #dbe4ef', display: 'grid', gap: '6px' }}>
          {outputResults.map((item, index) => (
            <div key={`${item.url || item.title}-${index}`} style={{ display: 'grid', gap: '2px' }}>
              <div style={{ fontSize: '12px', fontWeight: 700, color: '#334155', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.title || item.url || 'Result'}</div>
              {item.snippet && <div style={{ fontSize: '11px', color: '#64748b', lineHeight: 1.45 }}>{item.snippet}</div>}
              {item.url && <a href={item.url} target="_blank" rel="noreferrer" style={{ color: '#2563eb', fontSize: '11px', textDecoration: 'none' }}>打开来源</a>}
              {item.page_text && (
                <details style={{ marginTop: '4px' }}>
                  <summary style={{ cursor: 'pointer', color: '#2563eb', fontSize: '11px' }}>查看抓取正文</summary>
                  <pre style={rawBlockStyle}>{item.page_text}</pre>
                </details>
              )}
              {item.page_error && <div style={{ color: '#b91c1c', fontSize: '11px' }}>正文抓取失败：{item.page_error}</div>}
              {item.raw && (
                <details style={{ marginTop: '4px' }}>
                  <summary style={{ cursor: 'pointer', color: '#2563eb', fontSize: '11px' }}>查看 API 原始返回</summary>
                  <pre style={rawBlockStyle}>{formatRawJson(item.raw)}</pre>
                </details>
              )}
            </div>
          ))}
          {task.output?.raw_response && (
            <details>
              <summary style={{ cursor: 'pointer', color: '#2563eb', fontSize: '11px' }}>查看本次查询完整响应</summary>
              <pre style={rawBlockStyle}>{formatRawJson(task.output.raw_response)}</pre>
            </details>
          )}
          {!outputResults.length && outputText && (
            <div style={{ fontSize: '11px', color: '#64748b', lineHeight: 1.45, display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
              {outputText}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function SearchResultList({ result }) {
  const results = Array.isArray(result?.results) ? result.results : [];
  if (!result || results.length === 0) return null;
  return (
    <div style={{ marginTop: '10px', borderTop: '1px solid #e2e8f0', paddingTop: '10px', display: 'grid', gap: '8px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: '8px', alignItems: 'center' }}>
        <div style={{ fontWeight: 700, fontSize: '12px' }}>本次查询结果</div>
        <span style={badgeStyle}>{result.source || 'web'} / {results.length}</span>
      </div>
      <div style={{ display: 'grid', gap: '7px' }}>
        {results.map((item, index) => (
          <div key={`${item.url || item.title}-${index}`} style={{ border: '1px solid #e2e8f0', borderRadius: '7px', padding: '8px', background: '#f8fafc' }}>
            <div style={{ display: 'flex', gap: '8px', alignItems: 'flex-start' }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: '12px', fontWeight: 700, color: '#1e293b', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {item.title || item.url || `结果 ${index + 1}`}
                </div>
                {item.snippet && (
                  <div style={{ marginTop: '3px', color: '#64748b', fontSize: '11px', lineHeight: 1.5 }}>
                    {item.snippet}
                  </div>
                )}
                {item.raw && (
                  <details style={{ marginTop: '6px' }}>
                    <summary style={{ cursor: 'pointer', color: '#2563eb', fontSize: '11px' }}>展开 API 返回字段</summary>
                    <pre style={rawBlockStyle}>{formatRawJson(item.raw)}</pre>
                  </details>
                )}
                {item.page_text && (
                  <details style={{ marginTop: '6px' }}>
                    <summary style={{ cursor: 'pointer', color: '#2563eb', fontSize: '11px' }}>展开抓取正文</summary>
                    <pre style={rawBlockStyle}>{item.page_text}</pre>
                  </details>
                )}
                {item.page_error && <div style={{ color: '#b91c1c', fontSize: '11px', marginTop: '4px' }}>正文抓取失败：{item.page_error}</div>}
              </div>
              {item.url && (
                <a
                  href={item.url}
                  target="_blank"
                  rel="noreferrer"
                  style={{ ...iconButton, width: '28px', height: '28px', textDecoration: 'none', flexShrink: 0 }}
                  title="打开来源"
                >
                  <ExternalLink size={13} />
                </a>
              )}
            </div>
          </div>
        ))}
      </div>
      {result.raw_response && (
        <details>
          <summary style={{ cursor: 'pointer', color: '#2563eb', fontSize: '11px' }}>查看本次查询完整响应</summary>
          <pre style={rawBlockStyle}>{formatRawJson(result.raw_response)}</pre>
        </details>
      )}
    </div>
  );
}

export default function McpLabPanel({ apiUrl }) {
  const headers = useMemo(() => getHeaders(), []);
  const [status, setStatus] = useState(null);
  const [webConfig, setWebConfig] = useState(null);
  const [webKeys, setWebKeys] = useState({});
  const [clearKeyIds, setClearKeyIds] = useState([]);
  const [selectedProvider, setSelectedProvider] = useState('auto');
  const [characters, setCharacters] = useState([]);
  const [characterId, setCharacterId] = useState('');
  const [query, setQuery] = useState('');
  const [url, setUrl] = useState('');
  const [notice, setNotice] = useState('');
  const [searchResult, setSearchResult] = useState(null);
  const [tasks, setTasks] = useState([]);
  const [selectedTaskId, setSelectedTaskId] = useState('');
  const [, setDocs] = useState([]);
  const [noteTitle, setNoteTitle] = useState('');
  const [noteUrl, setNoteUrl] = useState('');
  const [noteContent, setNoteContent] = useState('');
  const [knowledgeQuery, setKnowledgeQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setError('');
    try {
      const [statusData, taskData, characterData, docData] = await Promise.all([
        requestJson(endpoint(apiUrl, '/mcp-lab/status'), { headers }),
        requestJson(endpoint(apiUrl, '/mcp-lab/tasks'), { headers }),
        requestJson(endpoint(apiUrl, '/characters'), { headers }),
        requestJson(endpoint(apiUrl, '/mcp-lab/knowledge'), { headers })
      ]);
      setStatus(statusData);
      try {
        const configData = await requestJson(endpoint(apiUrl, '/mcp-lab/web-config'), { headers });
        setWebConfig(configData);
        setSelectedProvider(configData.preferred_provider || 'auto');
      } catch {
        setWebConfig(null);
      }
      setTasks(taskData.tasks || []);
      setSelectedTaskId((current) => current || taskData.tasks?.[0]?.id || '');
      const nextCharacters = Array.isArray(characterData) ? characterData : [];
      setCharacters(nextCharacters);
      setCharacterId((current) => current || nextCharacters[0]?.id || '');
      setDocs(docData.docs || []);
    } catch (e) {
      setError(e.message);
    }
  }, [apiUrl, headers]);

  useEffect(() => {
    load();
  }, [load]);

  async function runSearch() {
    if (!query.trim()) return;
    setBusy(true);
    setError('');
    try {
      if (Object.values(webKeys).some(value => String(value || '').trim()) || clearKeyIds.length > 0) {
        await saveWebConfig({ quiet: true });
      }
      const data = await requestJson(endpoint(apiUrl, '/mcp-lab/search'), {
        method: 'POST',
        headers,
        body: JSON.stringify({ query, provider: selectedProvider })
      });
      const count = Array.isArray(data.result?.results) ? data.result.results.length : 0;
      setSearchResult(data.result || null);
      if (data.task) {
        setTasks(current => [data.task, ...current.filter(task => task.id !== data.task.id)].slice(0, 80));
        setSelectedTaskId(data.task.id);
      }
      setNotice(`查询完成：${providerLabel(data.result?.source || selectedProvider, providers)} 返回 ${count} 条结果`);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function saveWebConfig(options = {}) {
    const quiet = !!options.quiet;
    if (!quiet) setBusy(true);
    setError('');
    try {
      const data = await requestJson(endpoint(apiUrl, '/mcp-lab/web-config'), {
        method: 'PUT',
        headers,
        body: JSON.stringify({
          preferred_provider: selectedProvider,
          keys: webKeys,
          clear_ids: clearKeyIds
        })
      });
      setWebConfig(data);
      setWebKeys({});
      setClearKeyIds([]);
      const statusData = await requestJson(endpoint(apiUrl, '/mcp-lab/status'), { headers });
      setStatus(statusData);
      if (!quiet) setNotice(`联网 Key 和搜索源已保存，当前已保存 ${data.saved_key_count || 0} 个 Key`);
      return data;
    } catch (e) {
      setError(e.message);
      throw e;
    } finally {
      if (!quiet) setBusy(false);
    }
  }

  async function fetchUrl() {
    if (!url.trim()) return;
    setBusy(true);
    setError('');
    try {
      const data = await requestJson(endpoint(apiUrl, '/mcp-lab/fetch'), {
        method: 'POST',
        headers,
        body: JSON.stringify({ url })
      });
      if (data.task) {
        setTasks(current => [data.task, ...current.filter(task => task.id !== data.task.id)].slice(0, 80));
        setSelectedTaskId(data.task.id);
      }
      setNotice(`页面抓取完成：${data.result?.status || ''} ${data.result?.content_type || ''}`.trim());
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function saveKnowledge() {
    if (!noteContent.trim()) return;
    setBusy(true);
    setError('');
    try {
      await requestJson(endpoint(apiUrl, '/mcp-lab/knowledge'), {
        method: 'POST',
        headers,
        body: JSON.stringify({
          character_id: characterId,
          title: noteTitle,
          source_url: noteUrl,
          source_type: noteUrl ? 'web' : 'note',
          content: noteContent
        })
      });
      setNotice('外部知识已保存');
      setNoteTitle('');
      setNoteUrl('');
      setNoteContent('');
      await loadDocs();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function searchKnowledge() {
    if (!knowledgeQuery.trim()) return;
    setBusy(true);
    setError('');
    try {
      const data = await requestJson(endpoint(apiUrl, '/mcp-lab/knowledge/search'), {
        method: 'POST',
        headers,
        body: JSON.stringify({ character_id: characterId, query: knowledgeQuery })
      });
      setNotice(`外部知识命中 ${data.results?.length || 0} 条`);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function loadDocs() {
    const suffix = characterId ? `?character_id=${encodeURIComponent(characterId)}` : '';
    const data = await requestJson(endpoint(apiUrl, `/mcp-lab/knowledge${suffix}`), { headers });
    setDocs(data.docs || []);
  }

  async function createTask(kind) {
    setBusy(true);
    setError('');
    try {
      const input = kind === 'fetch_url' ? { url } : { query, provider: selectedProvider };
      const title = kind === 'fetch_url' ? url : query;
      await requestJson(endpoint(apiUrl, '/mcp-lab/tasks'), {
        method: 'POST',
        headers,
        body: JSON.stringify({ kind, title, input, run_now: true })
      });
      setNotice('任务已创建并执行');
      await load();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function rerunTask(task) {
    setBusy(true);
    setError('');
    try {
      await requestJson(endpoint(apiUrl, `/mcp-lab/tasks/${task.id}/run`), { method: 'POST', headers });
      await load();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function deleteTask(task) {
    setError('');
    try {
      await requestJson(endpoint(apiUrl, `/mcp-lab/tasks/${task.id}`), { method: 'DELETE', headers });
      await load();
    } catch (e) {
      setError(e.message);
    }
  }

  const providers = webConfig?.providers || status?.web_search_providers || [];
  const activeProvider = webConfig?.active_provider || status?.search_provider || 'duckduckgo';
  const selectedProviderConfig = providers.find(provider => provider.id === selectedProvider);

  function toggleClearProvider(providerId) {
    setClearKeyIds((current) => current.includes(providerId)
      ? current.filter(id => id !== providerId)
      : [...current, providerId]);
  }

  function selectTask(task) {
    setSelectedTaskId(current => current === task.id ? '' : task.id);
  }

  const taskItems = Array.isArray(tasks) ? tasks : [];

  return (
    <div style={panel}>
      <div style={toolbar}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 800, fontSize: '15px' }}>MCP 实验台</div>
          <div style={{ color: '#64748b', fontSize: '12px', marginTop: '2px' }}>
            联网搜索、网页抓取和资料记录
          </div>
        </div>
        <span style={badgeStyle}><Wifi size={12} /> {providerLabel(activeProvider, providers)}</span>
        <button style={iconButton} onClick={load} title="刷新">
          <RefreshCw size={16} />
        </button>
      </div>

      {error && <div style={{ margin: '12px 16px 0', padding: '8px 10px', border: '1px solid #fecaca', borderRadius: '6px', color: '#b91c1c', background: '#fff1f2', fontSize: '12px' }}>{error}</div>}

      {notice && <div style={{ margin: '10px 16px 0', padding: '7px 10px', border: '1px solid #bfdbfe', borderRadius: '6px', color: '#1d4ed8', background: '#eff6ff', fontSize: '12px' }}>{notice}</div>}

      <div style={{ padding: '14px 16px', overflowY: 'auto', minHeight: 0 }}>
        <div style={{ display: 'grid', gap: '12px', maxWidth: '1120px', margin: '0 auto' }}>
          <section style={sectionStyle}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px', marginBottom: '8px' }}>
              <div style={{ fontWeight: 700, fontSize: '13px' }}>联网查询</div>
              <span style={badgeStyle}>当前：{providerLabel(activeProvider, providers)}</span>
            </div>
            <div style={{ display: 'grid', gap: '8px', marginBottom: '10px' }}>
              <div style={{ display: 'flex', gap: '8px' }}>
                <select style={{ ...inputStyle, flex: 1 }} value={selectedProvider} onChange={(e) => setSelectedProvider(e.target.value)}>
                  <option value="auto">自动选择可用搜索源</option>
                  {providers.map(provider => (
                    <option key={provider.id} value={provider.id}>{provider.label}</option>
                  ))}
                  <option value="duckduckgo">DuckDuckGo 免 Key</option>
                </select>
                <button style={iconButton} onClick={saveWebConfig} disabled={busy} title="保存联网 Key 与搜索源">
                  <Save size={15} />
                </button>
              </div>
              {selectedProviderConfig ? (
                <div style={{ display: 'grid', gap: '6px' }}>
                  {selectedProviderConfig.has_key && (
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', alignItems: 'center', color: '#475569', fontSize: '12px' }}>
                      <span style={{ ...badgeStyle, color: '#166534', borderColor: '#bbf7d0', background: '#f0fdf4' }}>
                        已保存
                      </span>
                      <span style={badgeStyle}>{selectedProviderConfig.source === 'env' ? '环境变量' : '用户配置'}</span>
                    </div>
                  )}
                  <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto', gap: '8px', alignItems: 'center' }}>
                    <div style={{ position: 'relative', minWidth: 0 }}>
                      <KeyRound size={14} style={{ position: 'absolute', left: '10px', top: '10px', color: '#64748b' }} />
                      <input
                        style={{ ...inputStyle, width: '100%', paddingLeft: '30px' }}
                        type={webKeys[selectedProviderConfig.id] ? 'password' : 'text'}
                        value={webKeys[selectedProviderConfig.id] || ''}
                        onChange={(e) => setWebKeys(current => ({ ...current, [selectedProviderConfig.id]: e.target.value }))}
                        placeholder={selectedProviderConfig.has_key ? '输入新 Key 可替换已保存 Key' : `${selectedProviderConfig.label} API Key`}
                      />
                    </div>
                    <button
                      style={{
                        ...iconButton,
                        width: '54px',
                        background: clearKeyIds.includes(selectedProviderConfig.id) ? '#fee2e2' : '#fff',
                        borderColor: clearKeyIds.includes(selectedProviderConfig.id) ? '#fca5a5' : '#cbd5e1',
                        color: clearKeyIds.includes(selectedProviderConfig.id) ? '#b91c1c' : '#475569',
                        fontSize: '11px'
                      }}
                      onClick={() => toggleClearProvider(selectedProviderConfig.id)}
                      title="标记清除这个用户级 Key，再点保存生效"
                    >
                      清除
                    </button>
                  </div>
                </div>
              ) : (
                <div style={{ color: '#64748b', fontSize: '12px', lineHeight: 1.5 }}>
                  {selectedProvider === 'duckduckgo' ? 'DuckDuckGo 不需要 Key。' : '自动模式会优先使用已保存 Key，未配置时使用 DuckDuckGo。'}
                </div>
              )}
            </div>
            <div style={{ display: 'flex', gap: '8px' }}>
              <input style={{ ...inputStyle, flex: 1 }} value={query} onChange={(e) => setQuery(e.target.value)} placeholder="搜索关键词" onKeyDown={(e) => { if (e.key === 'Enter') runSearch(); }} />
              <button style={primaryButton} onClick={runSearch} disabled={busy} title="搜索">
                <Search size={15} /> 搜索
              </button>
            </div>
            <button style={{ ...iconButton, width: '100%', marginTop: '8px' }} onClick={() => createTask('web_search')} disabled={busy || !query.trim()} title="创建并执行查询任务">
              <Play size={15} /> 保存为查询任务
            </button>
            <div style={{ marginTop: '12px', paddingTop: '12px', borderTop: '1px solid #e2e8f0' }}>
              <div style={{ fontWeight: 700, fontSize: '13px', marginBottom: '8px' }}>抓取指定网页</div>
              <div style={{ display: 'flex', gap: '8px' }}>
                <input style={{ ...inputStyle, flex: 1 }} value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com" onKeyDown={(e) => { if (e.key === 'Enter') fetchUrl(); }} />
                <button style={primaryButton} onClick={fetchUrl} disabled={busy} title="抓取">
                  <ExternalLink size={15} /> 抓取
                </button>
              </div>
              <button style={{ ...iconButton, width: '100%', marginTop: '8px' }} onClick={() => createTask('fetch_url')} disabled={busy || !url.trim()} title="创建并执行抓取任务">
                <Play size={15} /> 保存为抓取任务
              </button>
            </div>
            <SearchResultList result={searchResult} />
          </section>

          <section style={sectionStyle}>
            <div style={{ fontWeight: 700, fontSize: '13px', marginBottom: '8px' }}>手动保存联网资料</div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '8px' }}>
              <input style={inputStyle} value={noteTitle} onChange={(e) => setNoteTitle(e.target.value)} placeholder="标题" />
              <input style={inputStyle} value={noteUrl} onChange={(e) => setNoteUrl(e.target.value)} placeholder="来源 URL，可空" />
              <select style={inputStyle} value={characterId} onChange={(e) => setCharacterId(e.target.value)} title="知识归属角色">
                <option value="">全局知识</option>
                {characters.map((character) => (
                  <option key={character.id} value={character.id}>{character.name || character.id}</option>
                ))}
              </select>
              <div style={{ display: 'flex', gap: '8px' }}>
                <input style={{ ...inputStyle, flex: 1 }} value={knowledgeQuery} onChange={(e) => setKnowledgeQuery(e.target.value)} placeholder="搜索知识" onKeyDown={(e) => { if (e.key === 'Enter') searchKnowledge(); }} />
                <button style={iconButton} onClick={searchKnowledge} disabled={busy || !knowledgeQuery.trim()} title="搜索知识">
                  <Database size={15} />
                </button>
              </div>
            </div>
            <textarea style={{ ...textAreaStyle, width: '100%', marginTop: '8px' }} value={noteContent} onChange={(e) => setNoteContent(e.target.value)} placeholder="把网页摘要、设定资料或查询结果存到独立资料库，不进入角色记忆库" />
            <button style={{ ...primaryButton, width: '100%', marginTop: '8px' }} onClick={saveKnowledge} disabled={busy || !noteContent.trim()} title="保存知识">
              <Save size={15} /> 保存资料
            </button>
          </section>

          <section style={sectionStyle}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px' }}>
              <div style={{ fontWeight: 700, fontSize: '13px' }}>联网任务记录</div>
              <span style={{ color: '#64748b', fontSize: '12px' }}>{taskItems.length}</span>
            </div>
            <div style={{ display: 'grid', gap: '8px' }}>
              {taskItems.length === 0 && <div style={{ color: '#64748b', fontSize: '12px' }}>还没有任务。</div>}
              {taskItems.map(task => (
                <TaskRecord
                  key={task.id}
                  task={task}
                  selected={task.id === selectedTaskId}
                  providers={providers}
                  onSelect={selectTask}
                  onRerun={rerunTask}
                  onDelete={deleteTask}
                />
              ))}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
