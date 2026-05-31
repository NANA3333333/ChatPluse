import React, { Suspense, lazy, useState, useEffect, useCallback, useMemo, useRef } from 'react';
import ContactList from './components/ContactList';
import ChatWindow from './components/ChatWindow';
import CreateGroupModal from './components/CreateGroupModal';
import AddCharacterModal from './components/AddCharacterModal';

import './App.css';
import { MessageSquare, Users, Compass, Settings, UserPlus, Globe, UsersRound, LogOut, Database, LibraryBig, Download, Upload, Wand2, RefreshCw, X, BookOpen } from 'lucide-react';
import { plugins } from './plugins';
import { useLanguage } from './LanguageContext';
import { useAuth } from './AuthContext';
import Login from './components/Login';
import { resolveAvatarUrl } from './utils/avatar';

// Allow VITE config if available, otherwise dynamically use the current host IP/Domain
const PROTOCOL = window.location.protocol;
const HOST = window.location.hostname;
const defaultApiOrigin = `${PROTOCOL}//${HOST}:8000`;
const defaultWsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
const defaultWsHost = `${HOST}:8000`;
const API_URL = import.meta.env.VITE_API_URL || `${defaultApiOrigin}/api`;
const WS_URL = import.meta.env.VITE_WS_URL || `${defaultWsProtocol}//${defaultWsHost}`;

function lazyWithPreload(factory) {
  const Component = lazy(factory);
  Component.preload = factory;
  return Component;
}

const GroupChatWindow = lazyWithPreload(() => import('./components/GroupChatWindow'));
const MemoTable = lazyWithPreload(() => import('./components/MemoTable'));
const DiaryTable = lazyWithPreload(() => import('./components/DiaryTable'));
const MomentsFeed = lazyWithPreload(() => import('./components/MomentsFeed'));
const SettingsPanel = lazyWithPreload(() => import('./components/SettingsPanel'));
const ChatSettingsDrawer = lazyWithPreload(() => import('./components/ChatSettingsDrawer'));
const MemoryLibraryPanel = lazyWithPreload(() => import('./components/MemoryLibraryPanel'));

function PanelFallback() {
  return (
    <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#8a8f98', fontSize: '13px' }}>
      Loading...
    </div>
  );
}

function DrawerFallback({ type = 'settings', contact, lang = 'zh', onClose }) {
  const contactName = contact?.name || (lang === 'en' ? 'Character' : '角色');
  if (type === 'memo') {
    return (
      <aside className="drawer-container memory-drawer memory-table-drawer drawer-loading-fallback">
        <div className="memory-header">
          <h3>{contactName} {lang === 'en' ? "'s Memories" : '的记忆'}</h3>
          <div className="memory-header-actions">
            <button type="button" className="memory-action-btn drawer-fallback-action" aria-disabled="true" tabIndex={-1}>
              <Download size={14} /> {lang === 'en' ? 'Export all' : '导出全部'}
            </button>
            <button type="button" className="memory-action-btn drawer-fallback-action" aria-disabled="true" tabIndex={-1}>
              <Upload size={14} /> {lang === 'en' ? 'Import all' : '导入全部'}
            </button>
            <button type="button" className="memory-action-btn drawer-fallback-action" aria-disabled="true" tabIndex={-1}>
              <Wand2 size={14} /> {lang === 'en' ? 'Extract' : '提取'}
            </button>
            <button type="button" className="icon-btn drawer-fallback-action" aria-disabled="true" tabIndex={-1}>
              <RefreshCw size={16} />
            </button>
            <button type="button" className="icon-btn" onClick={onClose} title={lang === 'en' ? 'Close' : '关闭'}>
              <X size={16} />
            </button>
          </div>
        </div>
        <div className="memory-content">
          <p className="loading-text">{lang === 'en' ? 'Loading memories...' : '加载记忆中...'}</p>
        </div>
      </aside>
    );
  }
  if (type === 'diary') {
    return (
      <aside className="memory-drawer drawer-loading-fallback diary" style={{ width: '380px', backgroundColor: '#fffdf5' }}>
        <div className="memory-header" style={{ backgroundColor: '#f6f1e3', borderBottomColor: '#e0d8c3' }}>
          <h3 style={{ display: 'flex', alignItems: 'center', gap: '8px', color: '#5a4d3c' }}>
            <BookOpen size={18} />
            {contactName} {lang === 'en' ? "'s Diary" : '的日记'}
          </h3>
          <button type="button" className="icon-btn" onClick={onClose} title={lang === 'en' ? 'Close' : '关闭'}>
            <X size={20} />
          </button>
        </div>
        <div className="memory-list" style={{ padding: '20px' }}>
          <div className="placeholder-text">{lang === 'en' ? 'Loading...' : '加载中...'}</div>
        </div>
      </aside>
    );
  }
  return (
    <aside className="memory-drawer drawer-loading-fallback" style={{ width: '320px', backgroundColor: '#f7f7f7' }}>
      <div className="memory-header">
        <h3 style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <Settings size={18} />
          {lang === 'en' ? 'Chat Settings' : '聊天设置'}
        </h3>
        <button type="button" className="icon-btn" onClick={onClose} title={lang === 'en' ? 'Close' : '关闭'}>
          <X size={20} />
        </button>
      </div>
      <div className="memory-content">
        <p className="loading-text">{lang === 'en' ? 'Loading settings...' : '加载设置中...'}</p>
      </div>
    </aside>
  );
}

