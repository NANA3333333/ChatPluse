import AdminDashboard from './components/AdminDashboard';
import CityLog from './plugins/city/CityLog';
import { Shield, Activity } from 'lucide-react';

// Centralized registry for frontend plugins that are currently wired into the app.
export const plugins = [
    {
        id: 'admin',
        name_en: 'Admin Dashboard',
        name_zh: '管理员后台',
        icon: Shield,
        component: AdminDashboard,
        color: 'var(--accent-color)',
        condition: (userProfile) => userProfile?.username === 'Nana',
        position: 'bottom'
    },
    {
        id: 'city',
        name_en: 'The City',
        name_zh: '商业街',
        icon: Activity,
        component: CityLog,
        color: '#ff9800',
        position: 'top'
    }
];
