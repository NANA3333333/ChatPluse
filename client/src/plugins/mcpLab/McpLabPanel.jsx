import React, { useEffect, useMemo, useState } from 'react';
import { Database, ExternalLink, Eye, Play, RefreshCw, Save, Search, Trash2 } from 'lucide-react';

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

function ResultList({ result }) {
  if (!result) return <div style={{ color: '#64748b', fontSize: '13px' }}>还没有输出。</div>;
  if (Array.isArray(result.results)) {
    if (result.results.length === 0) return <div style={{ color: '#64748b', fontSize: '13px' }}>没有找到可用结果。</div>;
    return (
      <div style={{ display: 'grid', gap: '8px' }}>
        {result.results.map((item, index) => (
          <div key={`${item.url || item.title}-${index}`} style={{ padding: '10px', border: '1px solid #d8e0ea', borderRadius: '6px', background: '#fff' }}>
            <div style={{ fontWeight: 700, fontSize: '13px', marginBottom: '4px' }}>{item.title || item.url || 'Result'}</div>
            {item.snippet && <div style={{ color: '#475569', fontSize: '12px', lineHeight: 1.5 }}>{item.snippet}</div>}
            {item.url && (
              <a href={item.url} target="_blank" rel="noreferrer" style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', marginTop: '6px', color: '#2563eb', fontSize: '12px' }}>
                打开来源 <ExternalLink size={12} />
              </a>
            )}
          </div>
        ))}
      </div>
    );
  }
  if (Array.isArray(result.knowledge_results)) {
    if (result.knowledge_results.length === 0) return <div style={{ color: '#64748b', fontSize: '13px' }}>外部知识库没有命中。</div>;
    return (
      <div style={{ display: 'grid', gap: '8px' }}>
        {result.knowledge_results.map((item) => (
          <div key={item.chunk_id} style={{ padding: '10px', border: '1px solid #d8e0ea', borderRadius: '6px', background: '#fff' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <div style={{ flex: 1, fontWeight: 700, fontSize: '13px' }}>{item.title}</div>
              <span style={{ color: '#64748b', fontSize: '11px' }}>score {item.score}</span>
            </div>
            <div style={{ color: '#475569', fontSize: '12px', lineHeight: 1.5, marginTop: '6px', whiteSpace: 'pre-wrap' }}>{item.content}</div>
            {item.source_url && (
              <a href={item.source_url} target="_blank" rel="noreferrer" style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', marginTop: '6px', color: '#2563eb', fontSize: '12px' }}>
                来源 <ExternalLink size={12} />
              </a>
            )}
          </div>
        ))}
      </div>
    );
  }
  return (
    <pre style={{ margin: 0, whiteSpace: 'pre-wrap', color: '#334155', fontSize: '12px', lineHeight: 1.5 }}>
      {result.text || JSON.stringify(result, null, 2)}
    </pre>
  );
}

export default function McpLabPanel({ apiUrl }) {
  const headers = useMemo(() => getHeaders(), []);
  const [status, setStatus] = useState(null);
  const [characters, setCharacters] = useState([]);
  const [characterId, setCharacterId] = useState('');
  const [query, setQuery] = useState('');
  const [url, setUrl] = useState('');
  const [result, setResult] = useState(null);
  const [tasks, setTasks] = useState([]);
  const [docs, setDocs] = useState([]);
  const [noteTitle, setNoteTitle] = useState('');
  const [noteUrl, setNoteUrl] = useState('');
  const [noteContent, setNoteContent] = useState('');
  const [knowledgeQuery, setKnowledgeQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function load() {
    setError('');
    try {
      const [statusData, taskData, characterData, docData] = await Promise.all([
        requestJson(endpoint(apiUrl, '/mcp-lab/status'), { headers }),
        requestJson(endpoint(apiUrl, '/mcp-lab/tasks'), { headers }),
        requestJson(endpoint(apiUrl, '/characters'), { headers }),
        requestJson(endpoint(apiUrl, '/mcp-lab/knowledge'), { headers })
      ]);
      setStatus(statusData);
      setTasks(taskData.tasks || []);
      const nextCharacters = Array.isArray(characterData) ? characterData : [];
      setCharacters(nextCharacters);
      setCharacterId((current) => current || nextCharacters[0]?.id || '');
      setDocs(docData.docs || []);
    } catch (e) {
      setError(e.message);
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function runSearch() {
    if (!query.trim()) return;
    setBusy(true);
    setError('');
    try {
      const data = await requestJson(endpoint(apiUrl, '/mcp-lab/search'), {
        method: 'POST',
        headers,
        body: JSON.stringify({ query })
      });
      setResult(data.result);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
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
      setResult(data.result);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function inspectContext() {
    if (!characterId) return;
    setBusy(true);
    setError('');
    try {
      const data = await requestJson(endpoint(apiUrl, `/mcp-lab/context/${encodeURIComponent(characterId)}`), { headers });
      setResult(data.context);
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
      const data = await requestJson(endpoint(apiUrl, '/mcp-lab/knowledge'), {
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
      setResult(data.doc);
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
      setResult({ knowledge_results: data.results || [] });
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
      const input = kind === 'fetch_url' ? { url } : { query };
      const title = kind === 'fetch_url' ? url : query;
      await requestJson(endpoint(apiUrl, '/mcp-lab/tasks'), {
        method: 'POST',
        headers,
        body: JSON.stringify({ kind, title, input, run_now: true })
      });
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

  return (
    <div style={panel}>
      <div style={toolbar}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 800, fontSize: '15px' }}>MCP 实验台</div>
          <div style={{ color: '#64748b', fontSize: '12px', marginTop: '2px' }}>
            {status?.note || '联网工具、外部知识库、上下文检查的实验入口'}
          </div>
        </div>
        <button style={iconButton} onClick={load} title="刷新">
          <RefreshCw size={16} />
        </button>
      </div>

      {error && <div style={{ margin: '12px 16px 0', padding: '8px 10px', border: '1px solid #fecaca', borderRadius: '6px', color: '#b91c1c', background: '#fff1f2', fontSize: '12px' }}>{error}</div>}

      <div style={{ padding: '14px 16px', display: 'grid', gridTemplateColumns: 'minmax(300px, 420px) minmax(0, 1fr)', gap: '14px', overflow: 'hidden', minHeight: 0 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', minWidth: 0, overflowY: 'auto', paddingRight: '2px' }}>
          <section style={sectionStyle}>
            <div style={{ fontWeight: 700, fontSize: '13px', marginBottom: '8px' }}>角色上下文</div>
            <div style={{ display: 'flex', gap: '8px' }}>
              <select style={{ ...inputStyle, flex: 1 }} value={characterId} onChange={(e) => setCharacterId(e.target.value)}>
                {characters.map((character) => (
                  <option key={character.id} value={character.id}>{character.name || character.id}</option>
                ))}
              </select>
              <button style={primaryButton} onClick={inspectContext} disabled={busy || !characterId} title="检查上下文">
                <Eye size={15} /> 检查
              </button>
            </div>
          </section>

          <section style={sectionStyle}>
            <div style={{ fontWeight: 700, fontSize: '13px', marginBottom: '8px' }}>联网查询</div>
            <div style={{ display: 'flex', gap: '8px' }}>
              <input style={{ ...inputStyle, flex: 1 }} value={query} onChange={(e) => setQuery(e.target.value)} placeholder="搜索关键词" onKeyDown={(e) => { if (e.key === 'Enter') runSearch(); }} />
              <button style={primaryButton} onClick={runSearch} disabled={busy} title="搜索">
                <Search size={15} /> 搜索
              </button>
            </div>
            <button style={{ ...iconButton, width: '100%', marginTop: '8px' }} onClick={() => createTask('web_search')} disabled={busy || !query.trim()} title="创建并执行查询任务">
              <Play size={15} /> 加入任务
            </button>
          </section>

          <section style={sectionStyle}>
            <div style={{ fontWeight: 700, fontSize: '13px', marginBottom: '8px' }}>抓取页面</div>
            <div style={{ display: 'flex', gap: '8px' }}>
              <input style={{ ...inputStyle, flex: 1 }} value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com" onKeyDown={(e) => { if (e.key === 'Enter') fetchUrl(); }} />
              <button style={primaryButton} onClick={fetchUrl} disabled={busy} title="抓取">
                <ExternalLink size={15} /> 抓取
              </button>
            </div>
            <button style={{ ...iconButton, width: '100%', marginTop: '8px' }} onClick={() => createTask('fetch_url')} disabled={busy || !url.trim()} title="创建并执行抓取任务">
              <Play size={15} /> 加入任务
            </button>
          </section>

          <section style={sectionStyle}>
            <div style={{ fontWeight: 700, fontSize: '13px', marginBottom: '8px' }}>外部知识库</div>
            <div style={{ display: 'grid', gap: '8px' }}>
              <input style={inputStyle} value={noteTitle} onChange={(e) => setNoteTitle(e.target.value)} placeholder="标题" />
              <input style={inputStyle} value={noteUrl} onChange={(e) => setNoteUrl(e.target.value)} placeholder="来源 URL，可空" />
              <textarea style={textAreaStyle} value={noteContent} onChange={(e) => setNoteContent(e.target.value)} placeholder="保存到独立外部知识库，不进入角色记忆库" />
              <button style={{ ...primaryButton, width: '100%' }} onClick={saveKnowledge} disabled={busy || !noteContent.trim()} title="保存知识">
                <Save size={15} /> 保存知识
              </button>
              <div style={{ display: 'flex', gap: '8px' }}>
                <input style={{ ...inputStyle, flex: 1 }} value={knowledgeQuery} onChange={(e) => setKnowledgeQuery(e.target.value)} placeholder="搜索外部知识" onKeyDown={(e) => { if (e.key === 'Enter') searchKnowledge(); }} />
                <button style={iconButton} onClick={searchKnowledge} disabled={busy || !knowledgeQuery.trim()} title="搜索知识">
                  <Database size={15} />
                </button>
              </div>
            </div>
            <div style={{ display: 'grid', gap: '6px', marginTop: '10px' }}>
              {docs.slice(0, 5).map((doc) => (
                <div key={doc.id} style={{ border: '1px solid #e2e8f0', borderRadius: '6px', padding: '7px 8px' }}>
                  <div style={{ fontWeight: 700, fontSize: '12px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{doc.title}</div>
                  <div style={{ color: '#64748b', fontSize: '11px' }}>{doc.source_type} / {doc.trust_level}</div>
                </div>
              ))}
            </div>
          </section>

          <section style={sectionStyle}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px' }}>
              <div style={{ fontWeight: 700, fontSize: '13px' }}>任务队列</div>
              <span style={{ color: '#64748b', fontSize: '12px' }}>{tasks.length}</span>
            </div>
            <div style={{ display: 'grid', gap: '8px' }}>
              {tasks.length === 0 && <div style={{ color: '#64748b', fontSize: '12px' }}>还没有任务。</div>}
              {tasks.map(task => (
                <div key={task.id} style={{ border: '1px solid #e2e8f0', borderRadius: '6px', padding: '8px' }}>
                  <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontWeight: 700, fontSize: '12px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{task.title}</div>
                      <div style={{ color: task.status === 'error' ? '#dc2626' : '#64748b', fontSize: '11px' }}>{task.kind} / {task.status}</div>
                    </div>
                    <button style={iconButton} onClick={() => rerunTask(task)} title="重新执行"><Play size={14} /></button>
                    <button style={iconButton} onClick={() => deleteTask(task)} title="删除"><Trash2 size={14} /></button>
                  </div>
                  {task.error && <div style={{ color: '#dc2626', fontSize: '11px', marginTop: '6px' }}>{task.error}</div>}
                </div>
              ))}
            </div>
          </section>
        </div>

        <div style={{ background: '#fff', border: '1px solid #d8e0ea', borderRadius: '8px', padding: '12px', overflowY: 'auto', minWidth: 0 }}>
          <div style={{ fontWeight: 700, fontSize: '13px', marginBottom: '10px' }}>输出</div>
          <ResultList result={result} />
        </div>
      </div>
    </div>
  );
}