function App() {
  const { token, logout, user: authUser } = useAuth();
  const { t, lang, toggleLanguage } = useLanguage();
  const [activeTab, setActiveTab] = useState('chats'); // 'chats', 'contacts', 'settings'
  const [activeContactId, setActiveContactId] = useState(null);
  const [contacts, setContacts] = useState([]);
  const [contactsLoadError, setContactsLoadError] = useState('');
  const [activeContactSnapshot, setActiveContactSnapshot] = useState(null);

  const [incomingMessageQueue, setIncomingMessageQueue] = useState([]);
  const [activeDrawer, setActiveDrawer] = useState(null); // 'memo', 'diary', or null
  const [userProfile, setUserProfile] = useState(() => authUser || null);
  const [isLoaded, setIsLoaded] = useState(() => !!token);
  const [engineState, setEngineState] = useState({});
  const [showAddCharModal, setShowAddCharModal] = useState(false);
  const [showCreateGroupModal, setShowCreateGroupModal] = useState(false);
  const [groups, setGroups] = useState([]);
  const [activeGroupId, setActiveGroupId] = useState(null);
  const [incomingGroupMessageQueue, setIncomingGroupMessageQueue] = useState([]);
  const [groupTyping, setGroupTyping] = useState({}); // { groupId: [{ sender_id, name }, ...] }
  const [globalAnnouncement, setGlobalAnnouncement] = useState(null);
  const [groupChatEnabled, setGroupChatEnabled] = useState(false); // Auto-detected: true if Group Chat DLC is loaded
  const [redpacketClaimEvent, setRedpacketClaimEvent] = useState(null);
  const [hasNewMoments, setHasNewMoments] = useState(false); // Moments notification
  const [generatingSchedules, setGeneratingSchedules] = useState({});
  const [hiddenMessagesCount, setHiddenMessagesCount] = useState(0);
  const effectiveUser = useMemo(() => ({ ...(authUser || {}), ...(userProfile || {}) }), [authUser, userProfile]);
  const visiblePlugins = plugins.filter(p => !p.condition || p.condition(effectiveUser));
  const experimentalPlugins = visiblePlugins.filter(p => p.position === 'experiment');
  const regularPlugins = visiblePlugins.filter(p => p.position !== 'experiment');
  const activeChatContact = contacts.find(c => c.id === activeContactId) || activeContactSnapshot;

  // Use a ref to track the active contact ID without causing useEffect re-renders when it changes.
  const activeContactRef = useRef(activeContactId);
  useEffect(() => { activeContactRef.current = activeContactId; }, [activeContactId]);
  const activeGroupRef = useRef(activeGroupId);
  useEffect(() => { activeGroupRef.current = activeGroupId; }, [activeGroupId]);
  const activeTabRef = useRef(activeTab);
  useEffect(() => { activeTabRef.current = activeTab; }, [activeTab]);

  useEffect(() => {
    if (!activeContactId) {
      setActiveContactSnapshot(null);
      return;
    }
    const latest = contacts.find(c => c.id === activeContactId);
    if (latest) {
      setActiveContactSnapshot(latest);
    }
  }, [activeContactId, contacts]);

  // Use a ref to track which incoming messages we've already processed for unread badges and sounds
  const processedMessagesRef = useRef(new Set());
  const cityRefreshRef = useRef(null);
  const contactsRefreshRef = useRef(null);

  useEffect(() => {
    const handleCharacterDataWiped = (event) => {
      const wipedId = event.detail?.characterId;
      if (!wipedId) return;
      setContacts(prev => prev.map(c => c.id === wipedId ? {
        ...c,
        lastMessage: '',
        time: '',
        unread: 0,
        affinity: c.initial_affinity ?? 50,
        pressure_level: 0,
        jealousy_level: 0,
        wallet: 200,
        calories: 2000,
        city_status: 'idle',
        location: 'home'
      } : c));
      if (activeContactRef.current === wipedId) {
        setActiveContactSnapshot(prev => prev ? {
          ...prev,
          lastMessage: '',
          time: '',
          unread: 0,
          affinity: prev.initial_affinity ?? 50,
          pressure_level: 0,
          jealousy_level: 0,
          wallet: 200,
          calories: 2000,
          city_status: 'idle',
          location: 'home'
        } : prev);
      }
    };
    window.addEventListener('character_data_wiped', handleCharacterDataWiped);
    return () => window.removeEventListener('character_data_wiped', handleCharacterDataWiped);
  }, []);

  const fetchContacts = useCallback(() => {
    if (!token) return;
    return fetch(`${API_URL}/characters`, {
      headers: { 'Authorization': `Bearer ${token}` }
    })
      .then(res => {
        if (!res.ok) throw new Error('API Error');
        return res.json();
      })
      .then(data => {
        setContactsLoadError('');
        setContacts(prev => data.map(newContact => {
          const existing = prev.find(p => p.id === newContact.id);
          if (existing) {
            return {
              ...newContact,
              unread: existing.unread || 0,
              lastMessage: newContact.lastMessage || existing.lastMessage,
              time: newContact.time || existing.time
            };
          }
          return newContact;
        }));
        return data;
      })
      .catch(err => {
        console.error('Failed to load contacts:', err);
        setContactsLoadError(err.message || 'Failed to load contacts');
        return [];
      });
  }, [token]);

  const scheduleContactsRefresh = useCallback((delay = 350) => {
    if (contactsRefreshRef.current) {
      clearTimeout(contactsRefreshRef.current);
    }
    contactsRefreshRef.current = setTimeout(() => {
      contactsRefreshRef.current = null;
      fetchContacts();
    }, delay);
  }, [fetchContacts]);

  const removeDeletedContact = useCallback((deletedId) => {
    if (!deletedId) return;
    const targetId = String(deletedId);
    setContacts(prev => prev.filter(contact => String(contact.id) !== targetId));
    setGroups(prev => prev.map(group => ({
      ...group,
      members: Array.isArray(group.members)
        ? group.members.filter(member => {
          const memberId = typeof member === 'object' ? member.member_id : member;
          return String(memberId) !== targetId;
        })
        : group.members
    })));
    setEngineState(prev => {
      if (!prev || !(targetId in prev)) return prev;
      const next = { ...prev };
      delete next[targetId];
      return next;
    });
    if (String(activeContactRef.current || '') === targetId) {
      activeContactRef.current = null;
      setActiveContactId(null);
      setActiveContactSnapshot(null);
      setActiveDrawer(null);
    }
  }, []);

  const preloadChatDrawer = useCallback((drawer) => {
    if (drawer === 'memo') MemoTable.preload?.();
    if (drawer === 'diary') DiaryTable.preload?.();
    if (drawer === 'settings') ChatSettingsDrawer.preload?.();
  }, []);

  const toggleChatDrawer = useCallback((drawer) => {
    preloadChatDrawer(drawer);
    setActiveDrawer((current) => (current === drawer ? null : drawer));
  }, [preloadChatDrawer]);

  // 1. Fetch Contacts (Characters) and Profile on mount
  useEffect(() => {
    if (!token) {
      setIsLoaded(true);
      return;
    }
    setIsLoaded(true);
    const headers = {
      'Authorization': `Bearer ${token}`
    };

    fetchContacts().then((loadedContacts) => {
      if (!activeContactRef.current && !activeGroupRef.current && Array.isArray(loadedContacts) && loadedContacts.length > 0) {
        const first = loadedContacts[0];
        setActiveContactId(first.id);
        setActiveContactSnapshot(first);
        activeContactRef.current = first.id;
      }

      fetch(`${API_URL}/user`, { headers })
        .then(res => {
          if (!res.ok) throw new Error('API Error');
          return res.json();
        })
        .then(data => {
          setUserProfile(data);
          if (data.theme) localStorage.setItem('cp_theme', data.theme);
          if (data.theme_config) {
            localStorage.setItem('cp_theme_config', typeof data.theme_config === 'string' ? data.theme_config : JSON.stringify(data.theme_config));
          }
          if (data.custom_css) localStorage.setItem('cp_custom_css', data.custom_css);
          if (data.avatar) localStorage.setItem('cp_avatar', data.avatar);
        })
        .catch(err => {
          console.error('Failed fetching user profile:', err);
        });

      fetch(`${API_URL}/groups`, { headers })
        .then(res => {
          if (!res.ok) throw new Error('API Error');
          return res.json();
        })
        .then(data => { setGroups(data); setGroupChatEnabled(true); })
        .catch(err => { console.warn('[DLC] Group Chat DLC not available:', err.message); setGroupChatEnabled(false); });

      fetch(`${API_URL}/system/announcement`, { headers })
        .then(res => res.json())
        .then(data => {
          if (data.success && data.announcement) {
            setGlobalAnnouncement(data.announcement.content);
          }
        })
        .catch(err => console.error('Failed to load announcement:', err));
    });
  }, [token, fetchContacts]);

  // Listen for iframe postMessage from SillyTavern parent
  useEffect(() => {
    const handleMessage = (event) => {
      if (event.data?.type === 'st_chat_changed') {
        const { characterId } = event.data;
        if (characterId) {
          fetchContacts(); // Ensure we have the latest list in case ST auto-created them
          setActiveTab('chats');
          setActiveContactId(characterId);
          setActiveGroupId(null);
        }
      }
    };
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [fetchContacts, setActiveContactId, setActiveGroupId, setActiveTab]);

  // 2. Setup WebSocket for real-time messages
  useEffect(() => {
    if (!token) return;
    let ws = null;
    let reconnectTimer = null;
    let closedByCleanup = false;
    let hasOpenedWs = false;

    const connectWs = () => {
      reconnectTimer = null;
      ws = new WebSocket(WS_URL);

      ws.onopen = () => {
        ws.send(JSON.stringify({ type: 'auth', token: token }));
        if (hasOpenedWs) {
          window.dispatchEvent(new Event('ws_reconnected'));
        }
        hasOpenedWs = true;
        scheduleContactsRefresh(100);
      };

      ws.onclose = () => {
        if (closedByCleanup) return;
        if (reconnectTimer) return;
        reconnectTimer = setTimeout(connectWs, 1200);
      };

      ws.onerror = () => {
        ws.close();
      };

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          if (msg.type === 'new_message') {
            setIncomingMessageQueue(prev => [...prev, msg.data]);
            scheduleContactsRefresh();
          } else if (msg.type === 'tts_ready') {
            window.dispatchEvent(new CustomEvent('tts_ready', { detail: msg.data }));
          } else if (msg.type === 'engine_state') {
            setEngineState(msg.data);
          } else if (msg.type === 'group_message') {
            setIncomingGroupMessageQueue(prev => [...prev, msg.data]);
            scheduleContactsRefresh();
          } else if (msg.type === 'group_typing') {
            setGroupTyping(prev => {
              const key = msg.data.group_id;
              const current = prev[key] || [];
              if (current.find(t => t.sender_id === msg.data.sender_id)) return prev;
              return { ...prev, [key]: [...current, msg.data] };
            });
          } else if (msg.type === 'group_typing_stop') {
            setGroupTyping(prev => {
              const key = msg.data.group_id;
              return { ...prev, [key]: (prev[key] || []).filter(t => t.sender_id !== msg.data.sender_id) };
            });
          } else if (msg.type === 'wallet_sync') {
            const { characterId, characterWallet, userWallet } = msg.data;
            if (characterId && characterWallet !== null && characterWallet !== undefined) {
              setContacts(prev => prev.map(c => c.id === characterId ? { ...c, wallet: characterWallet } : c));
            }
            if (userWallet !== null && userWallet !== undefined) {
              setUserProfile(prev => prev ? { ...prev, wallet: userWallet } : prev);
            }
          } else if (msg.type === 'refresh_contacts') {
            window.dispatchEvent(new Event('refresh_contacts'));
            scheduleContactsRefresh(100);
          } else if (msg.type === 'character_deleted') {
            removeDeletedContact(msg.characterId || msg.data?.characterId);
            window.dispatchEvent(new CustomEvent('character_deleted', {
              detail: { characterId: msg.characterId || msg.data?.characterId }
            }));
            scheduleContactsRefresh(100);
          } else if (msg.type === 'announcement') {
            setGlobalAnnouncement(msg.content);
          } else if (msg.type === 'force_reload') {
            console.log('[WS] Force reload requested by server...');
            setTimeout(() => window.location.reload(), 500);
          } else if (msg.type === 'redpacket_claim') {
            setRedpacketClaimEvent({ ...msg.data, _ts: Date.now() });
          } else if (msg.type === 'moment_update') {
            // If we aren't currently viewing moments, show the red dot
            if (activeTabRef.current !== 'moments') {
              setHasNewMoments(true);
            }
          } else if (msg.type === 'memory_update') {
            console.log('[WS] Memory update received for character:', msg.characterId);
            window.dispatchEvent(new CustomEvent('memory_update', { detail: { characterId: msg.characterId } }));
          } else if (msg.type === 'memory_maintenance_progress') {
            window.dispatchEvent(new CustomEvent('memory_maintenance_progress', { detail: msg.data || {} }));
          } else if (msg.type === 'city_update') {
            window.dispatchEvent(new CustomEvent('city_update', { detail: msg }));
            scheduleContactsRefresh();
            if (!cityRefreshRef.current) {
              cityRefreshRef.current = setTimeout(() => {
                cityRefreshRef.current = null;
                fetchContacts();
              }, 1200);
            }
            if (msg.action === 'schedule_generating') {
              setGeneratingSchedules(prev => ({ ...prev, [msg.charId]: true }));
            } else if (msg.action === 'schedule_updated') {
              setGeneratingSchedules(prev => ({ ...prev, [msg.charId]: false }));
            }
          }
        } catch (e) {
          console.error('WS Parse Error', e);
        }
      };
    };

    connectWs();

    return () => {
      closedByCleanup = true;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
      }
      if (contactsRefreshRef.current) {
        clearTimeout(contactsRefreshRef.current);
        contactsRefreshRef.current = null;
      }
      if (cityRefreshRef.current) {
        clearTimeout(cityRefreshRef.current);
        cityRefreshRef.current = null;
      }
      if (ws) ws.close();
    };
  }, [token, fetchContacts, scheduleContactsRefresh, removeDeletedContact]);

  // Update contact last message preview on new incoming message
  useEffect(() => {
    if (incomingMessageQueue.length > 0) {
      let playedSound = false;
      let contactsChanged = false;

      setContacts(prev => {
        let updatedContacts = [...prev];

        incomingMessageQueue.forEach(incomingMsg => {
          // Prevent double-processing the exact same message
          if (processedMessagesRef.current.has(incomingMsg.id)) return;
          processedMessagesRef.current.add(incomingMsg.id);
          contactsChanged = true;

          // Play notification sound
          if (!playedSound && incomingMsg.role !== 'user' && incomingMsg.character_id !== activeContactRef.current) {
            playedSound = true;
            try {
              const audio = new Audio('/pop.wav');
              audio.play().catch(e => console.error("Audio play blocked:", e));
            } catch (e) { console.error(e); }
          }

          updatedContacts = updatedContacts.map(c => {
            if (c.id === incomingMsg.character_id) {
              const newUnread = c.id === activeContactRef.current ? 0 : (c.unread || 0) + 1;
              return {
                ...c,
                lastMessage: incomingMsg.content,
                time: new Date(incomingMsg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
                unread: newUnread
              };
            }
            return c;
          });
        });

        return contactsChanged ? updatedContacts : prev;
      });
    }
  }, [incomingMessageQueue]);

  // Apply Dynamic Theme & Custom CSS
  useEffect(() => {
    if (userProfile) {
      if (userProfile.theme) {
        document.documentElement.setAttribute('data-theme', userProfile.theme);
      }

      // Apply theme_config JSON mapping to CSS variables
      if (userProfile.theme_config) {
        try {
          const themeObj = typeof userProfile.theme_config === 'string' ? JSON.parse(userProfile.theme_config) : userProfile.theme_config;
          for (const [key, value] of Object.entries(themeObj)) {
            if (key.startsWith('--')) {
              document.documentElement.style.setProperty(key, value);
            }
          }
        } catch (e) {
          console.error("Failed to parse theme_config", e);
        }
      }

      // Apply custom raw CSS
      if (userProfile.custom_css) {
        let styleTag = document.getElementById('chatpulse-custom-css');
        if (!styleTag) {
          styleTag = document.createElement('style');
          styleTag.id = 'chatpulse-custom-css';
          document.head.appendChild(styleTag);
        }
        styleTag.innerHTML = userProfile.custom_css;
      } else {
        const styleTag = document.getElementById('chatpulse-custom-css');
        if (styleTag) styleTag.innerHTML = '';
      }
    }
  }, [userProfile]);

  useEffect(() => {
    const activePlugin = plugins.find(p => p.id === activeTab);
    if (activePlugin && activePlugin.condition && !activePlugin.condition(effectiveUser)) {
      setActiveTab('chats');
    }
  }, [activeTab, effectiveUser]);

  const isViewingList = (activeTab === 'contacts' || (activeTab === 'chats' && !activeContactId && !activeGroupId));

  if (!token) {
    return <Login apiUrl={API_URL} />;
  }

  if (!isLoaded) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100vh', backgroundColor: 'var(--bg-color, #f5f5f5)' }}>
        <div className="spin" style={{ width: '40px', height: '40px', border: '4px solid var(--accent-color, #07c160)', borderTopColor: 'transparent', borderRadius: '50%' }}></div>
      </div>
    );
  }

  return (
    <div className={`app-container tab-${activeTab} ${activeContactId || activeGroupId ? 'has-active-chat' : 'no-active-chat'} ${isViewingList ? 'viewing-list' : 'viewing-content'}`}>
      {globalAnnouncement && (
        <div style={{ position: 'absolute', top: 0, left: '70px', right: 0, zIndex: 9999, background: 'var(--primary, #07c160)', color: 'white', padding: '10px 20px', textAlign: 'center', boxShadow: '0 2px 8px rgba(0,0,0,0.1)', display: 'flex', justifyContent: 'center', alignItems: 'center', gap: '10px' }}>
          <span style={{ fontWeight: 'bold' }}>📢</span>
          <span>{globalAnnouncement}</span>
          <button onClick={() => setGlobalAnnouncement(null)} style={{ background: 'none', border: 'none', color: 'rgba(255,255,255,0.8)', cursor: 'pointer', marginLeft: 'auto', fontSize: '20px', padding: '0 5px' }}>&times;</button>
        </div>
      )}
      {/* 1. Very Left Sidebar (Navigation) */}
      <nav className="sidebar-nav">
        <div className="my-avatar" onClick={() => setActiveTab('settings')} style={{ cursor: 'pointer' }}>
          <img src={resolveAvatarUrl(effectiveUser?.avatar, API_URL, effectiveUser?.name || 'User')} alt="Me" />
        </div>
        <div className="nav-icons">
          <button className={`nav-icon ${activeTab === 'chats' ? 'active' : ''}`} onClick={() => setActiveTab('chats')} title={lang === 'en' ? 'Chats — View conversations' : '聊天 — 查看会话列表'}>
            <MessageSquare size={24} />
          </button>
          <button className={`nav-icon ${activeTab === 'contacts' ? 'active' : ''}`} onClick={() => setActiveTab('contacts')} title={lang === 'en' ? 'Contacts — Manage characters & groups' : '通讯录 — 管理角色和群聊'}>
            <Users size={24} />
          </button>
          <button className={`nav-icon ${activeTab === 'discover' ? 'active' : ''}`} onClick={() => { setActiveTab('discover'); setHasNewMoments(false); }} title={lang === 'en' ? 'Discover — Moments feed' : '发现 — 朋友圈动态'} style={{ position: 'relative' }}>
            <Compass size={24} />
            {hasNewMoments && <div style={{ position: 'absolute', top: '10px', right: '10px', width: '8px', height: '8px', backgroundColor: 'var(--danger)', borderRadius: '50%' }} />}
          </button>
          <button className={`nav-icon ${activeTab === 'memory_library' ? 'active' : ''}`} onClick={() => setActiveTab('memory_library')} title={lang === 'en' ? 'Memory Library — Classification and forgetting' : '记忆库 — 分类与遗忘曲线'}>
            <LibraryBig size={24} />
          </button>
        </div>
        <div className="nav-icons-bottom">
          {experimentalPlugins.map(Plugin => {
            const Icon = Plugin.icon;
            return (
              <button key={Plugin.id} className={`nav-icon ${activeTab === Plugin.id ? 'active' : ''}`} onClick={() => setActiveTab(Plugin.id)} title={lang === 'en' ? Plugin.name_en : Plugin.name_zh} style={{ color: Plugin.color || 'inherit' }}>
                <Icon size={24} />
              </button>
            );
          })}
          <button className="nav-icon" onClick={toggleLanguage} title={t('Toggle Language')}>
            <Globe size={24} />
            <span style={{ fontSize: '10px', marginTop: '4px', fontWeight: 'bold' }}>{lang === 'en' ? '中' : 'EN'}</span>
          </button>
          <button className={`nav-icon ${activeTab === 'settings' ? 'active' : ''}`} onClick={() => setActiveTab('settings')} title={lang === 'en' ? 'Settings — Global configuration' : '设置 — 全局设置'}>
            <Settings size={24} />
          </button>
          {regularPlugins.map(Plugin => {
            const Icon = Plugin.icon;
            return (
              <button key={Plugin.id} className={`nav-icon ${activeTab === Plugin.id ? 'active' : ''}`} onClick={() => setActiveTab(Plugin.id)} title={lang === 'en' ? Plugin.name_en : Plugin.name_zh} style={{ color: Plugin.color || 'inherit' }}>
                <Icon size={24} />
              </button>
            );
          })}
          <button className="nav-icon" onClick={logout} title={lang === 'en' ? 'Logout' : '退出登录'} style={{ color: '#ff4d4f' }}>
            <LogOut size={24} />
          </button>
        </div>
      </nav>

      {/* 2. Middle Column (List) */}
      <div className="middle-column" style={activeTab === 'contacts' ? { width: 'auto', flex: 1, borderRight: 'none' } : {}}>
        <div className="search-bar-container">
          <input type="text" className="search-bar" placeholder={t('Search') || 'Search'} />
        </div>
        <div className="list-container">
          {activeTab === 'chats' && (
            <>
              {contactsLoadError && contacts.length === 0 && (
                <div style={{ padding: '14px 16px', color: '#c0392b', fontSize: '12px', lineHeight: 1.5 }}>
                  Failed to load contacts: {contactsLoadError}
                </div>
              )}
              <ContactList
                apiUrl={API_URL}
                contacts={contacts}
                activeId={activeContactId}
                engineState={engineState}
                onSelect={(id) => {
                  const selected = contacts.find(c => c.id === id);
                  setActiveContactId(id);
                  if (selected) setActiveContactSnapshot(selected);
                  activeContactRef.current = id;
                  setActiveGroupId(null);
                  // Clear unread badge
                  setContacts(prev => prev.map(c => c.id === id ? { ...c, unread: 0 } : c));
                }}
              />
            </>
          )}
          {activeTab === 'chats' && groupChatEnabled && groups.length > 0 && (
            <div style={{ borderTop: '1px solid #eee' }}>
              <div style={{ padding: '5px 15px', color: '#999', fontSize: '11px' }}>
                {lang === 'en' ? 'Group Chats' : '群聊'}
              </div>
              {groups.map(g => (
                <div
                  key={g.id}
                  className={`contact-item ${activeGroupId === g.id ? 'active' : ''}`}
                  onClick={() => { setActiveGroupId(g.id); setActiveContactId(null); activeContactRef.current = null; }}
                >
                  <div className="contact-avatar" style={{ width: 'auto', minWidth: '42px', height: '42px', display: 'flex', alignItems: 'center' }}>
                    {g.members?.slice(0, 3).map((memberObj, idx) => {
                      const memberId = typeof memberObj === 'object' ? memberObj.member_id : memberObj;
                      const member = contacts.find(c => String(c.id) === String(memberId));
                      const memberAvatar = memberId === 'user'
                        ? resolveAvatarUrl(userProfile?.avatar, API_URL, userProfile?.name || 'User')
                        : resolveAvatarUrl(member?.avatar, API_URL, member?.name || memberId || 'User');
                      return <img key={idx} src={memberAvatar} alt="" style={{ width: g.members.length === 1 ? '42px' : '32px', height: g.members.length === 1 ? '42px' : '32px', borderRadius: '50%', marginLeft: idx > 0 ? '-12px' : '0', border: g.members.length === 1 ? 'none' : '2px solid #fff', zIndex: 10 - idx, objectFit: 'cover', backgroundColor: '#fff' }} />;
                    })}
                    {g.members?.length > 3 && (
                      <div style={{ width: '32px', height: '32px', borderRadius: '50%', marginLeft: '-12px', border: '2px solid #fff', zIndex: 6, backgroundColor: '#f0f0f0', color: '#888', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '11px', fontWeight: 'bold', flexShrink: 0 }}>
                        +{g.members.length - 3}
                      </div>
                    )}
                    {(!g.members || g.members.length === 0) && <div style={{ width: '42px', height: '42px', backgroundColor: '#e1e1e1', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}><UsersRound size={20} style={{ color: '#fff' }} /></div>}
                  </div>
                  <div className="contact-info">
                    <div className="contact-name">{g.name}</div>
                    <div className="contact-preview" style={{ fontSize: '12px', color: '#999' }}>({g.members?.length || 0})</div>
                  </div>
                </div>
              ))}
            </div>
          )}
          {activeTab === 'contacts' && (
            <div style={{ paddingTop: '10px' }}>

              <div style={{ padding: '5px 15px', color: '#999', fontSize: '13px', backgroundColor: '#ebebeb', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span>{t('All Contacts') || 'All Contacts'}</span>
                <button
                  onClick={() => setShowAddCharModal(true)}
                  style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--accent-color)', padding: 0 }}
                  title={lang === 'en' ? 'Add new AI character' : '添加新的 AI 角色'}
                >
                  <UserPlus size={16} />
                </button>
              </div>
              {contacts.map(c => (
                <div key={c.id} className="contact-item" onClick={() => { setActiveContactId(c.id); setActiveContactSnapshot(c); setActiveTab('chats'); }}>
                  <div className="contact-avatar">
                    <img src={resolveAvatarUrl(c.avatar, API_URL, c.name || c.id || 'User')} alt={c.name} style={{ objectFit: 'cover' }} />
                  </div>
                  <div className="contact-info" style={{ display: 'flex', alignItems: 'center' }}>
                    <span className="contact-name" style={{ fontSize: '16px' }}>{c.name}</span>
                  </div>
                </div>
              ))}
              {groupChatEnabled && (<>
                <div style={{ padding: '5px 15px', color: '#999', fontSize: '13px', backgroundColor: '#ebebeb', display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '10px' }}>
                  <span>{lang === 'en' ? 'Group Chats' : '群聊'}</span>
                  <button
                    onClick={() => setShowCreateGroupModal(true)}
                    style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--accent-color)', padding: 0 }}
                    title={lang === 'en' ? 'Create Group' : '创建群聊'}
                  >
                    <UsersRound size={16} />
                  </button>
                </div>
                {groups.map(g => (
                  <div key={g.id} className="contact-item" onClick={() => { setActiveGroupId(g.id); setActiveContactId(null); setActiveContactSnapshot(null); setActiveTab('chats'); }}>
                    <div className="contact-avatar" style={{ width: 'auto', minWidth: '42px', height: '42px', display: 'flex', alignItems: 'center' }}>
                      {g.members?.slice(0, 3).map((memberObj, idx) => {
                        const memberId = typeof memberObj === 'object' ? memberObj.member_id : memberObj;
                        const member = contacts.find(c => String(c.id) === String(memberId));
                        const memberAvatar = memberId === 'user'
                          ? resolveAvatarUrl(userProfile?.avatar, API_URL, userProfile?.name || 'User')
                          : resolveAvatarUrl(member?.avatar, API_URL, member?.name || memberId || 'User');
                        return <img key={idx} src={memberAvatar} alt="" style={{ width: g.members.length === 1 ? '42px' : '32px', height: g.members.length === 1 ? '42px' : '32px', borderRadius: '50%', marginLeft: idx > 0 ? '-12px' : '0', border: g.members.length === 1 ? 'none' : '2px solid #fff', zIndex: 10 - idx, objectFit: 'cover', backgroundColor: '#fff' }} />;
                      })}
                      {g.members?.length > 3 && (
                        <div style={{ width: '32px', height: '32px', borderRadius: '50%', marginLeft: '-12px', border: '2px solid #fff', zIndex: 6, backgroundColor: '#f0f0f0', color: '#888', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '11px', fontWeight: 'bold', flexShrink: 0 }}>
                          +{g.members.length - 3}
                        </div>
                      )}
                      {(!g.members || g.members.length === 0) && <div style={{ width: '42px', height: '42px', backgroundColor: '#e1e1e1', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}><UsersRound size={20} style={{ color: '#fff' }} /></div>}
                    </div>
                    <div className="contact-info" style={{ display: 'flex', alignItems: 'center' }}>
                      <span className="contact-name" style={{ fontSize: '16px' }}>{g.name}</span>
                    </div>
                  </div>
                ))}
              </>)}
            </div>
          )}
          {activeTab === 'discover' && (
            <div className="contact-item active">
              <Compass size={24} style={{ marginRight: '10px', color: 'var(--accent-color)' }} />
              <div className="contact-info">
                <div className="contact-name">{t('Moments')}</div>
              </div>
            </div>
          )}
          {activeTab === 'settings' && (
            <div className="contact-item active">
              <Settings size={24} style={{ marginRight: '10px', color: 'var(--accent-color)' }} />
              <div className="contact-info">
                <div className="contact-name">{t('Settings')}</div>
              </div>
            </div>
          )}
          {activeTab === 'memory_library' && (
            <div className="contact-item active">
              <Database size={24} style={{ marginRight: '10px', color: 'var(--accent-color)' }} />
              <div className="contact-info">
                <div className="contact-name">{lang === 'en' ? 'Memory Library' : '记忆库'}</div>
              </div>
            </div>
          )}
        </div>
      </div>



      {/* 3. Right Column (Chat Area / Content) — hidden on contacts tab */}
      {activeTab !== 'contacts' && (
        <div className="right-column" style={{ flexDirection: 'row', backgroundColor: activeTab === 'settings' ? '#f5f5f5' : '#fff' }}>
          <Suspense fallback={<PanelFallback />}>
            {(visiblePlugins.find(p => p.id === activeTab)) ? (() => {
              const Plugin = visiblePlugins.find(p => p.id === activeTab);
              const PluginComponent = Plugin.component;
              return (
                <div style={{ flex: 1, height: '100%', overflowY: 'auto', minWidth: 0, minHeight: 0 }}>
                  <PluginComponent apiUrl={API_URL} userProfile={effectiveUser} />
                </div>
              );
            })() : activeTab === 'settings' ? (
              <div style={{ flex: 1, height: '100%', overflowY: 'auto', minWidth: 0, minHeight: 0 }}>
                <SettingsPanel
                  apiUrl={API_URL}
                  contacts={contacts}
                  onCharactersUpdate={(event) => {
                    if (event?.type === 'deleted') {
                      removeDeletedContact(event.id);
                    }
                    fetchContacts(); // Refetch after create/update/delete
                  }}
                  onProfileUpdate={setUserProfile}
                  onBack={() => setActiveTab('chats')}
                />
              </div>
            ) : activeTab === 'discover' ? (
              <div style={{ flex: 1, height: '100%', overflowY: 'auto', minWidth: 0, minHeight: 0 }}>
                <MomentsFeed apiUrl={API_URL} userProfile={effectiveUser} onBack={() => setActiveTab('chats')} />
              </div>
            ) : activeTab === 'memory_library' ? (
              <MemoryLibraryPanel apiUrl={API_URL} contacts={contacts} />
            ) : activeContactId && activeTab === 'chats' ? (
              <div style={{ flex: 1, display: 'flex', flexDirection: 'row', height: '100%', minWidth: 0 }}>
                <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
                  <ChatWindow
                    contact={activeChatContact}
                    allContacts={contacts}
                    userAvatar={effectiveUser?.avatar}
                    apiUrl={API_URL}
                    incomingMessageQueue={incomingMessageQueue}
                    engineState={engineState}
                    onToggleMemo={() => toggleChatDrawer('memo')}
                    onToggleDiary={() => toggleChatDrawer('diary')}
                    onToggleSettings={() => toggleChatDrawer('settings')}
                    onPreloadMemo={() => preloadChatDrawer('memo')}
                    onPreloadDiary={() => preloadChatDrawer('diary')}
                    onPreloadSettings={() => preloadChatDrawer('settings')}
                    onBack={() => { setActiveContactId(null); setActiveContactSnapshot(null); activeContactRef.current = null; }}
                    onSwitchTab={setActiveTab}
                    isGeneratingSchedule={generatingSchedules[activeContactId]}
                    onMessagesChange={setHiddenMessagesCount}
                  />
                </div>
                {activeDrawer === 'memo' && (
                  <Suspense fallback={<DrawerFallback type="memo" contact={activeChatContact} lang={lang} onClose={() => setActiveDrawer(null)} />}>
                    <MemoTable
                      contact={activeChatContact}
                      apiUrl={API_URL}
                      onClose={() => setActiveDrawer(null)}
                    />
                  </Suspense>
                )}
                {activeDrawer === 'diary' && (
                  <Suspense fallback={<DrawerFallback type="diary" contact={activeChatContact} lang={lang} onClose={() => setActiveDrawer(null)} />}>
                    <DiaryTable
                      contact={activeChatContact}
                      apiUrl={API_URL}
                      onClose={() => setActiveDrawer(null)}
                    />
                  </Suspense>
                )}
                {activeDrawer === 'settings' && (
                  <Suspense fallback={<DrawerFallback type="settings" contact={activeChatContact} lang={lang} onClose={() => setActiveDrawer(null)} />}>
                    <ChatSettingsDrawer
                      contact={activeChatContact}
                      apiUrl={API_URL}
                      onClose={() => setActiveDrawer(null)}
                      onClearHistory={() => {
                        setActiveDrawer(null);
                        fetchContacts(); // Re-pull character data so stats show as reset immediately
                      }}
                      isGeneratingSchedule={!!generatingSchedules[activeContactId]}
                      messagesHideStateCount={hiddenMessagesCount}
                    />
                  </Suspense>
                )}
              </div>
            ) : activeGroupId && activeTab === 'chats' ? (
              <div style={{ flex: 1, display: 'flex', flexDirection: 'row', height: '100%', minWidth: 0 }}>
                <GroupChatWindow
                  group={groups.find(g => g.id === activeGroupId)}
                  apiUrl={API_URL}
                  allContacts={contacts}
                  userProfile={effectiveUser}
                  incomingGroupMessageQueue={incomingGroupMessageQueue}
                  typingIndicators={groupTyping[activeGroupId] || []}
                  redpacketClaimEvent={redpacketClaimEvent}
                  onBack={() => setActiveGroupId(null)}
                  onGroupUpdated={(updatedGroup) => {
                    setGroups(prev => prev.map(g => g.id === updatedGroup.id ? updatedGroup : g));
                  }}
                />
              </div>
            ) : (
              <div className="empty-chat-state">
                <MessageSquare size={64} className="empty-icon" />
                <p>ChatPulse</p>
              </div>
            )}
          </Suspense>
        </div>
      )}



      <AddCharacterModal
        isOpen={showAddCharModal}
        onClose={() => setShowAddCharModal(false)}
        apiUrl={API_URL}
        onAdd={(newChar) => {
          setContacts(prev => [...prev, newChar]);
        }}
      />

      {groupChatEnabled && showCreateGroupModal && (
        <CreateGroupModal
          apiUrl={API_URL}
          contacts={contacts}
          onClose={() => setShowCreateGroupModal(false)}
          onCreate={(group) => {
            setGroups(prev => [group, ...prev]);
            setShowCreateGroupModal(false);
            setActiveGroupId(group.id);
            setActiveContactId(null);
            setActiveTab('chats');
          }}
        />
      )}
    </div>
  );
}

export default App;
