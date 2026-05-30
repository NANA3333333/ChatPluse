import { lazy } from 'react';
import { Shield, Activity, Building2, FlaskConical, Map } from 'lucide-react';

const AdminDashboard = lazy(() => import('./components/AdminDashboard'));
const CityLog = lazy(() => import('./plugins/city/CityLog'));
const HousingSocialPanel = lazy(() => import('./plugins/socialHousing/HousingSocialPanel'));
const McpLabPanel = lazy(() => import('./plugins/mcpLab/McpLabPanel'));
const PixelWorldPanel = lazy(() => import('./plugins/pixelWorld/PixelWorldPanel'));

export const plugins = [
  {
    id: 'mcp_lab',
    name_en: 'MCP Lab',
    name_zh: 'MCP 实验台',
    icon: FlaskConical,
    component: McpLabPanel,
    color: '#8b5cf6',
    position: 'experiment'
  },
  {
    id: 'admin',
    name_en: 'Admin Dashboard',
    name_zh: '\u7ba1\u7406\u5458\u540e\u53f0',
    icon: Shield,
    component: AdminDashboard,
    color: 'var(--accent-color)',
    condition: (userProfile) => userProfile?.role === 'root' || userProfile?.role === 'admin',
    position: 'bottom'
  },
  {
    id: 'housing_social',
    name_en: 'Housing & Social',
    name_zh: '\u4f4f\u623f\u4e0e\u793e\u4ea4',
    icon: Building2,
    component: HousingSocialPanel,
    color: '#f97316',
    position: 'top'
  },
  {
    id: 'pixel_world',
    name_en: 'Pixel World',
    name_zh: '\u50cf\u7d20\u5b9e\u88c5',
    icon: Map,
    component: PixelWorldPanel,
    color: '#f58bb8',
    position: 'top'
  },
  {
    id: 'city',
    name_en: 'The City',
    name_zh: '\u5546\u4e1a\u8857',
    icon: Activity,
    component: CityLog,
    color: '#ff9800',
    position: 'top'
  }
];
