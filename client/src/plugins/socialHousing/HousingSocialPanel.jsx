import React, { useEffect, useMemo, useState } from 'react';

const text = {
  title: '住房与社交',
  subtitle: '这里管理中介可以推销的房子、社交阶级、角色绑定和中介所 AI。',
  sellableHomes: '可推销房子',
  classes: '阶级模板',
  roleBinding: '角色绑定',
  agencyAi: '中介所 AI',
  agencyHint: '左边配中介，右边直接挑它能拿去发广告的房子。',
  loading: '住房与社交模块加载中...',
  loadFailed: '住房与社交模块加载失败',
  requestFailed: '请求失败 ',
  save: '保存配置',
  run: '手动执行',
  retry: '重新生成',
  clearError: '删除报错',
  enable: '启用中介所',
  disable: '关闭中介所',
  lastAd: '上次广告',
  nextAd: '下次广告',
  lastFailure: '上次失败',
  noAds: '还没有广告记录。',
  published: '已公告',
  manual: '手动',
  auto: '自动',
  agencyFailed: '中介所 AI 执行失败：',
  officeName: '门店名称',
  agentName: '顾问名称',
  officeDistrict: '门店分区',
  businessScope: '业务范围',
  intervalHours: '决策间隔（小时）',
  autoModel: '自动选择可用 API',
  autoModelWithCount: '自动选择可用 API',
  adStyle: '广告风格',
  prompt: '人格提示，可留空',
  applyStyle: '套用风格',
  inventoryHint: '这些是中介 AI 可以拿来推销的房子。它每次会从这里挑一套房子出广告。',
  priceHint: '广告必须带价格，没写价格就会重新生成。',
  catalog: '可推销房子',
  catalogHint: '点卡片直接加入中介可推销列表；已经在列表里的，点一下就直接编辑。',
  custom: '自定义',
  hideCustom: '收起自定义',
  addHome: '新增房子',
  saveEdit: '保存编辑',
  cancel: '取消编辑',
  edit: '编辑',
  remove: '删除',
  removeAd: '删除记录',
  enabledState: '启用中',
  disabledState: '已停用',
  homeName: '房子名字',
  weeklyRent: '每周租金',
  deposit: '押金',
  buyout: '售价/买断价',
  comfort: '舒适度',
  prestige: '体面感',
  privacy: '隐私感',
  sortOrder: '显示排序',
  desc: '介绍',
  id: 'ID',
  emoji: 'Emoji',
  applyHome: '加入可推销列表',
  applyExistingHome: '已在列表中，去编辑',
  homeApplied: '这套房子已经加入已保存的房子，中介 AI 现在可以直接拿它发广告。',
  homeOpened: '这套房子已经在列表里了，我已经帮你打开编辑。',
  modalCustomHome: '自定义房子',
  modalEditHome: '编辑房子',
  emptyHomes: '还没有可推销的房子。',
  className: '名称',
  workBias: '工作倾向',
  consumptionBias: '消费倾向',
  prestigeBias: '体面倾向',
  socialBarrier: '社交门槛',
  commonLocations: '常去地点，用逗号分隔',
  addClass: '新增阶级模板',
  wallet: '钱包',
  unknown: 'unknown',
  idle: 'idle',
  unboundClass: '未绑定阶级',
  unboundHousing: '未绑定住房',
  stable: '稳定居住',
  temporary: '临时落脚',
  unstable: '居住不稳',
  overdue: '租金拖欠',
  note: '备注',
  rentDue: '催租日',
  nextRentDue: '下次催租',
  missedRent: '拖欠次数',
  payRent: '交房租',
  rentPressure: '租房压力',
  bearable: '可承受',
  high: '偏高',
  independent: '独立绑定',
  saving: '保存中...',
  untriggered: '未触发',
  agencyPlaceholder: '商业街'
};

