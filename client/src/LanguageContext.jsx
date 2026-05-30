/* eslint-disable react-refresh/only-export-components */
import React, { createContext, useState, useContext, useEffect } from 'react';

const LanguageContext = createContext();

const translations = {
    // Common
    'Save': { en: 'Save', zh: '保存' },
    'Cancel': { en: 'Cancel', zh: '取消' },
    'Edit': { en: 'Edit', zh: '编辑' },
    'Delete': { en: 'Delete', zh: '删除' },
    'Send': { en: 'Send', zh: '发送' },
    'Loading': { en: 'Loading...', zh: '加载中...' },

    // Tabs
    'Chats': { en: 'Chats', zh: '聊天' },
    'Contacts': { en: 'Contacts', zh: '联系人' },
    'Moments': { en: 'Moments', zh: '朋友圈' },
    'Settings': { en: 'Settings', zh: '设置' },

    // Settings Panel
    'Export Data': { en: 'Export Data', zh: '导出数据' },
    'Deep Wipe': { en: 'Deep Wipe', zh: '深度清理' },
    'Characters': { en: 'Characters', zh: '角色' },
    'Add Character': { en: 'Add Character', zh: '添加角色' },
    'User Profile': { en: 'User Profile', zh: '用户档案' },
    'Name': { en: 'Name', zh: '名称' },
    'Avatar URL': { en: 'Avatar URL', zh: '头像 URL' },
    'Bio': { en: 'Bio', zh: '个性签名' },
    'Theme': { en: 'Theme', zh: '主题' },

    // Add / Edit Character Form
    'Persona': { en: 'Persona', zh: '角色设定 (Persona)' },
    'World Info / Scenario': { en: 'World Info / Scenario', zh: '世界设定 / 场景' },
    'API Endpoint': { en: 'API Endpoint (e.g. https://api.openai.com/v1)', zh: 'API Endpoint (如: https://api.openai.com/v1)' },
    'Memory API Endpoint': { en: 'Memory API Endpoint', zh: '记忆提取 API Endpoint (可选)' },
    'API Key': { en: 'API Key', zh: 'API Key' },
    'Memory API Key': { en: 'Memory API Key', zh: '记忆提取 API Key (可选)' },
    'Model Name': { en: 'Model Name (e.g. gpt-4o)', zh: '聊天模型名称 (例如: gpt-4o)' },
    'Memory Model Name': { en: 'Memory Model Name', zh: '记忆模型 (建议: o1-mini等推理模型)' },
    'Fetch Models': { en: 'Fetch List', zh: '拉取列表' },
    'System Guidelines': { en: 'System Guidelines (Mandatory logic for background events)', zh: '系统准则 (后台事件运行的强制逻辑)' },
    'Advanced Config': { en: 'Advanced Engine Configuration', zh: '高级引擎配置' },
    'Max Output Tokens': { en: 'Max Output Tokens', zh: '最大输出 Token 限制' },

    // Systems Toggles
    'Disable Background Engine': { en: '🚨 Disable Entire Background Engine (Sleep Mode)', zh: '🚨 禁用该角色的所有后台活动 (休眠模式)' },
    'Toggle Proactive Messages': { en: 'Enable Proactive Messaging (Random initiated messages)', zh: '开启主动发消息 (随机发起话题)' },
    'Toggle Timer Actions': { en: 'Enable Self-Scheduled Timers ([TIMER] tags)', zh: '允许角色自定义等待时间 (使用 [TIMER] 标签)' },
    'Toggle Pressure System': { en: 'Enable Pressure System (Panic mode if ignored)', zh: '开启情绪压力系统 (被无视时会感到焦虑)' },
    'Toggle Jealousy System': { en: 'Enable Jealousy System (Interruption when talking to others)', zh: '开启吃醋系统 (同别人聊天时有概率打断)' },

    // Chat & Drawers
    'Chat Settings': { en: 'Chat Settings', zh: '聊天设置' },
    'Memories': { en: 'Memories', zh: '潜意识记忆' },
    'Secret Diary': { en: 'Secret Diary', zh: '私密日记本' },
    'Send Transfer': { en: 'Send Transfer', zh: '发送转账/红包' },
    'Hide Old Messages': { en: 'Hide Old Messages', zh: '隐藏旧消息' },
    'No moments yet': { en: 'No moments yet. Your friends are quiet today.', zh: '还没有任何动态哦。' },
    'Share something new': { en: 'Share something new...', zh: '说点什么...' },
    'Post': { en: 'Post', zh: '发布' },
    'Type a message': { en: 'Type a message...', zh: '输入消息...' },
    'Connecting': { en: 'Connecting...', zh: '连接中...' },
    'Thinking': { en: 'Thinking...', zh: '对方正在输入...' },
    'Typing': { en: 'typing...', zh: '正在输入...' },

    // Diary & Memory specific
    'Unlock Diary': { en: 'Unlock Secret Diary', zh: '解锁私密日记' },
    'Diary Locked': { en: 'Diary is Locked 🔒', zh: '日记已锁定 🔒' },
    'Password': { en: 'Password', zh: '密码' },
    'Unlock': { en: 'Unlock', zh: '解锁' },
    'No entries yet': { en: 'No entries yet...', zh: '暂无记录...' },
    'No memories yet': { en: 'No memories yet...', zh: '暂无记忆...' },
    'Significance': { en: 'Significance', zh: '重要程度' },
    'Impact': { en: 'Impact', zh: '影响' },

    // Comments & Likes
    'Like': { en: 'Like', zh: '赞' },
    'Unlike': { en: 'Unlike', zh: '取消赞' },
    'Comment': { en: 'Comment', zh: '评论' },
    'Reply': { en: 'Reply...', zh: '回复...' },

    // Form Errors
    'Required fields missing': { en: 'Please fill in Name, Persona, API Endpoint, API Key, and Model.', zh: '请填写名称、角色设定、API Endpoint、API Key 和模型名称。' },
    'Failed to add character': { en: 'Failed to add character', zh: '添加角色失败' },
    'Failed to clear history': { en: 'Failed to clear history', zh: '清除历史记录失败' },
    'History cleared': { en: 'History cleared', zh: '历史记录已清除' },
    'Are you sure clear history': { en: 'Are you sure you want to clear this chat history?', zh: '确定要清除此聊天记录吗？' }
};

export const LanguageProvider = ({ children }) => {
    const [lang, setLang] = useState(() => {
        return localStorage.getItem('chatpulse_lang') || 'zh';
    });

    useEffect(() => {
        localStorage.setItem('chatpulse_lang', lang);
    }, [lang]);

    const toggleLanguage = () => {
        setLang(prev => (prev === 'en' ? 'zh' : 'en'));
    };

    const t = (key) => {
        if (!translations[key]) return key;
        return translations[key][lang] || key;
    };

    return (
        <LanguageContext.Provider value={{ lang, toggleLanguage, t }}>
            {children}
        </LanguageContext.Provider>
    );
};

export const useLanguage = () => useContext(LanguageContext);
