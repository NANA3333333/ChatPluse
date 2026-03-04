import AdminDashboard from './components/AdminDashboard';
import { Shield } from 'lucide-react';

// Centralised registry for Frontend DLCs
export const plugins = [
    {
        id: 'admin',
        name_en: 'Admin Dashboard',
        name_zh: '管理后台',
        icon: Shield,
        component: AdminDashboard,
        color: 'var(--accent-color)',
        condition: (userProfile) => userProfile?.username === 'Nana',
        position: 'bottom' // 'top' or 'bottom' nav group
    }
];