const homePresets = [
  { key: 'old_apartment_chunheli', title: '老破小', subtitle: '春和里 4栋302', values: { id: 'old_apartment_chunheli_4_302', name: '春和里小区 4栋302', emoji: '🏚️', weekly_rent: 22, deposit: 40, sale_price: 380, comfort: 8, prestige: 2, privacy: 4, description: '一室一厅，老式水泥楼，五楼步梯，屋里采光一般但通风还行。家具旧，墙皮有点起鼓，厨房很小，卫生间是老式布局。优点是便宜、离便利店近、对刚落脚的人压力最小；缺点是压抑、隔音差、夏天闷、体面感很弱。' } },
  { key: 'shared_room_xinyuan', title: '合租单间', subtitle: '欣园公寓 2单元801-A室', values: { id: 'shared_room_xinyuan_2_801', name: '欣园公寓 2单元801-A室', emoji: '🛏️', weekly_rent: 28, deposit: 60, sale_price: 0, comfort: 12, prestige: 6, privacy: 8, description: '三室一厅里的朝南次卧，简约出租房风格，床、衣柜、书桌都有，公共区域和另外两位租客共用。优点是预算友好、生活机能方便、房间基本齐全；缺点是要看室友脸色，做饭和洗澡高峰期会挤，真正的私人空间有限。' } },
  { key: 'shared_flat_jingan', title: '普通合租', subtitle: '静安新村 6栋502', values: { id: 'shared_flat_jingan_6_502', name: '静安新村 6栋502', emoji: '🏠', weekly_rent: 35, deposit: 80, sale_price: 0, comfort: 18, prestige: 10, privacy: 14, description: '两室一厅标准合租，日常居住氛围比较稳定，客厅和厨房都能正常使用，装修是普通白墙木地板风格。优点是住法最常见、性价比稳、位置不偏；缺点是没什么惊喜，房子本身偏普通，谈不上特别舒服或特别有面子。' } },
  { key: 'studio_yuecheng', title: '独立公寓', subtitle: '悦城公馆 11楼1107', values: { id: 'studio_yuecheng_11_1107', name: '悦城公馆 11楼1107', emoji: '🏢', weekly_rent: 58, deposit: 120, sale_price: 980, comfort: 28, prestige: 22, privacy: 24, description: '一室户带独立卫浴和小厨房，现代简装，采光不错，晚上回家会有比较完整的个人空间。优点是安静、独处感强、适合想把生活收回自己手里的人；缺点是租金明显更高，空间不算大，长期住会开始在意收纳。' } },
  { key: 'riverside_lanwan', title: '江景公寓', subtitle: '澜湾国际 17楼1703', values: { id: 'riverside_lanwan_17_1703', name: '澜湾国际 17楼1703', emoji: '🌉', weekly_rent: 95, deposit: 220, sale_price: 1680, comfort: 40, prestige: 38, privacy: 32, description: '两室一厅带大落地窗，偏现代轻奢风，客厅能看到江景，白天和夜景都很能撑场面。优点是舒适、体面、很适合约人来家里坐；缺点是贵，生活成本会被整体抬高，住进去之后很难再接受太差的房子。' } },
  { key: 'luxury_loft_jinyu', title: '高档 loft', subtitle: '金域中心 23楼2301', values: { id: 'luxury_loft_jinyu_23_2301', name: '金域中心 23楼2301 loft', emoji: '🌇', weekly_rent: 150, deposit: 360, sale_price: 2880, comfort: 48, prestige: 55, privacy: 38, description: '挑高 loft，两层分区明显，下层会客、上层休息，整体偏深色高端都市风，电梯厅和物业都很讲排面。优点是圈层感强、很适合做身份展示、拍照和待客都上镜；缺点是租金和押金都高，对收入和消费习惯要求也高。' } }
];

const promptStyles = [
  { key: 'street', label: '街头招揽', prompt: '你像商业街口发传单的中介一样说话，语气直接、接地气、能快速把价格和房子优点说清楚。' },
  { key: 'warm', label: '温和推荐', prompt: '你像认真替人找房的顾问一样说话，先把房子适合谁讲清楚，再自然带出价格和卖点。' },
  { key: 'budget', label: '穷人友好', prompt: '你主打低预算租客，广告里优先强调租金、押金、性价比和适合刚落脚的人。' },
  { key: 'luxury', label: '体面高端', prompt: '你主打体面和高端感，广告里优先强调地段、空间、圈层感和价格。' },
  { key: 'sellfast', label: '急租/急售', prompt: '你像急租急售的中介，广告简短有力，必须先报价格，再说房型和核心卖点。' }
];

const defaultDistrictOptions = [
  { id: 'street', name: '商业街' },
  { id: 'home', name: '家' },
  { id: 'restaurant', name: '餐厅' },
  { id: 'convenience', name: '便利店' },
  { id: 'park', name: '中央公园' },
  { id: 'mall', name: '商场' },
  { id: 'school', name: '夜校' },
  { id: 'hospital', name: '医院' },
  { id: 'factory', name: '工厂' },
  { id: 'casino', name: '地下赌场' },
  { id: 'hacker', name: '黑客据点' }
];

const shell = {
  page: { display: 'flex', flexDirection: 'column', gap: 20, padding: 24 },
  card: { background: '#fff', border: '1px solid #f3d7be', borderRadius: 18, padding: 16 },
  input: { width: '100%', borderRadius: 10, border: '1px solid #d9dce7', padding: '9px 11px', fontSize: 13, background: '#fff' },
  btn: { border: 'none', borderRadius: 10, padding: '9px 12px', fontSize: 13, cursor: 'pointer', lineHeight: 1.2 }
};

const tones = {
  primaryBtn: { background: '#dbeafe', color: '#1d4ed8' },
  tealBtn: { background: '#d1fae5', color: '#0f766e' },
  orangeBtn: { background: '#ffedd5', color: '#c2410c' },
  redBtn: { background: '#fee2e2', color: '#dc2626' },
  grayBtn: { background: '#f1f5f9', color: '#475569' }
};

const emptyHome = { id: '', name: '', emoji: '', description: '', weekly_rent: 0, deposit: 0, sale_price: 0, comfort: 0, prestige: 0, privacy: 0, is_enabled: 1, sort_order: 0 };
const emptyClass = { id: '', name: '', emoji: '', description: '', work_bias: 0, consumption_bias: 0, prestige_bias: 0, social_barrier: 0, common_locations: '', is_enabled: 1, sort_order: 0 };
const emptyAgency = { enabled: 1, agency_name: '', agent_name: '', office_district: 'street', business_scope: '', persona_prompt: '', decision_interval_hours: 6, model_char_id: 'auto', next_ad_at: 0, last_ad_at: 0, last_error: '', last_error_at: 0 };

function formatMoney(value) { const num = Number(value || 0); return Number.isFinite(num) ? num.toFixed(2).replace(/\.00$/, '').replace(/(\.\d)0$/, '$1') : '0'; }
function formatTime(value) { if (!value) return text.untriggered; try { return new Date(Number(value)).toLocaleString('zh-CN'); } catch { return text.untriggered; } }
function toNum(value, fallback = 0) { const num = Number(value); return Number.isFinite(num) ? num : fallback; }
function summarizeAgencyError(value) {
  const raw = String(value || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!raw) return '';
  return raw.length > 320 ? `${raw.slice(0, 320)}...` : raw;
}
function Pill({ children, bg = '#f8fafc', color = '#475569' }) { return <span style={{ background: bg, color, borderRadius: 999, padding: '5px 9px', fontSize: 12, lineHeight: 1.2 }}>{children}</span>; }
function Section({ title, extra, children }) { return <div style={shell.card}><div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center', marginBottom: 12 }}><div style={{ fontSize: 16, fontWeight: 800, color: '#334155' }}>{title}</div>{extra ? <div style={{ color: '#94a3b8', fontSize: 12 }}>{extra}</div> : null}</div>{children}</div>; }
function Field({ label, children, span = false }) { return <label style={{ display: 'flex', flexDirection: 'column', gap: 5, gridColumn: span ? '1 / -1' : 'auto' }}><span style={{ fontSize: 12, color: '#64748b', fontWeight: 600 }}>{label}</span>{children}</label>; }

export default function HousingSocialPanel() {
  const [loading, setLoading] = useState(true);
  const [housingTiers, setHousingTiers] = useState([]);
  const [classes, setClasses] = useState([]);
  const [characters, setCharacters] = useState([]);
  const [districts, setDistricts] = useState([]);
  const [agencyModelOptions, setAgencyModelOptions] = useState([]);
  const [agencyAds, setAgencyAds] = useState([]);
  const [publicAgencyAnnouncements, setPublicAgencyAnnouncements] = useState([]);
  const [agencyForm, setAgencyForm] = useState(emptyAgency);
  const [homeForm, setHomeForm] = useState(emptyHome);
  const [classForm, setClassForm] = useState(emptyClass);
  const [editingHomeId, setEditingHomeId] = useState('');
  const [editingClassId, setEditingClassId] = useState('');
  const [savingBindingId, setSavingBindingId] = useState('');
  const [savingAgency, setSavingAgency] = useState(false);
  const [publishingAgency, setPublishingAgency] = useState(false);
  const [agencyError, setAgencyError] = useState('');
  const [agencyTemplateKey, setAgencyTemplateKey] = useState('street');
  const [showCustomHomeEditor, setShowCustomHomeEditor] = useState(false);
  const [homeNotice, setHomeNotice] = useState('');

  const headers = useMemo(() => {
    const token = localStorage.getItem('cp_token') || '';
    return { 'Content-Type': 'application/json', Authorization: token ? `Bearer ${token}` : '' };
  }, []);

  const housingById = useMemo(() => new Map(housingTiers.map((item) => [String(item.id), item])), [housingTiers]);
  const savedHomeIds = useMemo(() => new Set(housingTiers.map((item) => String(item.id))), [housingTiers]);
  const classById = useMemo(() => new Map(classes.map((item) => [String(item.id), item])), [classes]);
  const resolvedDistrictOptions = useMemo(() => {
    if (Array.isArray(districts) && districts.length > 0) return districts;
    return defaultDistrictOptions;
  }, [districts]);
  const resolvedAgencyModelOptions = useMemo(() => {
    const normalized = Array.isArray(agencyModelOptions) ? agencyModelOptions.filter(Boolean) : [];
    if (normalized.length > 0) return normalized;
    return characters
      .filter((item) => item?.api_endpoint && item?.api_key && item?.model_name)
      .map((item) => ({
        id: String(item.id),
        name: String(item.name || item.id),
        model_name: String(item.model_name || ''),
        api_endpoint: String(item.api_endpoint || '')
      }));
  }, [agencyModelOptions, characters]);

  async function requestJson(url, options = {}) {
    const response = await fetch(url, options);
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.success === false) throw new Error(data.error || `${text.requestFailed}${response.status}`);
    return data;
  }

  async function loadAll() {
    setLoading(true);
    try {
      const data = await requestJson('/api/social-housing/bootstrap', { headers });
      setHousingTiers(data.housing_tiers || []);
      setClasses(data.classes || []);
      setCharacters(data.characters || []);
      setDistricts(data.districts || []);
      setAgencyModelOptions(data.agency_model_options || []);
      setAgencyAds(data.agency_ads || []);
      setPublicAgencyAnnouncements(data.public_agency_announcements || []);
      setAgencyForm({ ...emptyAgency, ...(data.agency || {}) });
      setAgencyError(data.agency?.last_error || '');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { loadAll().catch((e) => { console.error(e); alert(e.message || text.loadFailed); }); }, []);

  const saveHome = async (payload = homeForm) => {
    const data = await requestJson('/api/social-housing/housing', { method: 'POST', headers, body: JSON.stringify(payload) });
    setHousingTiers(data.housing_tiers || []);
    setHomeForm(emptyHome); setEditingHomeId(''); setShowCustomHomeEditor(false);
  };
  const saveClass = async (payload = classForm) => {
    const data = await requestJson('/api/social-housing/classes', { method: 'POST', headers, body: JSON.stringify({ ...payload, common_locations: payload.common_locations }) });
    setClasses(data.classes || []); setClassForm(emptyClass); setEditingClassId('');
  };
  const deleteHome = async (id) => { await requestJson(`/api/social-housing/housing/${id}`, { method: 'DELETE', headers }); await loadAll(); };
  const deleteClass = async (id) => { await requestJson(`/api/social-housing/classes/${id}`, { method: 'DELETE', headers }); await loadAll(); };
  const deleteAgencyAd = async (id) => { await requestJson(`/api/social-housing/agency/ads/${id}`, { method: 'DELETE', headers }); await loadAll(); };
  const updateBinding = async (id, binding) => { setSavingBindingId(id); try { const data = await requestJson(`/api/social-housing/characters/${id}/binding`, { method: 'POST', headers, body: JSON.stringify(binding) }); setCharacters(data.characters || []); } finally { setSavingBindingId(''); } };
  const payRent = async (id) => { setSavingBindingId(id); try { const data = await requestJson(`/api/social-housing/characters/${id}/pay-rent`, { method: 'POST', headers }); setCharacters(data.characters || []); } finally { setSavingBindingId(''); } };
  const saveAgency = async (payload = agencyForm) => { setSavingAgency(true); setAgencyError(''); try { const data = await requestJson('/api/social-housing/agency', { method: 'POST', headers, body: JSON.stringify(payload) }); setAgencyForm({ ...emptyAgency, ...(data.agency || {}) }); } catch (e) { setAgencyError(e.message || 'agency failed'); throw e; } finally { setSavingAgency(false); } };
  const publishAgency = async () => { setPublishingAgency(true); setAgencyError(''); try { await requestJson('/api/social-housing/agency/publish-ad', { method: 'POST', headers }); await loadAll(); } catch (e) { setAgencyError(e.message || 'ad failed'); throw e; } finally { setPublishingAgency(false); } };
  const clearAgencyError = async () => {
    const payload = { ...agencyForm, last_error: '', last_error_at: 0 };
    const data = await requestJson('/api/social-housing/agency', { method: 'POST', headers, body: JSON.stringify(payload) });
    setAgencyForm({ ...emptyAgency, ...(data.agency || {}) });
    setAgencyError('');
  };
  const updateAgencyField = (key, value) => setAgencyForm((prev) => ({ ...prev, [key]: value }));
  const saveAgencyField = async (key, value) => {
    const next = { ...agencyForm, [key]: value };
    setAgencyForm(next);
    await saveAgency(next);
  };

  const applyHomePreset = async (preset) => {
    const existing = housingTiers.find((item) => String(item.id) === String(preset.values.id));
    if (existing) {
      beginEditHome(existing);
      setHomeNotice(text.homeOpened);
      return;
    }
    await saveHome({ ...emptyHome, ...preset.values });
    setHomeNotice(text.homeApplied);
  };
  const beginEditHome = (item) => { setEditingHomeId(String(item.id)); setHomeForm({ ...emptyHome, ...item }); setShowCustomHomeEditor(true); };
  const applyAgencyTemplate = (key) => { setAgencyTemplateKey(key); const preset = promptStyles.find((item) => item.key === key); if (preset) setAgencyForm((prev) => ({ ...prev, persona_prompt: preset.prompt })); };

  const visibleAgencyAds = useMemo(() => agencyAds || [], [agencyAds]);

  if (loading) return <div style={{ padding: 24, color: '#64748b' }}>{text.loading}</div>;

  return (
    <div style={shell.page}>
      <Section title={text.title} extra={`${text.sellableHomes} ${housingTiers.length} | ${text.classes} ${classes.length}`}>
        <div style={{ color: '#64748b', fontSize: 13 }}>{text.subtitle}</div>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 12 }}><Pill>{text.stable} {characters.filter((c) => String(c.binding?.housing_status || 'stable') === 'stable').length}</Pill><Pill bg="#fff1f2" color="#be123c">{text.overdue} {characters.filter((c) => String(c.binding?.housing_status || '') === 'overdue').length}</Pill></div>
      </Section>

      <Section title={text.agencyAi} extra={`${text.lastAd} ${formatTime(agencyForm.last_ad_at)}`}>
        <div style={{ color: '#64748b', fontSize: 13, lineHeight: 1.55, marginBottom: 12 }}>{text.agencyHint}<div>{text.priceHint}</div></div>
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(360px, 1.05fr) minmax(420px, 1fr)', gap: 18, alignItems: 'stretch' }}>
          <div style={{ display: 'grid', gap: 14, alignContent: 'start' }}>
            <div style={{ ...shell.card, borderColor: '#e7edf5', padding: 16 }}>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                <Field label={text.officeName}><input style={shell.input} value={agencyForm.agency_name || ''} onChange={(e) => setAgencyForm((p) => ({ ...p, agency_name: e.target.value }))} /></Field>
                <Field label={text.agentName}><input style={shell.input} value={agencyForm.agent_name || ''} onChange={(e) => setAgencyForm((p) => ({ ...p, agent_name: e.target.value }))} /></Field>
                <Field label={text.officeDistrict}><select style={shell.input} value={agencyForm.office_district || 'street'} onChange={(e) => saveAgencyField('office_district', e.target.value).catch((err) => alert(err.message))}>{resolvedDistrictOptions.map((item) => <option key={item.id} value={item.id}>{item.name || item.id}</option>)}</select></Field>
                <Field label={`${text.autoModel}（${resolvedAgencyModelOptions.length} 个）`}><select style={shell.input} value={agencyForm.model_char_id || 'auto'} onChange={(e) => saveAgencyField('model_char_id', e.target.value).catch((err) => alert(err.message))}>{[{ id: 'auto', name: text.autoModel, model_name: '' }, ...resolvedAgencyModelOptions].map((item) => <option key={item.id} value={item.id}>{item.name}{item.model_name ? ` - ${item.model_name}` : ''}</option>)}</select></Field>
                <Field label={text.businessScope}><input style={shell.input} value={agencyForm.business_scope || ''} onChange={(e) => updateAgencyField('business_scope', e.target.value)} /></Field>
                <Field label={text.intervalHours}><input style={shell.input} type="number" min="1" value={agencyForm.decision_interval_hours || 6} onChange={(e) => setAgencyForm((p) => ({ ...p, decision_interval_hours: toNum(e.target.value, 6) }))} /></Field>
                <Field label={text.adStyle}><div style={{ display: 'flex', gap: 8 }}><select style={shell.input} value={agencyTemplateKey} onChange={(e) => setAgencyTemplateKey(e.target.value)}>{promptStyles.map((item) => <option key={item.key} value={item.key}>{item.label}</option>)}</select><button style={{ ...shell.btn, background: '#e0f2fe', color: '#0369a1', whiteSpace: 'nowrap' }} onClick={() => applyAgencyTemplate(agencyTemplateKey)}>{text.applyStyle}</button></div></Field>
                <Field label={text.prompt} span><textarea style={{ ...shell.input, minHeight: 96, resize: 'vertical' }} value={agencyForm.persona_prompt || ''} onChange={(e) => updateAgencyField('persona_prompt', e.target.value)} /></Field>
              </div>
              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 12 }}><button style={{ ...shell.btn, ...(Number(agencyForm.enabled || 0) === 1 ? tones.redBtn : tones.tealBtn) }} onClick={() => saveAgency({ ...agencyForm, enabled: Number(agencyForm.enabled || 0) === 1 ? 0 : 1 }).catch((e) => alert(e.message))}>{Number(agencyForm.enabled || 0) === 1 ? text.disable : text.enable}</button><button style={{ ...shell.btn, ...tones.tealBtn }} onClick={() => saveAgency().catch((e) => alert(e.message))}>{savingAgency ? text.saving : text.save}</button><button style={{ ...shell.btn, ...tones.orangeBtn }} onClick={() => publishAgency().catch((e) => alert(e.message))}>{publishingAgency ? text.saving : text.run}</button>{agencyError ? <button style={{ ...shell.btn, background: '#ede9fe', color: '#6d28d9' }} onClick={() => publishAgency().catch((e) => alert(e.message))}>{text.retry}</button> : null}</div>
              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 12 }}><Pill>{text.nextAd} {formatTime(agencyForm.next_ad_at)}</Pill>{agencyForm.last_error_at ? <Pill bg="#fff1f2" color="#be123c">{text.lastFailure} {formatTime(agencyForm.last_error_at)}</Pill> : null}</div>
              {agencyError ? (
                <div style={{ marginTop: 12, background: '#fff1f2', color: '#be123c', border: '1px solid #fecdd3', borderRadius: 14, padding: 12 }}>
                  <div style={{ fontWeight: 700, marginBottom: 8 }}>{text.agencyFailed}</div>
                  <div style={{ fontSize: 13, lineHeight: 1.7 }}>{summarizeAgencyError(agencyError)}</div>
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 10 }}>
                    <button style={{ ...shell.btn, background: '#ede9fe', color: '#6d28d9', padding: '8px 12px', fontSize: 12 }} onClick={() => publishAgency().catch((e) => alert(e.message))}>{text.retry}</button>
                    <button style={{ ...shell.btn, ...tones.redBtn, padding: '8px 12px', fontSize: 12 }} onClick={() => clearAgencyError().catch((e) => alert(e.message))}>{text.clearError}</button>
                  </div>
                </div>
              ) : null}
            </div>
            <div style={{ display: 'grid', gap: 12 }}>
              {visibleAgencyAds.length ? visibleAgencyAds.map((ad) => (
                <div key={ad.id} style={{ border: '1px solid #e7edf5', borderRadius: 16, padding: 14, background: '#fff', boxShadow: '0 10px 30px rgba(15,23,42,0.04)' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'flex-start' }}>
                    <div style={{ fontWeight: 800, color: '#2563eb', fontSize: 15 }}>{ad.title || text.noAds}</div>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                      <Pill bg={ad.trigger_type === 'auto' ? '#eff6ff' : '#f8fafc'} color={ad.trigger_type === 'auto' ? '#1d4ed8' : '#475569'}>{ad.trigger_type === 'auto' ? text.auto : text.manual}</Pill>
                      {Number(ad.is_published ? 1 : 0) === 1 ? <Pill bg="#dcfce7" color="#166534">{text.published}</Pill> : null}
                      <button style={{ ...shell.btn, ...tones.redBtn, padding: '7px 10px', fontSize: 12 }} onClick={() => deleteAgencyAd(ad.id).catch((e) => alert(e.message))}>{text.removeAd}</button>
                    </div>
                  </div>
                  <div style={{ marginTop: 8, color: '#475569', fontSize: 13, lineHeight: 1.65 }}>{ad.content}</div>
                </div>
              )) : <div style={{ color: '#94a3b8', fontSize: 13 }}>{text.noAds}</div>}
            </div>
          </div>
          <div style={{ ...shell.card, borderColor: '#e7edf5', padding: 16, display: 'flex', flexDirection: 'column' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'flex-start', marginBottom: 12, flexWrap: 'wrap' }}>
              <div>
                <div style={{ fontSize: 16, fontWeight: 800, color: '#334155' }}>{text.catalog}</div>
                <div style={{ color: '#64748b', fontSize: 13, lineHeight: 1.55, marginTop: 6 }}>{text.catalogHint}</div>
              </div>
              <button style={{ ...shell.btn, ...tones.grayBtn, border: '1px solid #dbeafe' }} onClick={() => { setEditingHomeId(''); setHomeForm(emptyHome); setShowCustomHomeEditor(true); }}>{text.custom}</button>
            </div>
            {homeNotice ? <div style={{ marginBottom: 12, background: '#eff6ff', color: '#1d4ed8', border: '1px solid #bfdbfe', borderRadius: 14, padding: '10px 12px', fontSize: 14 }}>{homeNotice}</div> : null}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12 }}>
              {homePresets.map((preset) => (
                <div key={preset.key} style={{ border: '1px solid #e7edf5', borderRadius: 16, padding: 14, background: '#fff', boxShadow: '0 10px 30px rgba(15,23,42,0.04)', display: 'flex', flexDirection: 'column', minHeight: 300 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'flex-start' }}>
                    <div>
                      <div style={{ fontWeight: 800, color: '#2563eb', fontSize: 16 }}>{preset.values.emoji} {preset.title}</div>
                      <div style={{ color: '#64748b', fontSize: 12, marginTop: 4 }}>{preset.subtitle}</div>
                    </div>
                    <Pill bg="#eff6ff" color="#1d4ed8">{formatMoney(preset.values.weekly_rent)}/周</Pill>
                  </div>
                  <div style={{ color: '#475569', fontSize: 13, lineHeight: 1.65, marginTop: 12, flex: 1, minHeight: 108, maxHeight: 130, overflow: 'hidden' }}>{preset.values.description}</div>
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 12 }}>
                    <Pill>{text.deposit} {formatMoney(preset.values.deposit)}</Pill>
                    <Pill>{text.buyout} {formatMoney(preset.values.sale_price)}</Pill>
                    <Pill>{text.comfort} {preset.values.comfort}</Pill>
                  </div>
                  <button style={{ ...shell.btn, marginTop: 14, ...tones.primaryBtn, width: '100%' }} onClick={() => applyHomePreset(preset).catch((e) => alert(e.message))}>{savedHomeIds.has(String(preset.values.id)) ? text.applyExistingHome : text.applyHome}</button>
                </div>
              ))}
            </div>
            <div style={{ marginTop: 14, color: '#94a3b8', fontSize: 12, lineHeight: 1.5 }}>点上面的卡片直接加入或编辑，不再在下面重复列出启用中的房子。</div>
          </div>
        </div>
      </Section>

      <Section title={text.classes} extra={`${classes.length} 项`}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 12 }}><Field label={text.id}><input style={shell.input} value={classForm.id} onChange={(e) => setClassForm((p) => ({ ...p, id: e.target.value }))} /></Field><Field label={text.className}><input style={shell.input} value={classForm.name} onChange={(e) => setClassForm((p) => ({ ...p, name: e.target.value }))} /></Field><Field label={text.emoji}><input style={shell.input} value={classForm.emoji} onChange={(e) => setClassForm((p) => ({ ...p, emoji: e.target.value }))} /></Field><Field label={text.workBias}><input style={shell.input} type="number" value={classForm.work_bias} onChange={(e) => setClassForm((p) => ({ ...p, work_bias: toNum(e.target.value) }))} /></Field><Field label={text.consumptionBias}><input style={shell.input} type="number" value={classForm.consumption_bias} onChange={(e) => setClassForm((p) => ({ ...p, consumption_bias: toNum(e.target.value) }))} /></Field><Field label={text.prestigeBias}><input style={shell.input} type="number" value={classForm.prestige_bias} onChange={(e) => setClassForm((p) => ({ ...p, prestige_bias: toNum(e.target.value) }))} /></Field><Field label={text.socialBarrier}><input style={shell.input} type="number" value={classForm.social_barrier} onChange={(e) => setClassForm((p) => ({ ...p, social_barrier: toNum(e.target.value) }))} /></Field><Field label={text.sortOrder}><input style={shell.input} type="number" value={classForm.sort_order} onChange={(e) => setClassForm((p) => ({ ...p, sort_order: toNum(e.target.value) }))} /></Field><Field label={text.commonLocations} span><input style={shell.input} value={classForm.common_locations} onChange={(e) => setClassForm((p) => ({ ...p, common_locations: e.target.value }))} /></Field><Field label={text.desc} span><textarea style={{ ...shell.input, minHeight: 72, resize: 'vertical' }} value={classForm.description} onChange={(e) => setClassForm((p) => ({ ...p, description: e.target.value }))} /></Field></div>
        <div style={{ display: 'flex', gap: 10, marginTop: 12 }}><button style={{ ...shell.btn, background: '#ea580c', color: '#fff' }} onClick={() => saveClass().catch((e) => alert(e.message))}>{editingClassId ? text.saveEdit : text.addClass}</button>{editingClassId ? <button style={{ ...shell.btn, background: '#e2e8f0', color: '#334155' }} onClick={() => { setEditingClassId(''); setClassForm(emptyClass); }}>{text.cancel}</button> : null}</div>
        <div style={{ display: 'grid', gap: 12, marginTop: 12 }}>{classes.map((item) => <div key={item.id} style={{ border: '1px solid #e7edf5', borderRadius: 16, padding: 14 }}><div style={{ display: 'flex', justifyContent: 'space-between', gap: 10 }}><div style={{ fontWeight: 700, color: '#7c3aed' }}>{item.emoji || '🎭'} {item.name}</div><div style={{ display: 'flex', gap: 8 }}><button style={{ ...shell.btn, background: Number(item.is_enabled ?? 1) === 1 ? '#dcfce7' : '#f1f5f9', color: Number(item.is_enabled ?? 1) === 1 ? '#166534' : '#475569', padding: '8px 12px' }} onClick={() => saveClass({ ...item, common_locations: Array.isArray(item.common_locations) ? item.common_locations.join(', ') : '', is_enabled: Number(item.is_enabled ?? 1) === 1 ? 0 : 1 }).catch((e) => alert(e.message))}>{Number(item.is_enabled ?? 1) === 1 ? text.enabledState : text.disabledState}</button><button style={{ ...shell.btn, background: '#ede9fe', color: '#6d28d9', padding: '8px 12px' }} onClick={() => { setEditingClassId(String(item.id)); setClassForm({ ...emptyClass, ...item, common_locations: Array.isArray(item.common_locations) ? item.common_locations.join(', ') : '' }); }}>{text.edit}</button><button style={{ ...shell.btn, background: '#fee2e2', color: '#dc2626', padding: '8px 12px' }} onClick={() => deleteClass(item.id).catch((e) => alert(e.message))}>{text.remove}</button></div></div><div style={{ marginTop: 8, color: '#64748b', lineHeight: 1.6 }}>{item.description || '-'}</div></div>)}</div>
      </Section>

      <Section title={text.roleBinding} extra={`${characters.length} 个角色`}>
        <div style={{ display: 'grid', gap: 14 }}>{characters.map((character) => { const binding = character.binding || {}; const selectedHousing = housingById.get(String(binding.housing_id || '')) || binding.housing; const selectedClass = classById.get(String(binding.social_class_id || '')) || binding.social_class; return <div key={character.id} style={{ border: '1px solid #e7edf5', borderRadius: 16, padding: 14 }}><div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}><div><div style={{ fontWeight: 700, color: '#2563eb' }}>{character.name}</div><div style={{ color: '#64748b', fontSize: 14, marginTop: 6 }}>{text.wallet} {formatMoney(character.wallet)} | {character.location || text.unknown} | {character.city_status || text.idle}</div></div><div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}><button style={{ ...shell.btn, ...tones.orangeBtn, padding: '8px 12px', fontSize: 12 }} onClick={() => payRent(character.id).catch((err) => alert(err.message))}>{savingBindingId === character.id ? text.saving : text.payRent}</button><div style={{ color: '#94a3b8', fontSize: 13 }}>{savingBindingId === character.id ? text.saving : text.independent}</div></div></div><div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 12, marginTop: 12 }}><select style={shell.input} value={binding.social_class_id || ''} onChange={(e) => updateBinding(character.id, { ...binding, social_class_id: e.target.value }).catch((err) => alert(err.message))}><option value="">{text.unboundClass}</option>{classes.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select><select style={shell.input} value={binding.housing_id || ''} onChange={(e) => updateBinding(character.id, { ...binding, housing_id: e.target.value }).catch((err) => alert(err.message))}><option value="">{text.unboundHousing}</option>{housingTiers.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select><select style={shell.input} value={binding.housing_status || 'stable'} onChange={(e) => updateBinding(character.id, { ...binding, housing_status: e.target.value }).catch((err) => alert(err.message))}><option value="stable">{text.stable}</option><option value="temporary">{text.temporary}</option><option value="unstable">{text.unstable}</option><option value="overdue">{text.overdue}</option></select><input style={shell.input} type="number" value={binding.rent_weekly ?? 0} onChange={(e) => updateBinding(character.id, { ...binding, rent_weekly: toNum(e.target.value) }).catch((err) => alert(err.message))} placeholder={text.weeklyRent} /><input style={shell.input} type="number" value={binding.rent_due_day ?? 7} onChange={(e) => updateBinding(character.id, { ...binding, rent_due_day: toNum(e.target.value, 7) }).catch((err) => alert(err.message))} placeholder={text.rentDue} /><input style={shell.input} value={binding.note || ''} onChange={(e) => updateBinding(character.id, { ...binding, note: e.target.value }).catch((err) => alert(err.message))} placeholder={text.note} /></div><div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 12 }}><Pill>{text.className} {selectedClass?.name || text.unboundClass}</Pill><Pill>{text.homeName} {selectedHousing?.name || text.unboundHousing}</Pill><Pill>{text.deposit} {formatMoney(selectedHousing?.deposit || 0)}</Pill><Pill>{text.weeklyRent} {formatMoney(binding.rent_weekly || selectedHousing?.weekly_rent || 0)}</Pill><Pill>{text.nextRentDue} {formatTime(binding.rent_due_at)}</Pill><Pill>{text.missedRent} {binding.missed_rent_count || 0}</Pill><Pill bg={String(binding.housing_status || 'stable') === 'overdue' ? '#fff1f2' : '#eff6ff'} color={String(binding.housing_status || 'stable') === 'overdue' ? '#be123c' : '#1d4ed8'}>{text.rentPressure} {String(binding.housing_status || 'stable') === 'overdue' ? text.high : text.bearable}</Pill></div></div>; })}</div>
      </Section>
      {(showCustomHomeEditor || editingHomeId) ? (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.42)', zIndex: 50, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }} onClick={() => { setShowCustomHomeEditor(false); setEditingHomeId(''); setHomeForm(emptyHome); }}>
          <div style={{ width: 'min(860px, 100%)', maxHeight: '85vh', overflowY: 'auto', background: '#fff', borderRadius: 20, border: '1px solid #e7edf5', boxShadow: '0 20px 80px rgba(15,23,42,0.18)', padding: 20 }} onClick={(e) => e.stopPropagation()}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center', marginBottom: 14 }}>
              <div>
                <div style={{ fontSize: 20, fontWeight: 800, color: '#334155' }}>{editingHomeId ? text.modalEditHome : text.modalCustomHome}</div>
                <div style={{ color: '#94a3b8', fontSize: 13, marginTop: 4 }}>这里是少数情况才需要手动改的详细资料。</div>
              </div>
              <button style={{ ...shell.btn, ...tones.grayBtn }} onClick={() => { setShowCustomHomeEditor(false); setEditingHomeId(''); setHomeForm(emptyHome); }}>{text.cancel}</button>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 12 }}>
              <Field label={text.id}><input style={shell.input} value={homeForm.id} onChange={(e) => setHomeForm((p) => ({ ...p, id: e.target.value }))} /></Field>
              <Field label={text.homeName}><input style={shell.input} value={homeForm.name} onChange={(e) => setHomeForm((p) => ({ ...p, name: e.target.value }))} /></Field>
              <Field label={text.emoji}><input style={shell.input} value={homeForm.emoji} onChange={(e) => setHomeForm((p) => ({ ...p, emoji: e.target.value }))} /></Field>
              <Field label={text.weeklyRent}><input style={shell.input} type="number" value={homeForm.weekly_rent} onChange={(e) => setHomeForm((p) => ({ ...p, weekly_rent: toNum(e.target.value) }))} /></Field>
              <Field label={text.deposit}><input style={shell.input} type="number" value={homeForm.deposit} onChange={(e) => setHomeForm((p) => ({ ...p, deposit: toNum(e.target.value) }))} /></Field>
              <Field label={text.buyout}><input style={shell.input} type="number" value={homeForm.sale_price} onChange={(e) => setHomeForm((p) => ({ ...p, sale_price: toNum(e.target.value) }))} /></Field>
              <Field label={text.comfort}><input style={shell.input} type="number" value={homeForm.comfort} onChange={(e) => setHomeForm((p) => ({ ...p, comfort: toNum(e.target.value) }))} /></Field>
              <Field label={text.prestige}><input style={shell.input} type="number" value={homeForm.prestige} onChange={(e) => setHomeForm((p) => ({ ...p, prestige: toNum(e.target.value) }))} /></Field>
              <Field label={text.privacy}><input style={shell.input} type="number" value={homeForm.privacy} onChange={(e) => setHomeForm((p) => ({ ...p, privacy: toNum(e.target.value) }))} /></Field>
              <Field label={text.sortOrder}><input style={shell.input} type="number" value={homeForm.sort_order} onChange={(e) => setHomeForm((p) => ({ ...p, sort_order: toNum(e.target.value) }))} /></Field>
              <Field label={text.desc} span><textarea style={{ ...shell.input, minHeight: 110, resize: 'vertical' }} value={homeForm.description} onChange={(e) => setHomeForm((p) => ({ ...p, description: e.target.value }))} /></Field>
            </div>
            <div style={{ display: 'flex', gap: 10, marginTop: 14 }}>
              <button style={{ ...shell.btn, ...tones.primaryBtn }} onClick={() => saveHome().catch((e) => alert(e.message))}>{editingHomeId ? text.saveEdit : text.addHome}</button>
              <button style={{ ...shell.btn, ...tones.grayBtn }} onClick={() => { setShowCustomHomeEditor(false); setEditingHomeId(''); setHomeForm(emptyHome); }}>{text.cancel}</button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}



