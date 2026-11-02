/* 企业知识库 · 前端应用 */
'use strict';

/* ================= 工具 ================= */
const $ = (s, el) => (el || document).querySelector(s);
const $$ = (s, el) => Array.prototype.slice.call((el || document).querySelectorAll(s));
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function toast(msg, ok){
  const box = $('#toasts');
  const t = document.createElement('div');
  t.className = 'toast';
  t.innerHTML = (ok === false
    ? '<svg class="ic t-ic" style="color:#ff8a93" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="8.5"/><path d="M12 8v5m0 3h.01" stroke-linecap="round"/></svg>'
    : '<svg class="ic t-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="8.5"/><path d="M8.5 12.5l2.5 2.5 4.5-5" stroke-linecap="round" stroke-linejoin="round"/></svg>')
    + '<span></span>';
  t.lastElementChild.textContent = msg;
  box.appendChild(t);
  setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 260); }, 2600);
}

function fmtSize(bytes){
  if (bytes == null) return '—';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
  if (bytes < 1073741824) return (bytes / 1048576).toFixed(1) + ' MB';
  return (bytes / 1073741824).toFixed(2) + ' GB';
}
function fmtTime(ts){
  if (!ts) return '—';
  const d = new Date(ts);
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
function fmtDate(ts){
  if (!ts) return '—';
  const d = new Date(ts);
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
function timeGroup(ts){
  const d = new Date(ts);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  if (d >= today) return '今天';
  if (d >= new Date(today.getTime() - 86400000)) return '昨天';
  if (d >= new Date(today.getTime() - 6 * 86400000)) return '7 天内';
  if (d >= new Date(today.getTime() - 29 * 86400000)) return '30 天内';
  return '更早';
}
function relTime(ts){
  const diff = Date.now() - ts;
  if (diff < 60000) return '刚刚';
  if (diff < 3600000) return Math.floor(diff / 60000) + ' 分钟前';
  if (diff < 86400000) return Math.floor(diff / 3600000) + ' 小时前';
  return fmtDate(ts);
}
function timeGroupOrder(ts){
  const order = { '今天': 0, '昨天': 1, '7 天内': 2, '30 天内': 3, '更早': 4 };
  return order[timeGroup(ts)];
}

/* ================= API ================= */
const API = {
  token: localStorage.getItem('ekh_token') || '',
  async req(path, opts = {}){
    const headers = { ...(opts.headers || {}) };
    if (this.token) headers.Authorization = 'Bearer ' + this.token;
    if (opts.body && !(opts.body instanceof FormData)) headers['Content-Type'] = 'application/json';
    const res = await fetch('/api' + path, { ...opts, headers, body: opts.body instanceof FormData ? opts.body : opts.body != null ? JSON.stringify(opts.body) : undefined });
    if (res.status === 401 && !path.startsWith('/auth/')){
      doLogout(false);
      throw new Error('登录已过期');
    }
    let data = null;
    try { data = await res.json(); } catch {}
    if (!res.ok) throw new Error((data && data.error) || `请求失败 (${res.status})`);
    return data;
  },
  get(p){ return this.req(p); },
  post(p, body){ return this.req(p, { method: 'POST', body }); },
  put(p, body){ return this.req(p, { method: 'PUT', body }); },
  del(p){ return this.req(p, { method: 'DELETE' }); },
  upload(p, formData){ return this.req(p, { method: 'POST', body: formData }); },
};

async function downloadFile(path, opts, filename){
  try {
    const headers = {};
    if (API.token) headers.Authorization = 'Bearer ' + API.token;
    let res;
    if (opts && opts.body){
      headers['Content-Type'] = 'application/json';
      res = await fetch('/api' + path, { method: 'POST', headers, body: JSON.stringify(opts.body) });
    } else {
      res = await fetch('/api' + path, { headers });
    }
    if (!res.ok) throw new Error('下载失败');
    const blob = await res.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename || 'download';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    return true;
  } catch (e){ toast(e.message, false); return false; }
}

/* ================= 全局状态 ================= */
const state = {
  user: null,
  kbs: [],
  agents: [],
  sessions: [],
  models: [],
  tools: [],
  orgs: [],
  currentKb: null,
  currentKbRole: null,
  currentDocs: [],
  docFilter: { q: '', type: 'all', status: 'all' },
  docPage: 1,
  docSelected: new Set(),
  docView: 'list',
  kbScope: 'all',
  kbSort: 'updated',
  currentSession: null,
  currentMessages: [],
  pendingKbIds: [],
  pendingFiles: [],
  pendingFiles2: [],
  mode: 'reasoning',
  generating: false,
  abortChat: null,
  questions: [],
  cmdkItems: [],
  cmdkSel: 0,
  // Agent 平台（P0-4）
  platformAvailable: true,
  tasks: [],
  taskFilter: 'all',
  currentTask: null,
  taskEvents: [],
  taskMessages: [],
  taskEvidence: [],
  taskStream: null,
  registryTools: [],
  mcpConnections: [],
  modelProfiles: [],
  servicePrincipals: [],
};

const DEFAULT_MODEL_KIND = { chat: '对话模型', embedding: 'Embedding 模型', rerank: 'Rerank 模型' };
const MODEL_COLORS = {
  chat: 'linear-gradient(135deg,#4f8ef7,#7c5cff)',
  embedding: 'linear-gradient(135deg,#f2995f,#ed7b2f)',
  rerank: 'linear-gradient(135deg,#00a870,#038626)',
};
const AGENT_COLORS = [
  'linear-gradient(135deg,#07c05f,#0aa3c2)',
  'linear-gradient(135deg,#7c5cff,#4f8ef7)',
  'linear-gradient(135deg,#f2995f,#ed7b2f)',
  'linear-gradient(135deg,#e34d59,#c9353f)',
  'linear-gradient(135deg,#00a870,#038626)',
];
function defaultModel(kind){
  const list = state.models.filter(m => m.kind === kind);
  return list.find(m => m.is_default) || list[0] || null;
}

/* ================= 主题 ================= */
function setTheme(mode){
  document.documentElement.setAttribute('data-theme', mode);
  localStorage.setItem('ekh_theme', mode);
  const sun = $('#theme-icon-sun'), moon = $('#theme-icon-moon');
  if (sun && moon){ sun.classList.toggle('hide', mode === 'dark'); moon.classList.toggle('hide', mode !== 'dark'); }
}
$('#theme-btn').addEventListener('click', () => {
  setTheme(document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark');
});

/* ================= 侧边栏 ================= */
$('#collapse-btn').addEventListener('click', () => $('#sidebar').classList.add('collapsed'));
(function(){
  const handle = $('.resize-handle');
  let startX = 0, startW = 0;
  function onMove(e){
    const w = Math.min(360, Math.max(200, startW + e.clientX - startX));
    document.documentElement.style.setProperty('--sidebar-w', w + 'px');
  }
  function onUp(){
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    document.body.style.cursor = '';
  }
  handle.addEventListener('mousedown', e => {
    startX = e.clientX; startW = $('#sidebar').getBoundingClientRect().width;
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    document.body.style.cursor = 'col-resize';
    e.preventDefault();
  });
})();

/* ================= 视图切换 ================= */
const VIEWS = ['kb-list', 'kb-detail', 'chat-new', 'chat-session', 'agents', 'tasks', 'task-detail', 'artifacts', 'toolbox', 'organizations'];
let currentView = 'kb-list';
function showView(name){
  if (VIEWS.indexOf(name) < 0) name = 'kb-list';
  if (name !== 'task-detail') closeTaskStream();
  currentView = name;
  VIEWS.forEach(v => { const el = $('#view-' + v); if (el) el.classList.toggle('active', v === name); });
  $$('.menu-item[data-view]').forEach(el => el.classList.toggle('active', el.getAttribute('data-view') === name));
  if (name === 'agents') loadAgents();
  if (name === 'tasks') loadTasks();
  if (name === 'artifacts') loadArtifacts();
  if (name === 'toolbox') loadTools();
  if (name === 'organizations') loadOrgs();
  if (name === 'kb-list') loadKbs();
}
document.addEventListener('click', e => {
  const nav = e.target.closest('[data-nav]');
  if (nav && !e.target.closest('.pop-menu')){
    const target = nav.getAttribute('data-nav');
    if (target === 'chat-new') resetNewChat();
    showView(target);
  }
});

/* ================= 通用对话框 ================= */
function openDialog(html, { lg = false } = {}){
  $('#dialog-slot').innerHTML = `<div class="dialog${lg ? ' dialog-lg' : ''}">${html}</div>`;
  $('#dialog-overlay').classList.add('show');
  const dlg = $('#dialog-slot .dialog');
  $$('.dlg-close', dlg).forEach(b => b.addEventListener('click', closeDialog));
  return dlg;
}
function closeDialog(){ $('#dialog-overlay').classList.remove('show'); $('#dialog-slot').innerHTML = ''; }
$('#dialog-overlay').addEventListener('click', e => { if (e.target === $('#dialog-overlay')) closeDialog(); });

let popMenuCleanup = null;
function popMenu(x, y, items){
  closePopMenu();
  const menu = document.createElement('div');
  menu.className = 'pop-menu';
  menu.innerHTML = items.map(it => it === '-' ? '<div class="pm-sep"></div>' :
    `<button data-key="${esc(it.key)}" class="${it.danger ? 'danger' : ''}">${it.icon || ''}<span>${esc(it.label)}</span></button>`).join('');
  $('#pop-menu-slot').appendChild(menu);
  const rect = menu.getBoundingClientRect();
  menu.style.left = Math.min(x, window.innerWidth - rect.width - 8) + 'px';
  menu.style.top = Math.min(y, window.innerHeight - rect.height - 8) + 'px';
  const onClick = e => {
    const btn = e.target.closest('button[data-key]');
    if (btn){
      const item = items.find(i => i !== '-' && i.key === btn.getAttribute('data-key'));
      closePopMenu();
      if (item) item.run();
      return;
    }
    if (!e.target.closest('.pop-menu')) closePopMenu();
  };
  setTimeout(() => document.addEventListener('click', onClick), 0);
  popMenuCleanup = () => { document.removeEventListener('click', onClick); menu.remove(); };
}
function closePopMenu(){ if (popMenuCleanup) popMenuCleanup(); popMenuCleanup = null; }

/* ================= 登录 / 注册 ================= */
let loginMode = 'login';
function setLoginMode(mode){
  loginMode = mode;
  $('#tab-login').classList.toggle('on', mode === 'login');
  $('#tab-register').classList.toggle('on', mode === 'register');
  $('#login-name').style.display = mode === 'register' ? '' : 'none';
  $('#login-submit').textContent = mode === 'login' ? '登录' : '创建账户';
}
$('#tab-login').addEventListener('click', () => setLoginMode('login'));
$('#tab-register').addEventListener('click', () => setLoginMode('register'));
$('#login-form').addEventListener('submit', async e => {
  e.preventDefault();
  const email = $('#login-email').value.trim();
  const password = $('#login-password').value;
  if (!email || !password) return toast('请填写邮箱和密码', false);
  try {
    let data;
    if (loginMode === 'login'){
      data = await API.post('/auth/login', { email, password });
    } else {
      const name = $('#login-name').value.trim();
      data = await API.post('/auth/register', { email, password, name });
    }
    API.token = data.token;
    localStorage.setItem('ekh_token', data.token);
    await boot(data.user);
    toast('欢迎回来，' + data.user.name);
  } catch (err2){ toast(err2.message, false); }
});
$('#oidc-btn').addEventListener('click', () => toast('演示环境未配置 OIDC，请使用邮箱登录'));

function doLogout(callApi = true){
  if (callApi && API.token){ API.post('/auth/logout').catch(() => {}); }
  API.token = '';
  localStorage.removeItem('ekh_token');
  state.user = null;
  $('#app').hidden = true;
  $('#view-login').style.display = '';
  $('#login-password').value = '';
}
$('#logout-btn').addEventListener('click', () => doLogout());
$('#menu-logout').addEventListener('click', () => doLogout());

/* ================= 启动 ================= */
async function boot(user){
  state.user = user;
  $('#view-login').style.display = 'none';
  $('#app').hidden = false;
  setTheme(localStorage.getItem('ekh_theme') || user.theme || 'light');
  $('#user-avatar').textContent = (user.name || 'U').charAt(0).toUpperCase();
  $('#user-name').textContent = user.name;
  $('#user-role').textContent = user.role || '';
  $('#user-email').textContent = user.email;
  $('#chat-hero-title').textContent = 'Hi，' + user.name;
  applyAdminVisibility();
  await Promise.all([loadModels(), loadSessions(), loadKbs(), loadAgentsData()]);
  refreshBadges();
  loadTaskBadges();
  showView('kb-list');
  loadQuestions();
}
function applyAdminVisibility(){
  $$('.admin-only').forEach(el => {
    const level = el.getAttribute('data-admin');
    const ok = level === 'platform' ? !!state.user?.is_platform_admin : !!state.user?.is_admin;
    el.style.display = ok ? '' : 'none';
  });
}
async function loadTaskBadges(){
  try {
    const d = await API.get('/approvals?status=pending');
    $('#badge-approvals').textContent = d.approvals.length || '';
  } catch {
    $('#badge-approvals').textContent = '';
  }
}
async function refreshBadges(){
  $('#badge-kbs').textContent = state.kbs.length || '';
  $('#badge-agents').textContent = state.agents.length || '';
}
async function loadModels(){
  try { state.models = (await API.get('/models')).models; } catch {}
  renderModelTags();
}
function renderModelTags(){
  const m = defaultModel('chat');
  const label = m ? m.name : '未配置模型';
  $('#model-tag-label').textContent = label;
  $('#model-tag-2-label').textContent = label;
}

/* ================= 会话列表 ================= */
async function loadSessions(){
  try {
    state.sessions = (await API.get('/sessions')).sessions;
    renderSessions();
  } catch {}
}
function renderSessions(){
  const box = $('#session-list');
  box.innerHTML = '';
  const groups = [];
  const sorted = [...state.sessions].sort((a, b) => timeGroupOrder(a.updated_at) - timeGroupOrder(b.updated_at) || b.updated_at - a.updated_at);
  for (const s of sorted){
    const g = timeGroup(s.updated_at);
    let group = groups.find(x => x.name === g);
    if (!group){ group = { name: g, items: [] }; groups.push(group); }
    group.items.push(s);
  }
  for (const g of groups){
    const header = document.createElement('div');
    header.className = 'timeline-header hide-collapsed';
    header.style.paddingLeft = '34px';
    header.textContent = g.name;
    box.appendChild(header);
    for (const s of g.items){
      const row = document.createElement('div');
      row.className = 'session-row' + (state.currentSession && state.currentSession.id === s.id ? ' active' : '');
      row.setAttribute('data-session', s.id);
      row.innerHTML = '<svg class="ic" style="width:14px;height:14px;flex:none" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 6h16v10a2 2 0 0 1-2 2H8l-4 3.5V6z" stroke-linejoin="round"/></svg><span class="s-title"></span>' +
        '<button class="s-del" title="删除会话"><svg class="ic" style="width:12px;height:12px" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 6l12 12M18 6L6 18" stroke-linecap="round"/></svg></button>';
      $('.s-title', row).textContent = s.title;
      row.addEventListener('click', e => {
        if (e.target.closest('.s-del')) return;
        openSession(s.id);
      });
      $('.s-del', row).addEventListener('click', async e => {
        e.stopPropagation();
        if (!confirm(`删除会话「${s.title}」？`)) return;
        try {
          await API.del('/sessions/' + s.id);
          toast('会话已删除');
          if (state.currentSession && state.currentSession.id === s.id){ state.currentSession = null; resetNewChat(); showView('chat-new'); }
          loadSessions();
        } catch (err2){ toast(err2.message, false); }
      });
      box.appendChild(row);
    }
  }
  $$('.timeline-header', box).forEach(h => h.classList.add('hide-collapsed'));
}

/* ================= 知识库列表 ================= */
async function loadKbs(){
  try {
    state.kbs = (await API.get('/kbs?scope=all')).kbs;
    renderKbs();
    refreshBadges();
  } catch (e){ if (state.user) toast(e.message, false); }
}
function kbSections(){
  const q = ($('#kb-search').value || '').trim().toLowerCase();
  let list = state.kbs;
  if (state.kbScope === 'mine') list = list.filter(kb => kb.owner_id === state.user.id);
  else if (state.kbScope === 'shared') list = list.filter(kb => kb.owner_id !== state.user.id);
  else if (state.kbScope === 'fav') list = list.filter(kb => kb.fav);
  if (q) list = list.filter(kb => (kb.name + kb.description).toLowerCase().includes(q));
  if (state.kbSort === 'name') list = [...list].sort((a, b) => a.name.localeCompare(b.name, 'zh'));
  else list = [...list].sort((a, b) => b.updated_at - a.updated_at);
  const pinned = list.filter(kb => kb.pinned);
  const mine = list.filter(kb => !kb.pinned && kb.owner_id === state.user.id);
  const shared = list.filter(kb => !kb.pinned && kb.owner_id !== state.user.id);
  return { pinned, mine, shared, total: list.length };
}
function renderScopeCounts(){
  const kbs = state.kbs;
  const counts = {
    all: kbs.length,
    mine: kbs.filter(kb => kb.owner_id === state.user.id).length,
    shared: kbs.filter(kb => kb.owner_id !== state.user.id).length,
    fav: kbs.filter(kb => kb.fav).length,
  };
  $$('#scope-tabs [data-scope-count]').forEach(el => {
    const scope = el.closest('[data-scope]').getAttribute('data-scope');
    el.textContent = counts[scope];
  });
}
function kbCard(kb){
  const el = document.createElement('div');
  el.className = 'kb-card';
  const badges = `<span class="badge brand"><svg class="ic" style="width:12px;height:12px" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M7 5h7l4 4v10H7z" stroke-linejoin="round"/><path d="M14 5v4h4"/></svg>${kb.docs}</span>`;
  el.innerHTML =
    `<button class="fav-star${kb.fav ? ' on' : ''}" title="收藏" style="background:none;border:none;display:flex"><svg class="ic" viewBox="0 0 24 24" fill="${kb.fav ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="1.8"><path d="M12 3.5l2.6 5.3 5.9.9-4.2 4.1 1 5.8L12 16.9l-5.3 2.7 1-5.8-4.2-4.1 5.9-.9L12 3.5z" stroke-linejoin="round"/></svg></button>` +
    '<div class="card-header">' +
      '<span class="kb-avatar document">' +
        '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 6.5A2.5 2.5 0 0 1 6.5 4H10a2 2 0 0 1 2 2v12a2 2 0 0 0-2-2H6.5A2.5 2.5 0 0 1 4 13.5v-7zM20 6.5A2.5 2.5 0 0 0 17.5 4H14a2 2 0 0 0-2 2v12a2 2 0 0 1 2-2h4.5a2.5 2.5 0 0 0 2.5-2.5v-7z"/></svg>' +
      `</span><span class="card-title" title="${esc(kb.name)}">${esc(kb.name)}</span>` +
      '<button class="more-btn" title="更多" style="display:flex"><svg class="ic" viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/></svg></button>' +
    '</div>' +
    `<div class="card-desc${kb.description ? '' : ' empty'}">${esc(kb.description || '暂无描述')}</div>` +
    `<div class="badges">${badges}</div>` +
    `<div class="card-footer"><div class="mini-avatar">${esc(kb.owner_name.charAt(0))}</div><span>${esc(kb.owner_name)}</span><span>更新于 ${relTime(kb.updated_at)}</span><span class="spacer"></span>` +
    (kb.org_name ? `<span class="org-chip"><svg class="ic" style="width:12px;height:12px" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="4" y="8" width="7" height="12" rx="1.5"/><rect x="13" y="4" width="7" height="16" rx="1.5"/></svg>${esc(kb.org_name)}</span>` : '') +
    '</div>';
  $('.fav-star', el).addEventListener('click', async e => {
    e.stopPropagation();
    try {
      const r = await API.post(`/kbs/${kb.id}/favorite`);
      kb.fav = r.fav;
      $('.fav-star', el).classList.toggle('on', kb.fav);
      $('svg', $('.fav-star', el)).setAttribute('fill', kb.fav ? 'currentColor' : 'none');
      renderScopeCounts();
      toast(kb.fav ? `已收藏「${kb.name}」` : '已取消收藏');
    } catch (err2){ toast(err2.message, false); }
  });
  $('.more-btn', el).addEventListener('click', e => {
    e.stopPropagation();
    const r = e.currentTarget.getBoundingClientRect();
    popMenu(r.left - 110, r.bottom + 4, [
      { key: 'open', label: '打开知识库', run: () => openKbDetail(kb) },
      { key: 'fav', label: kb.fav ? '取消收藏' : '收藏', run: () => $('.fav-star', el).click() },
      { key: 'chat', label: '就此提问', run: () => { resetNewChat([kb.id]); showView('chat-new'); } },
      '-',
      { key: 'settings', label: '设置', run: () => openKbSettings(kb) },
      ...(kb.owner_id === state.user.id ? [{ key: 'del', label: '删除', danger: true, run: () => deleteKb(kb) }] : []),
    ]);
  });
  el.addEventListener('click', () => openKbDetail(kb));
  return el;
}
function renderKbs(){
  renderScopeCounts();
  const box = $('#kb-sections');
  box.innerHTML = '';
  const { pinned, mine, shared, total } = kbSections();
  if (!total){
    box.innerHTML = `<div class="empty-page" style="min-height:300px"><div class="empty-icon"><svg class="ic" style="width:28px;height:28px" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M4 6.5A2.5 2.5 0 0 1 6.5 4H10a2 2 0 0 1 2 2v12a2 2 0 0 0-2-2H6.5A2.5 2.5 0 0 1 4 13.5v-7z"/><path d="M20 6.5A2.5 2.5 0 0 0 17.5 4H14a2 2 0 0 0-2 2v12a2 2 0 0 1 2-2h4.5a2.5 2.5 0 0 0 2.5-2.5v-7z"/></svg></div><h3>暂无知识库</h3><p>创建你的第一个知识库，上传文档后即可开始智能问答。</p><button class="btn primary" id="empty-create-kb">新建知识库</button></div>`;
    $('#empty-create-kb').addEventListener('click', openCreateKb);
    return;
  }
  const section = (iconSvg, title, count, kbs) => {
    if (!kbs.length) return;
    const wrap = document.createElement('div');
    wrap.innerHTML = `<div class="kb-section">${iconSvg}<span>${title}</span><span class="count">${count}</span></div><div class="kb-grid"></div>`;
    const grid = $('.kb-grid', wrap);
    kbs.forEach(kb => grid.appendChild(kbCard(kb)));
    box.appendChild(wrap);
  };
  section('<svg class="ic" style="width:14px;height:14px;color:var(--brand)" viewBox="0 0 24 24" fill="currentColor"><path d="M12 3l1.9 5.4L19 10l-5.1 1.6L12 17l-1.9-5.4L5 10l5.1-1.6L12 3z"/></svg>', '置顶', pinned.length, pinned);
  section('<svg class="ic" style="width:14px;height:14px" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="8" r="3.5"/><path d="M5 20a7 7 0 0 1 14 0" stroke-linecap="round"/></svg>', '我创建的', mine.length, mine);
  section('<svg class="ic" style="width:14px;height:14px" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="4" y="8" width="7" height="12" rx="1.5"/><rect x="13" y="4" width="7" height="16" rx="1.5"/></svg>', '共享给我 · ' + (state.kbScope === 'all' ? '按空间角色访问' : ''), shared.length, shared);
}
$('#scope-tabs').addEventListener('click', e => {
  const tab = e.target.closest('.scope-tab');
  if (!tab) return;
  $$('#scope-tabs .scope-tab').forEach(t => t.classList.remove('active'));
  tab.classList.add('active');
  state.kbScope = tab.getAttribute('data-scope');
  renderKbs();
});
$('#kb-search').addEventListener('input', renderKbs);
$('#kb-sort-btn').addEventListener('click', () => {
  state.kbSort = state.kbSort === 'updated' ? 'name' : 'updated';
  $('#kb-sort-label').textContent = state.kbSort === 'updated' ? '更新时间' : '名称';
  renderKbs();
});

function openCreateKb(){
  const dlg = openDialog(`
    <h3>新建知识库</h3>
    <p class="dlg-sub">创建一个知识库，统一管理文档与问答对</p>
    <div class="dlg-body">
      <label class="form-label">名称</label>
      <input class="form-input" id="ckb-name" placeholder="例如：产品知识库" maxlength="60">
      <label class="form-label">描述</label>
      <textarea class="form-textarea" id="ckb-desc" placeholder="简要说明这个知识库的用途（可选）"></textarea>
    </div>
    <div class="dlg-foot">
      <button class="btn dlg-close">取消</button>
      <button class="btn primary" id="ckb-submit">创建</button>
    </div>`);
  $('#ckb-name', dlg).focus();
  $('#ckb-submit', dlg).addEventListener('click', async () => {
    const name = $('#ckb-name', dlg).value.trim();
    if (!name) return toast('请填写知识库名称', false);
    try {
      await API.post('/kbs', {
        name,
        description: $('#ckb-desc', dlg).value.trim(),
      });
      closeDialog();
      toast('知识库已创建');
      await loadKbs();
    } catch (e){ toast(e.message, false); }
  });
}
$('#create-kb-btn').addEventListener('click', openCreateKb);

async function deleteKb(kb){
  if (!confirm(`确定删除知识库「${kb.name}」？其中的 ${kb.docs} 个文档与全部索引将被移除，不可恢复。`)) return;
  try {
    await API.del('/kbs/' + kb.id);
    toast('知识库已删除');
    loadKbs();
  } catch (e){ toast(e.message, false); }
}

/* ================= 知识库详情 ================= */
const TYPE_GROUPS = { all: '全部', pdf: 'PDF', docx: 'Word', xlsx: 'Excel', pptx: 'PPT', text: '文本', image: '图片' };
const TYPE_EXTS = { pdf: ['pdf'], docx: ['doc', 'docx'], xlsx: ['xls', 'xlsx', 'csv'], pptx: ['ppt', 'pptx'], text: ['md', 'markdown', 'txt', 'html', 'htm', 'json', 'log', 'yml', 'yaml', 'xml', 'srt', 'vtt'], image: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'] };
const STATUS_TEXT = { ok: '已完成', run: '解析中', fail: '失败', pending: '排队中' };

async function openKbDetail(kb){
  try {
    const data = await API.get('/kbs/' + kb.id);
    state.currentKb = data.kb;
    state.currentKbRole = data.role;
    state.docFilter = { q: '', type: 'all', status: 'all' };
    state.docPage = 1;
    state.docSelected.clear();
    $('#doc-search').value = '';
    $('#filter-type-chip').textContent = '文件类型：全部';
    $('#filter-status-chip').textContent = '解析状态：全部';
    renderKbDetail();
    await loadDocs();
    showView('kb-detail');
  } catch (e){ toast(e.message, false); }
}
function canWriteKb(){ return ['owner', 'admin', 'contributor'].includes(state.currentKbRole); }

function renderKbDetail(){
  const kb = state.currentKb;
  let badges = '';
  if (kb.org_name) badges += `<span class="badge">${esc(kb.org_name)}</span>`;
  $('#kb-detail-badges').innerHTML = `<h2>${esc(kb.name)}</h2>` + badges;
  const canW = canWriteKb();
  $('#upload-btn-label').textContent = '上传文档';
  $('#upload-btn').style.display = canW ? '' : 'none';
  $('#upload-folder-btn').style.display = canW ? '' : 'none';
  $('#qa-btn').style.display = canW ? '' : 'none';
  $('#batch-download-btn').style.display = kb.docs ? '' : 'none';
  $('#kb-settings-btn').style.display = '';
}

async function loadDocs(){
  if (!state.currentKb) return;
  try {
    const data = await API.get(`/kbs/${state.currentKb.id}/documents?q=${encodeURIComponent(state.docFilter.q)}`);
    state.currentDocs = data.docs;
    renderDocs();
  } catch (e){ toast(e.message, false); }
}
function filteredDocs(){
  const { type, status } = state.docFilter;
  return state.currentDocs.filter(d => {
    if (type !== 'all'){
      const exts = TYPE_EXTS[type] || [];
      if (!exts.includes(d.ext)) return false;
    }
    if (status !== 'all'){
      const map = { ok: 'ready', run: 'processing', fail: 'failed', pending: 'pending' };
      if (d.status !== map[status]) return false;
    }
    return true;
  });
}
function renderDocs(){
  const docs = filteredDocs();
  const PER = 10;
  const pages = Math.max(1, Math.ceil(docs.length / PER));
  if (state.docPage > pages) state.docPage = pages;
  const slice = docs.slice((state.docPage - 1) * PER, state.docPage * PER);
  const tbody = $('#doc-tbody');
  tbody.innerHTML = '';
  if (!slice.length){
    tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;padding:40px;color:var(--text-4)">暂无文档</td></tr>';
  }
  const gridMode = state.docView === 'grid';
  $('#doc-table').style.display = gridMode ? 'none' : '';
  let gridWrap = $('#doc-grid-wrap');
  if (!gridWrap){
    gridWrap = document.createElement('div');
    gridWrap.id = 'doc-grid-wrap';
    gridWrap.className = 'kb-grid';
    gridWrap.style.padding = '12px 0';
    $('#doc-list-wrap').appendChild(gridWrap);
  }
  gridWrap.style.display = gridMode ? '' : 'none';
  gridWrap.innerHTML = '';

  for (const d of slice){
    if (gridMode){
      const card = document.createElement('div');
      card.className = 'kb-card';
      card.innerHTML = `<div class="card-header"><span class="doc-icon ${docIcon(d)}" style="width:34px;height:34px;border-radius:9px">${docIcon(d).toUpperCase()}</span><span class="card-title" title="${esc(d.name)}">${esc(d.name)}</span></div>
        <div class="badges"><span class="badge">${fmtSize(d.size)}</span><span class="badge">${d.chunk_count} 分块</span>${statusBadge(d)}</div>
        <div class="card-footer"><span>更新于 ${relTime(d.updated_at)}</span><span class="spacer"></span></div>`;
      card.addEventListener('click', () => previewDoc(d));
      gridWrap.appendChild(card);
      continue;
    }
    const tr = document.createElement('tr');
    tr.className = 'clickable';
    tr.setAttribute('data-doc', d.id);
    const selected = state.docSelected.has(d.id);
    let statusHtml = '';
    if (d.status === 'ready' || (d.kind === 'qa' && d.status === 'ready')) statusHtml = '<span class="status-cell status-ok"><span class="status-dot"></span>已完成</span>';
    else if (d.status === 'processing' || d.status === 'pending') statusHtml = `<span class="status-cell status-run"><span class="status-dot"></span><span>${d.status === 'pending' ? '排队中' : '解析中'}</span><span class="progress-line"><i style="width:${d.progress || 5}%"></i></span></span>`;
    else if (d.status === 'failed') statusHtml = `<span class="status-cell status-fail"><span class="status-dot"></span>失败 · <u style="cursor:pointer" data-reparse>重试</u></span>`;
    const errTitle = d.error ? ` title="${esc(d.error)}"` : '';
    tr.innerHTML =
      `<td><input type="checkbox" class="doc-check doc-check-row" ${selected ? 'checked' : ''}></td>` +
      `<td><span class="doc-name"><span class="doc-icon ${docIcon(d)}">${docIcon(d).toUpperCase()}</span><span class="d-name"${errTitle}></span>${d.kind === 'qa' ? '<span class="badge brand" style="font-size:10px;height:18px">问答</span>' : ''}</span></td>` +
      `<td>${d.kind === 'qa' ? '—' : fmtSize(d.size)}</td>` +
      `<td>${d.chunk_count || 0}</td>` +
      `<td>${statusHtml}</td>` +
      `<td style="white-space:nowrap">${fmtTime(d.updated_at)}</td>` +
      '<td><button class="icon-btn doc-more" style="width:26px;height:26px"><svg class="ic" style="width:14px;height:14px" viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/></svg></button></td>';
    $('.d-name', tr).textContent = d.name;
    $('.doc-check-row', tr).addEventListener('click', e => {
      e.stopPropagation();
      if (e.target.checked) state.docSelected.add(d.id); else state.docSelected.delete(d.id);
      updateDocFooter();
    });
    $('.doc-more', tr).addEventListener('click', e => {
      e.stopPropagation();
      const r = e.currentTarget.getBoundingClientRect();
      popMenu(r.left - 120, r.bottom + 4, [
        { key: 'preview', label: '预览分块', run: () => previewDoc(d) },
        ...(d.kind === 'file' ? [{ key: 'download', label: '下载原文件', run: () => downloadFile(`/documents/${d.id}/download`, null, d.name) }] : []),
        ...(canWriteKb() ? [
          { key: 'reparse', label: '重建知识', run: () => reparseDoc(d) },
          '-',
          { key: 'del', label: '删除', danger: true, run: () => deleteDoc(d) },
        ] : []),
      ]);
    });
    tr.addEventListener('click', e => {
      if (e.target.closest('input')) return;
      if (e.target.closest('[data-reparse]')) return reparseDoc(d);
      previewDoc(d);
    });
    tbody.appendChild(tr);
  }
  // 分页
  const pager = $('#doc-pager');
  pager.innerHTML = '';
  const mk = (label, page, on) => {
    const b = document.createElement('button');
    b.textContent = label;
    if (on) b.classList.add('on');
    b.addEventListener('click', () => { state.docPage = page; renderDocs(); });
    return b;
  };
  if (pages > 1){
    pager.appendChild(mk('‹', Math.max(1, state.docPage - 1), false));
    let dotsShown = false;
    for (let i = 1; i <= pages; i++){
      if (i > 3 && i < pages && Math.abs(i - state.docPage) > 1){
        if (!dotsShown){
          dotsShown = true;
          const dots = document.createElement('span');
          dots.textContent = '…';
          dots.style.cssText = 'color:var(--text-4);font-size:12px;align-self:center';
          pager.appendChild(dots);
        }
        continue;
      }
      pager.appendChild(mk(String(i), i, i === state.docPage));
    }
    pager.appendChild(mk('›', Math.min(pages, state.docPage + 1), false));
  }
  updateDocFooter();
}
function docIcon(d){
  if (d.kind === 'qa') return 'md';
  const map = { pdf: 'pdf', doc: 'doc', docx: 'doc', xls: 'xls', xlsx: 'xls', csv: 'xls', ppt: 'ppt', pptx: 'ppt', png: 'img', jpg: 'img', jpeg: 'img', webp: 'img', gif: 'img', bmp: 'img' };
  return map[d.ext] || 'md';
}
function statusBadge(d){
  if (d.status === 'ready') return '<span class="badge brand">已完成</span>';
  if (d.status === 'failed') return '<span class="badge error">失败</span>';
  return '<span class="badge">解析中</span>';
}
function updateDocFooter(){
  const docs = filteredDocs();
  $('#doc-footer-info').textContent = `共 ${docs.length} 个文档 · 已选 ${state.docSelected.size} 项`;
  $('#doc-selected-note').textContent = state.docSelected.size ? `已选 ${state.docSelected.size} 项` : '';
}
$('#doc-search').addEventListener('input', () => {
  state.docFilter.q = $('#doc-search').value.trim();
  state.docPage = 1;
  loadDocs();
});
$('#filter-type-chip').addEventListener('click', e => {
  const r = e.currentTarget.getBoundingClientRect();
  popMenu(r.left, r.bottom + 4, Object.entries(TYPE_GROUPS).map(([k, v]) => ({
    key: k, label: v, run: () => { state.docFilter.type = k; state.docPage = 1; $('#filter-type-chip').textContent = `文件类型：${v}`; renderDocs(); },
  })));
});
$('#filter-status-chip').addEventListener('click', e => {
  const r = e.currentTarget.getBoundingClientRect();
  popMenu(r.left, r.bottom + 4, [
    { key: 'all', label: '全部', run: () => { state.docFilter.status = 'all'; $('#filter-status-chip').textContent = '解析状态：全部'; renderDocs(); } },
    { key: 'run', label: '解析中', run: () => { state.docFilter.status = 'run'; $('#filter-status-chip').textContent = '解析状态：解析中'; renderDocs(); } },
    { key: 'ok', label: '已完成', run: () => { state.docFilter.status = 'ok'; $('#filter-status-chip').textContent = '解析状态：已完成'; renderDocs(); } },
    { key: 'fail', label: '失败', run: () => { state.docFilter.status = 'fail'; $('#filter-status-chip').textContent = '解析状态：失败'; renderDocs(); } },
  ]);
});
$('#view-mode-list').addEventListener('click', () => { state.docView = 'list'; $('#view-mode-list').classList.add('on'); $('#view-mode-grid').classList.remove('on'); renderDocs(); });
$('#view-mode-grid').addEventListener('click', () => { state.docView = 'grid'; $('#view-mode-grid').classList.add('on'); $('#view-mode-list').classList.remove('on'); renderDocs(); });
$('#doc-check-all').addEventListener('change', e => {
  const docs = filteredDocs().slice((state.docPage - 1) * 10, state.docPage * 10);
  docs.forEach(d => { if (e.target.checked) state.docSelected.add(d.id); else state.docSelected.delete(d.id); });
  renderDocs();
});

$('#upload-btn').addEventListener('click', () => {
  if (!state.currentKb) return;
  $('#upload-input').click();
});
$('#qa-btn').addEventListener('click', () => {
  if (!state.currentKb) return;
  openQaDialog();
});
$('#upload-folder-btn').addEventListener('click', () => {
  if (!state.currentKb) return;
  $('#upload-folder-input').click();
});
$('#upload-input').addEventListener('change', async e => {
  const files = [...e.target.files];
  e.target.value = '';
  if (files.length) await uploadDocs(files);
});
$('#upload-folder-input').addEventListener('change', async e => {
  const all = [...e.target.files];
  e.target.value = '';
  const files = all.filter(f => !(f.webkitRelativePath || f.name).split('/').some(p => p.startsWith('.')));
  if (!files.length) return;
  if (files.length > 200){
    toast('文件夹内文件过多，仅上传前 200 个', false);
    files.length = 200;
  }
  await uploadDocs(files);
});
async function uploadDocs(files){
  if (!state.currentKb || !files.length) return;
  const fd = new FormData();
  let skipped = 0;
  for (const f of files){
    if (f.size > 200 * 1024 * 1024){ skipped++; continue; }
    fd.append('files', f, f.name);
    // 浏览器会剥掉 multipart filename 里的路径，相对路径用独立字段传给后端
    fd.append('paths', f.webkitRelativePath || f.name);
  }
  if (!fd.has('files')){ if (skipped) toast('所选文件超过 200MB，未上传', false); return; }
  try {
    await API.upload(`/kbs/${state.currentKb.id}/documents`, fd);
    toast(`已开始解析 ${files.length - skipped} 个文档${skipped ? `，${skipped} 个超大文件已跳过` : ''}`);
    await loadDocs();
    startDocPolling();
  } catch (err2){ toast(err2.message, false); }
}
function openQaDialog(){
  const dlg = openDialog(`
    <h3>新增问答对</h3>
    <p class="dlg-sub">问答对将作为独立知识片段参与检索</p>
    <div class="dlg-body">
      <label class="form-label">问题</label>
      <input class="form-input" id="qa-q" placeholder="例如：如何申请报销？">
      <label class="form-label">答案</label>
      <textarea class="form-textarea" id="qa-a" rows="5" placeholder="标准答复内容…"></textarea>
    </div>
    <div class="dlg-foot">
      <button class="btn dlg-close">取消</button>
      <button class="btn primary" id="qa-submit">添加</button>
    </div>`);
  $('#qa-q', dlg).focus();
  $('#qa-submit', dlg).addEventListener('click', async () => {
    const q = $('#qa-q', dlg).value.trim(), a = $('#qa-a', dlg).value.trim();
    if (!q || !a) return toast('问题与答案不能为空', false);
    try {
      await API.post(`/kbs/${state.currentKb.id}/qa`, { question: q, answer: a });
      closeDialog();
      toast('问答对已添加');
      loadDocs();
    } catch (e){ toast(e.message, false); }
  });
}
async function reparseDoc(d){
  try {
    await API.post(`/documents/${d.id}/reparse`);
    toast(`「${d.name}」开始重建知识`);
    loadDocs();
    startDocPolling();
  } catch (e){ toast(e.message, false); }
}
async function deleteDoc(d){
  if (!confirm(`删除文档「${d.name}」？相关分块与索引将一并移除。`)) return;
  try {
    await API.del('/documents/' + d.id);
    state.docSelected.delete(d.id);
    toast('文档已删除');
    loadDocs();
  } catch (e){ toast(e.message, false); }
}
async function previewDoc(d){
  try {
    const data = await API.get('/documents/' + d.id);
    const chunks = data.chunks || [];
    const dlg = openDialog(`
      <h3 style="word-break:break-all">${esc(d.name)}</h3>
      <p class="dlg-sub">${d.kind === 'qa' ? '问答对' : fmtSize(d.size) + ' · ' + (d.ext || '').toUpperCase()} · ${chunks.length} 个分块 · ${STATUS_TEXT[d.status] || d.status}${d.error ? ' · ' + esc(d.error) : ''}</p>
      <div class="dlg-body">${chunks.length ? chunks.map(c => `
        <div class="chunk-item">
          <div class="ch-head"><span class="ref-idx">${c.idx + 1}</span><span>片段 #${c.idx + 1}</span></div>
          <pre>${esc(c.content)}</pre>
        </div>`).join('') : '<div style="padding:30px;text-align:center;color:var(--text-4);font-size:13px">没有可预览的分块</div>'}</div>
      <div class="dlg-foot"><button class="btn dlg-close">关闭</button></div>`, { lg: true });
  } catch (e){ toast(e.message, false); }
}
$('#batch-download-btn').addEventListener('click', () => {
  const ids = [...state.docSelected];
  downloadFile(`/kbs/${state.currentKb.id}/batch-download`, { body: { ids } }, state.currentKb.name + '-documents.zip');
});

// 解析轮询：详情页存在解析中的文档时每 2.5s 刷新
let docPollTimer = null;
function startDocPolling(){
  clearInterval(docPollTimer);
  docPollTimer = setInterval(() => {
    if (currentView !== 'kb-detail' || !state.currentKb){ clearInterval(docPollTimer); return; }
    const busy = state.currentDocs.some(d => d.status === 'processing' || d.status === 'pending');
    if (busy) loadDocs(); else clearInterval(docPollTimer);
  }, 2500);
}

async function openKbSettings(kb){
  if (!state.orgs.length) await loadOrgs();
  const isOwner = kb.owner_id === state.user.id;
  const dlg = openDialog(`
    <h3>知识库设置</h3>
    <p class="dlg-sub">${esc(kb.name)}</p>
    <div class="dlg-body">
      <label class="form-label">名称</label>
      <input class="form-input" id="ks-name" value="${esc(kb.name)}" maxlength="60" ${isOwner ? '' : 'disabled'}>
      <label class="form-label">描述</label>
      <textarea class="form-textarea" id="ks-desc" ${isOwner ? '' : 'disabled'}>${esc(kb.description)}</textarea>
      <label class="form-label">共享到空间</label>
      <select class="form-select" id="ks-org" ${isOwner ? '' : 'disabled'}>
        <option value="">不共享（仅自己可见）</option>
        ${state.orgs.map(o => `<option value="${o.id}" ${kb.org_id === o.id ? 'selected' : ''}>${esc(o.name)}</option>`).join('')}
      </select>
      <p class="form-hint">共享后空间成员按角色访问：Owner/Admin 可管理，Contributor 可上传，Viewer 仅查看。</p>
    </div>
    <div class="dlg-foot">
      ${isOwner ? '<button class="btn" id="ks-del" style="color:#e34d59;border-color:rgba(227,77,89,.4)">删除知识库</button>' : ''}
      <span style="flex:1"></span>
      <button class="btn dlg-close">取消</button>
      ${isOwner ? '<button class="btn primary" id="ks-save">保存</button>' : ''}
    </div>`);
  if (isOwner){
    $('#ks-save', dlg).addEventListener('click', async () => {
      try {
        await API.put('/kbs/' + kb.id, {
          name: $('#ks-name', dlg).value.trim(),
          description: $('#ks-desc', dlg).value.trim(),
          org_id: $('#ks-org', dlg).value || null,
        });
        closeDialog();
        toast('设置已保存');
        loadKbs();
        if (state.currentKb && state.currentKb.id === kb.id){ const fresh = state.kbs.find(x => x.id === kb.id); if (fresh){ state.currentKb = fresh; renderKbDetail(); } }
      } catch (e){ toast(e.message, false); }
    });
    $('#ks-del', dlg).addEventListener('click', () => { closeDialog(); deleteKb(kb); });
  }
}
$('#kb-settings-btn').addEventListener('click', () => { if (state.currentKb) openKbSettings(state.currentKb); });

/* ================= 对话 ================= */
const MODE_LABEL = { reasoning: '智能推理', qa: '快速问答' };
function resetNewChat(kbIds){
  state.pendingKbIds = kbIds || [];
  state.pendingFiles = [];
  $('#composer-input').value = '';
  renderKbChips($('#kb-chips'), state.pendingKbIds, true);
  renderKbChips($('#kb-chips-2'), state.pendingKbIds, true);
  loadQuestions();
}
async function loadQuestions(){
  try {
    state.questions = (await API.get('/questions')).questions;
    renderQuestions(state.questions);
  } catch {}
}
function renderQuestions(list){
  const grid = $('#sq-grid');
  grid.innerHTML = '';
  (list || []).forEach(q => {
    const b = document.createElement('button');
    b.className = 'sq-card';
    b.type = 'button';
    b.textContent = q;
    b.addEventListener('click', () => sendFromComposer(q));
    grid.appendChild(b);
  });
}
$('#sq-refresh').addEventListener('click', loadQuestions);

function renderKbChips(box, ids, editable){
  box.innerHTML = '';
  ids.forEach(id => {
    const kb = state.kbs.find(k => k.id === id);
    if (!kb) return;
    const chip = document.createElement('span');
    chip.className = 'kb-chip';
    chip.innerHTML = '<svg class="ic" style="width:12px;height:12px" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 6.5A2.5 2.5 0 0 1 6.5 4H10a2 2 0 0 1 2 2v12a2 2 0 0 0-2-2H6.5A2.5 2.5 0 0 1 4 13.5v-7zM20 6.5A2.5 2.5 0 0 0 17.5 4H14a2 2 0 0 0-2 2v12a2 2 0 0 1 2-2h4.5a2.5 2.5 0 0 0 2.5-2.5v-7z"/></svg>' +
      `<span class="c-name"></span>${editable ? '<span class="x">×</span>' : ''}`;
    $('.c-name', chip).textContent = kb.name;
    if (editable) $('.x', chip).addEventListener('click', () => {
      const i = state.pendingKbIds.indexOf(id);
      if (i > -1) state.pendingKbIds.splice(i, 1);
      renderKbChips($('#kb-chips'), state.pendingKbIds, true);
      renderKbChips($('#kb-chips-2'), state.pendingKbIds, true);
      if (state.currentSession && !state.currentSession.agent_id) updateSessionKbs();
    });
    box.appendChild(chip);
  });
  const add = document.createElement('button');
  add.className = 'chip-add';
  add.textContent = '+ 添加知识库';
  add.addEventListener('click', e => {
    e.stopPropagation();
    const r = add.getBoundingClientRect();
    const avail = state.kbs.filter(kb => !state.pendingKbIds.includes(kb.id));
    if (!avail.length) return toast('没有更多可选的知识库');
    popMenu(r.left, r.bottom + 4, avail.map(kb => ({ key: kb.id, label: kb.name, run: () => {
      state.pendingKbIds.push(kb.id);
      renderKbChips($('#kb-chips'), state.pendingKbIds, true);
      renderKbChips($('#kb-chips-2'), state.pendingKbIds, true);
      if (state.currentSession && !state.currentSession.agent_id) updateSessionKbs();
    } })));
  });
  if (editable) box.appendChild(add);
}
async function updateSessionKbs(){
  if (!state.currentSession) return;
  try {
    await API.put('/sessions/' + state.currentSession.id, { kb_ids: state.pendingKbIds });
    state.currentSession.kb_ids = [...state.pendingKbIds];
    renderSessionBadges();
  } catch {}
}
function renderSessionBadges(){
  const s = state.currentSession;
  if (!s) return;
  $('#session-title').textContent = s.title || '新对话';
  const n = state.pendingKbIds.length;
  const kbBadge = $('#session-kb-badge');
  kbBadge.style.display = n ? '' : 'none';
  kbBadge.textContent = `知识库 ${n}`;
  const m = s.model ? state.models.find(x => x.id === s.model) : defaultModel('chat');
  const mBadge = $('#session-model-badge');
  mBadge.style.display = m ? '' : 'none';
  mBadge.textContent = m ? m.name : '';
}

$('#mode-chip').addEventListener('click', () => {
  state.mode = state.mode === 'reasoning' ? 'qa' : 'reasoning';
  $('#mode-label').textContent = MODE_LABEL[state.mode];
  if (state.currentSession) API.put('/sessions/' + state.currentSession.id, { mode: state.mode }).catch(() => {});
  toast(state.mode === 'reasoning' ? '已切换到智能推理：多步思考，深度分析' : '已切换到快速问答：基于知识库的简洁回答');
});
$('#tool-btn').addEventListener('click', () => toast('工具在「工具箱」中开启后，由智能体在对话中自动调用'));
$('#model-tag').addEventListener('click', () => openSettings('models'));

async function sendFromComposer(text){
  text = (text || '').trim();
  if (!text || state.generating) return;
  const wasNew = currentView === 'chat-new' || !state.currentSession;
  try {
    if (wasNew){
      const kbBadgeLabel = state.pendingKbIds.length;
      const data = await API.post('/sessions', { kb_ids: state.pendingKbIds, mode: state.mode });
      state.currentSession = data.session;
      // 上传新对话暂存的附件
      if (state.pendingFiles.length){
        const fd = new FormData();
        state.pendingFiles.forEach(f => fd.append('files', f));
        try {
          await API.upload(`/sessions/${data.session.id}/attachments`, fd);
          toast('附件已上传，解析完成后自动参与检索');
        } catch {}
        state.pendingFiles = [];
        renderAttachRow();
      }
      await loadSessions();
      renderSessions();
    }
    showView('chat-session');
    renderSessionBadges();
    renderKbChips($('#kb-chips-2'), state.pendingKbIds, !state.currentSession.agent_id);
    if (!$('#thread-inner').children.length) $('#thread-inner').innerHTML = '';
    addUserMsg(text);
    await streamAnswer(text);
    if (wasNew){
      await loadSessions();
      const fresh = state.sessions.find(x => x.id === state.currentSession.id);
      if (fresh && fresh.title !== state.currentSession.title){
        state.currentSession.title = fresh.title;
        $('#session-title').textContent = fresh.title;
      }
    }
  } catch (e){ toast(e.message, false); }
}
$('#send-btn').addEventListener('click', () => {
  const v = $('#composer-input').value;
  $('#composer-input').value = '';
  sendFromComposer(v);
});
$('#composer-input').addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey){ e.preventDefault(); const v = $('#composer-input').value; $('#composer-input').value = ''; sendFromComposer(v); }
});
$('#send-btn-2').addEventListener('click', () => {
  const v = $('#composer-input-2').value;
  $('#composer-input-2').value = '';
  sendFromComposer(v);
});
$('#composer-input-2').addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey){ e.preventDefault(); const v = $('#composer-input-2').value; $('#composer-input-2').value = ''; sendFromComposer(v); }
});

function addUserMsg(text){
  const inner = $('#thread-inner');
  const div = document.createElement('div');
  div.className = 'msg-user';
  div.textContent = text;
  inner.appendChild(div);
  $('#thread').scrollTop = $('#thread').scrollHeight;
}
function sendBtnStop(stopping, btn){
  if (!btn) return;
  btn.classList.toggle('stop', !!stopping);
  btn.innerHTML = stopping
    ? '<svg class="ic" viewBox="0 0 24 24" fill="currentColor"><rect x="7" y="7" width="10" height="10" rx="1.5"/></svg>'
    : '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M12 19V5m0 0l-6 6m6-6l6 6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
}

// 极简 Markdown 渲染（标题/列表/引用/粗体/斜体/行内代码/代码块/链接/分隔线）
function renderMd(src){
  const lines = String(src || '').split('\n');
  const out = [];
  let inCode = false, codeBuf = [], listType = null;
  const inline = s => esc(s)
    .replace(/`([^`]+)`/g, '<md-code>$1</md-code>')
    .replace(/\*\*([^*]+)\*\*/g, '<md-b>$1</md-b>')
    .replace(/\*([^*]+)\*/g, '<i>$1</i>')
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<md-a data-url="$2">$1</md-a>');
  const closeList = () => { if (listType){ out.push(`</${listType === 'ol' ? 'md-li-ol-wrap' : 'md-li-wrap'}>`.replace('md-li-ol-wrap', 'div').replace('md-li-wrap', 'div')); listType = null; } };
  for (const raw of lines){
    if (/^```/.test(raw.trim())){
      if (inCode){ out.push(`<md-pre>${esc(codeBuf.join('\n'))}</md-pre>`); codeBuf = []; inCode = false; }
      else { closeList(); inCode = true; }
      continue;
    }
    if (inCode){ codeBuf.push(raw); continue; }
    const line = raw.trimEnd();
    if (!line.trim()){ closeList(); continue; }
    const h = line.match(/^(#{1,4})\s+(.*)/);
    if (h){ closeList(); out.push(`<md-h>${inline(h[2])}</md-h>`); continue; }
    if (/^(---+|\*\*\*+)$/.test(line.trim())){ closeList(); out.push('<md-hr></md-hr>'); continue; }
    const quote = line.match(/^>\s?(.*)/);
    if (quote){ closeList(); out.push(`<md-quote>${inline(quote[1])}</md-quote>`); continue; }
    const ul = line.match(/^\s*[-*]\s+(.*)/);
    const ol = line.match(/^\s*(\d+)[.、]\s+(.*)/);
    if (ul){ if (listType !== 'ul'){ closeList(); listType = 'ul'; } out.push(`<md-li>${inline(ul[1])}</md-li>`); continue; }
    if (ol){ if (listType !== 'ol'){ closeList(); listType = 'ol'; } out.push(`<md-li class="md-li-ol">${inline(ol[2])}</md-li>`); continue; }
    closeList();
    out.push(`<md-p>${inline(line)}</md-p>`);
  }
  if (inCode && codeBuf.length) out.push(`<md-pre>${esc(codeBuf.join('\n'))}</md-pre>`);
  return out.join('');
}

function aiBlockShell(){
  const wrap = document.createElement('div');
  wrap.className = 'msg-ai';
  wrap.innerHTML =
    '<div class="ai-avatar"><svg class="ic" viewBox="0 0 24 24" fill="none"><path d="M5 7c0-1.1.9-2 2-2h3.2c1 0 1.8.8 1.8 1.8V19c0-1-.8-1.8-1.8-1.8H7a2 2 0 0 1-2-2V7zM19 7c0-1.1-.9-2-2-2h-3.2c-1 0-1.8.8-1.8 1.8V19c0-1 .8-1.8 1.8-1.8H17a2 2 0 0 0 2-2V7z" fill="#fff"/></svg></div>' +
    '<div class="msg-ai-body">' +
      '<div class="think-block" style="display:none">' +
        '<div class="think-head"><svg class="ic" style="width:13px;height:13px" viewBox="0 0 24 24" fill="currentColor"><path d="M12 3l1.9 5.4L19 10l-5.1 1.6L12 17l-1.9-5.4L5 10l5.1-1.6L12 3z"/></svg><span class="think-label">思考中…</span>' +
        '<svg class="ic chev" style="width:13px;height:13px" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M6 9.5l6 6 6-6" stroke-linecap="round"/></svg></div>' +
        '<div class="think-body"></div>' +
      '</div>' +
      '<div class="answer"></div>' +
      '<div class="refs-row" style="display:none"><span class="ref-label"></span></div>' +
    '</div>';
  $('#thread-inner').appendChild(wrap);
  $('.think-head', wrap).addEventListener('click', () => $('.think-block', wrap).classList.toggle('open'));
  return wrap;
}
function setThink(wrap, think){
  const block = $('.think-block', wrap);
  if (!think){ block.style.display = 'none'; return; }
  block.style.display = '';
  $('.think-label', wrap).textContent = '思考过程 · ' + think.split('。')[0];
  $('.think-body', wrap).textContent = think;
}
function setRefs(wrap, refs){
  const row = $('.refs-row', wrap);
  row.innerHTML = '<span class="ref-label"></span>';
  if (!refs || !refs.length){ row.style.display = 'none'; return; }
  $('.ref-label', row).textContent = `引用 ${refs.length} 篇资料`;
  for (const r of refs){
    const card = document.createElement('div');
    card.className = 'ref-card';
    card.innerHTML = `<span class="ref-idx">${r.idx}</span><span class="rc-name"></span><span class="ref-meta">相似度 ${r.score}</span>`;
    $('.rc-name', card).textContent = `${r.doc_name}`;
    card.title = r.snippet;
    card.addEventListener('click', () => openRef(r));
    row.appendChild(card);
  }
  row.style.display = '';
}
async function openRef(r){
  let content = r.snippet || '';
  try {
    const data = await API.get('/documents/' + r.document_id);
    const chunk = (data.chunks || []).find(c => c.id === r.chunk_id);
    if (chunk) content = chunk.content;
    else content = (data.doc && data.doc.answer) || content;
  } catch { /* 无权限时展示摘要 */ }
  openDialog(`
    <h3 style="word-break:break-all">${esc(r.doc_name)}</h3>
    <p class="dlg-sub">${r.kb_name ? esc(r.kb_name) + ' · ' : ''}片段 #${(r.idx_in_doc ?? 0) + 1} · 相似度 ${r.score}</p>
    <div class="dlg-body"><div class="chunk-item" style="margin:0"><pre>${esc(content)}</pre></div></div>
    <div class="dlg-foot"><button class="btn dlg-close">关闭</button></div>`, { lg: true });
}

async function streamAnswer(text){
  const session = state.currentSession;
  state.generating = true;
  const wrap = aiBlockShell();
  const answerEl = $('.answer', wrap);
  let answer = '';
  let renderQueued = false;
  let finished = false;
  const renderAnswer = () => {
    renderQueued = false;
    answerEl.innerHTML = renderMd(answer) + (finished ? '' : '<i class="caret"></i>');
    $('#thread').scrollTop = $('#thread').scrollHeight;
  };
  const queueRender = () => {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(renderAnswer);
  };

  const btns = [$('#send-btn-2'), $('#send-btn')];
  btns.forEach(b => sendBtnStop(true, b));
  const ctrl = new AbortController();
  state.abortChat = ctrl;

  try {
    const res = await fetch(`/api/sessions/${session.id}/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + API.token },
      body: JSON.stringify({ message: text }),
      signal: ctrl.signal,
    });
    if (!res.ok){
      let msg = '请求失败';
      try { msg = (await res.json()).error || msg; } catch {}
      throw new Error(msg);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let done = false;
    while (!done){
      const { done: d, value } = await reader.read();
      if (d) break;
      buf += decoder.decode(value, { stream: true });
      const parts = buf.split('\n');
      buf = parts.pop();
      for (const line of parts){
        const s = line.trim();
        if (!s.startsWith('data:')) continue;
        let evt;
        try { evt = JSON.parse(s.slice(5)); } catch { continue; }
        if (evt.type === 'meta'){
          setThink(wrap, evt.think);
          setRefs(wrap, evt.refs);
        } else if (evt.type === 'delta'){
          answer += evt.text;
          queueRender();
        } else if (evt.type === 'tool' || evt.type === 'tool_result'){
          const line = document.createElement('div');
          line.className = 'tool-call-line' + (evt.type === 'tool_result' ? ' result' : '');
          if (evt.type === 'tool'){
            let argsShort = '';
            try { argsShort = JSON.stringify(JSON.parse(evt.args || '{}')); } catch { argsShort = String(evt.args || ''); }
            if (argsShort.length > 120) argsShort = argsShort.slice(0, 120) + '…';
            line.innerHTML = `<span class="tcl-icon">🔧</span><span>调用工具</span><b>${esc(evt.name)}</b><code>${esc(argsShort)}</code>`;
          } else {
            const r = String(evt.result || '');
            line.title = r;
            line.innerHTML = `<span class="tcl-icon">↳</span><span>「${esc(evt.name)}」返回</span><code>${esc(r.length > 160 ? r.slice(0, 160) + '…' : r)}</code>`;
          }
          $('.msg-ai-body', wrap).insertBefore(line, answerEl);
          $('#thread').scrollTop = $('#thread').scrollHeight;
        } else if (evt.type === 'error'){
          answer += (answer ? '\n\n' : '') + '⚠️ ' + evt.message;
          queueRender();
        } else if (evt.type === 'done'){
          done = true;
          finished = true;
          if (evt.message){
            state.currentMessages.push(evt.message);
            answer = evt.message.content;
            answerEl.innerHTML = renderMd(answer);
            setThink(wrap, evt.message.think);
            setRefs(wrap, evt.message.refs);
          } else if (!answer){
            answerEl.innerHTML = '<span style="color:var(--text-4)">已停止。</span>';
          }
        }
      }
    }
  } catch (e){
    finished = true;
    if (e.name === 'AbortError'){
      answer += answer ? '\n\n（已停止生成）' : '（已停止）';
      answerEl.innerHTML = renderMd(answer);
    } else {
      answerEl.innerHTML = `<span style="color:#e34d59">${esc(e.message)}</span>`;
    }
  } finally {
    state.generating = false;
    state.abortChat = null;
    btns.forEach(b => sendBtnStop(false, b));
    $$('.caret', answerEl).forEach(c => c.remove());
    $('#thread').scrollTop = $('#thread').scrollHeight;
    bindAnswerLinks(answerEl);
    // 已保存的 assistant 消息渲染引用角标
    const cites = answer.match(/\[(\d{1,2})\]/g);
    if (cites && state.currentMessages.length){
      const last = state.currentMessages[state.currentMessages.length - 1];
      if (last && last.role === 'assistant' && last.content === answer) decorateCites(answerEl, last.refs);
    }
  }
}
function decorateCites(root, refs){
  if (!refs || !refs.length) return;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  for (const node of nodes){
    const text = node.textContent;
    if (!/\[\d{1,2}\]/.test(text)) continue;
    const frag = document.createDocumentFragment();
    let last = 0;
    for (const m of text.matchAll(/\[(\d{1,2})\]/g)){
      const ref = refs.find(r => r.idx === Number(m[1]));
      if (!ref) continue;
      frag.appendChild(document.createTextNode(text.slice(last, m.index)));
      const span = document.createElement('span');
      span.className = 'cite';
      span.textContent = m[1];
      span.addEventListener('click', () => openRef(ref));
      frag.appendChild(span);
      last = m.index + m[0].length;
    }
    frag.appendChild(document.createTextNode(text.slice(last)));
    node.parentNode.replaceChild(frag, node);
  }
}
function bindAnswerLinks(root){
  $$('md-a', root).forEach(a => a.addEventListener('click', e => {
    e.preventDefault();
    window.open(a.getAttribute('data-url'), '_blank');
  }));
}

async function openSession(id){
  try {
    const data = await API.get('/sessions/' + id);
    state.currentSession = data.session;
    state.currentMessages = data.messages;
    state.pendingKbIds = data.session.kb_ids || [];
    state.mode = data.session.mode || 'reasoning';
    $('#mode-label').textContent = MODE_LABEL[state.mode];
    renderSessionBadges();
    renderKbChips($('#kb-chips'), state.pendingKbIds, false);
    renderKbChips($('#kb-chips-2'), state.pendingKbIds, !data.session.agent_id);
    renderThread(data.messages);
    renderAttachRow();
    showView('chat-session');
    renderSessions();
  } catch (e){ toast(e.message, false); }
}
function renderThread(messages){
  const inner = $('#thread-inner');
  inner.innerHTML = '';
  for (const m of messages){
    if (m.role === 'user') addUserMsg(m.content);
    else {
      const wrap = aiBlockShell();
      setThink(wrap, m.think);
      $('.answer', wrap).innerHTML = renderMd(m.content);
      setRefs(wrap, m.refs);
      decorateCites($('.answer', wrap), m.refs);
      bindAnswerLinks($('.answer', wrap));
    }
  }
  $('#thread').scrollTop = $('#thread').scrollHeight;
}
$('#clear-messages-btn').addEventListener('click', async () => {
  if (!state.currentSession) return;
  if (!confirm('清空当前会话的全部消息？')) return;
  try {
    await API.del(`/sessions/${state.currentSession.id}/messages`);
    state.currentMessages = [];
    $('#thread-inner').innerHTML = '';
    toast('消息已清空');
  } catch (e){ toast(e.message, false); }
});
$('#session-menu-btn').addEventListener('click', e => {
  if (!state.currentSession) return;
  const r = e.currentTarget.getBoundingClientRect();
  popMenu(r.left - 140, r.bottom + 4, [
    { key: 'rename', label: '重命名会话', run: renameSession },
    { key: 'clear', label: '清空消息', run: () => $('#clear-messages-btn').click() },
    '-',
    { key: 'del', label: '删除会话', danger: true, run: async () => {
      const s = state.sessions.find(x => x.id === state.currentSession.id);
      if (s){ const row = $(`[data-session="${s.id}"] .s-del`); if (row) row.click(); }
    } },
  ]);
});
function renameSession(){
  const s = state.currentSession;
  const dlg = openDialog(`
    <h3>重命名会话</h3>
    <div class="dlg-body"><label class="form-label">名称</label><input class="form-input" id="rs-name" value="${esc(s.title)}"></div>
    <div class="dlg-foot"><button class="btn dlg-close">取消</button><button class="btn primary" id="rs-save">保存</button></div>`);
  $('#rs-name', dlg).focus();
  $('#rs-save', dlg).addEventListener('click', async () => {
    try {
      const r = await API.put('/sessions/' + s.id, { title: $('#rs-name', dlg).value.trim() });
      state.currentSession = { ...state.currentSession, ...r.session };
      $('#session-title').textContent = r.session.title;
      closeDialog();
      loadSessions();
      toast('已重命名');
    } catch (e){ toast(e.message, false); }
  });
}

/* 会话附件 */
$('#attach-btn').addEventListener('click', () => $('#attach-input').click());
$('#attach-btn-2').addEventListener('click', () => $('#attach-input-2').click());
$('#attach-input').addEventListener('change', e => {
  const files = [...e.target.files];
  e.target.value = '';
  if (!files.length) return;
  state.pendingFiles.push(...files);
  renderAttachRow();
  toast('附件将在发送第一条消息后上传解析');
});
$('#attach-input-2').addEventListener('change', async e => {
  const files = [...e.target.files];
  e.target.value = '';
  if (!files.length || !state.currentSession) return;
  const fd = new FormData();
  files.forEach(f => fd.append('files', f));
  try {
    await API.upload(`/sessions/${state.currentSession.id}/attachments`, fd);
    toast('附件已上传，解析完成后自动参与检索');
    renderAttachRow();
  } catch (err2){ toast(err2.message, false); }
});
async function renderAttachRow(){
  const row = $('#attach-row-2');
  if (!row) return;
  row.innerHTML = '';
  // 新对话暂存附件
  for (const f of state.pendingFiles){
    const chip = document.createElement('span');
    chip.className = 'attach-chip busy';
    chip.innerHTML = '<span class="spin"></span><span class="a-name"></span><span class="x">×</span>';
    $('.a-name', chip).textContent = f.name;
    $('.x', chip).addEventListener('click', () => {
      state.pendingFiles = state.pendingFiles.filter(x => x !== f);
      renderAttachRow();
    });
    row.appendChild(chip);
  }
  if (!state.currentSession) return;
  try {
    const data = await API.get(`/sessions/${state.currentSession.id}/attachments`);
    for (const d of data.docs){
      const chip = document.createElement('span');
      chip.className = 'attach-chip' + (d.status === 'ready' ? '' : ' busy');
      chip.title = d.status === 'ready' ? `${d.chunk_count} 个分块已入库` : '解析中…';
      chip.innerHTML = (d.status === 'ready' ? '' : '<span class="spin"></span>') + `<span class="a-name"></span><span class="x">×</span>`;
      $('.a-name', chip).textContent = d.name;
      $('.x', chip).addEventListener('click', async () => {
        try { await API.del('/documents/' + d.id); renderAttachRow(); } catch {}
      });
      chip.addEventListener('click', () => previewDoc({ ...d, kind: d.kind }));
      row.appendChild(chip);
    }
    const busy = data.docs.some(d => d.status === 'processing' || d.status === 'pending');
    if (busy) setTimeout(renderAttachRow, 3000);
  } catch {}
}

/* ================= 智能体 ================= */
async function loadAgentsData(){
  try { state.agents = (await API.get('/agents')).agents; } catch {}
}
async function loadAgents(){
  await loadAgentsData();
  refreshBadges();
  renderAgents();
}
function renderAgents(){
  const grid = $('#agent-grid');
  grid.innerHTML = '';
  if (!state.agents.length){
    grid.innerHTML = '';
  }
  for (const a of state.agents){
    const card = document.createElement('div');
    card.className = 'agent-card';
    const color = a.color || AGENT_COLORS[0];
    card.innerHTML =
      `<div class="agent-head"><div class="agent-avatar" style="background:${color}"><svg class="ic-lg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="5" y="8" width="14" height="11" rx="3"/><path d="M12 8V5m-3.5 9h.01M15.5 14h.01"/></svg></div>` +
      `<span class="agent-name">${esc(a.name)}</span><span class="badge brand">${a.model_name || (defaultModel('chat') ? defaultModel('chat').name : '默认模型')}</span></div>` +
      `<div class="agent-desc">${esc(a.description || '暂无描述')}</div>` +
      `<div class="agent-meta"><span><svg class="ic" style="width:13px;height:13px" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="5" y="7" width="14" height="12" rx="3"/><path d="M12 4v3"/></svg>${esc(a.model_name || '默认模型')}</span>` +
      `<span><svg class="ic" style="width:13px;height:13px" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 6.5A2.5 2.5 0 0 1 6.5 4H10a2 2 0 0 1 2 2v12a2 2 0 0 0-2-2H6.5A2.5 2.5 0 0 1 4 13.5v-7zM20 6.5A2.5 2.5 0 0 0 17.5 4H14a2 2 0 0 0-2 2v12a2 2 0 0 1 2-2h4.5a2.5 2.5 0 0 0 2.5-2.5v-7z"/></svg>知识库 ${a.kb_count}</span>` +
      `<span><svg class="ic" style="width:13px;height:13px" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M14.5 6.5a4 4 0 0 1 5-3.9l-2.8 2.8 2 2L21.5 4.6a4 4 0 0 1-5.4 5L8 17.7a2 2 0 1 1-2.8-2.8l8.3-8.4z"/></svg>工具 ${a.tool_count}</span></div>`;
    card.addEventListener('click', e => {
      if (e.target.closest('.agent-menu-btn')) return;
      startAgentChat(a);
    });
    const head = $('.agent-head', card);
    const menuBtn = document.createElement('button');
    menuBtn.className = 'icon-btn agent-menu-btn';
    menuBtn.title = '更多';
    menuBtn.innerHTML = '<svg class="ic" viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/></svg>';
    menuBtn.addEventListener('click', e => {
      e.stopPropagation();
      const r = menuBtn.getBoundingClientRect();
      popMenu(r.left - 120, r.bottom + 4, [
        { key: 'chat', label: '开始对话', run: () => startAgentChat(a) },
        { key: 'edit', label: '编辑', run: () => openAgentEditor(a) },
        '-',
        { key: 'del', label: '删除', danger: true, run: async () => {
          if (!confirm(`删除智能体「${a.name}」？`)) return;
          try { await API.del('/agents/' + a.id); toast('已删除'); loadAgents(); } catch (err2){ toast(err2.message, false); }
        } },
      ]);
    });
    head.appendChild(menuBtn);
    grid.appendChild(card);
  }
  const create = document.createElement('div');
  create.className = 'create-agent-card';
  create.id = 'create-agent-card';
  create.innerHTML = '<span class="plus-ring"><svg class="ic-lg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14M5 12h14" stroke-linecap="round"/></svg></span><span style="font-weight:500">创建智能体</span><span style="font-size:12px;color:var(--text-4)">组合模型、知识库与工具</span>';
  create.addEventListener('click', () => openAgentEditor(null));
  grid.appendChild(create);
}
function startAgentChat(a){
  state.pendingKbIds = [...a.kb_ids];
  state.mode = 'reasoning';
  $('#mode-label').textContent = MODE_LABEL[state.mode];
  $('#composer-input').value = '';
  $('#thread-inner').innerHTML = '';
  API.post('/sessions', { kb_ids: a.kb_ids, agent_id: a.id, title: a.name + ' · 新对话' }).then(data => {
    state.currentSession = data.session;
    renderSessionBadges();
    $('#session-title').textContent = a.name;
    renderKbChips($('#kb-chips'), a.kb_ids, false);
    renderKbChips($('#kb-chips-2'), a.kb_ids, false);
    loadSessions();
    showView('chat-session');
    $('#composer-input-2').focus();
  }).catch(e => toast(e.message, false));
}
function openAgentEditor(a){
  const isNew = !a;
  const color = a?.color || AGENT_COLORS[Math.floor(Math.random() * AGENT_COLORS.length)];
  const chatModels = state.models.filter(m => m.kind === 'chat');
  const dlg = openDialog(`
    <h3>${isNew ? '创建智能体' : '编辑智能体'}</h3>
    <p class="dlg-sub">组合模型、知识库与工具，形成可复用的助手</p>
    <div class="dlg-body">
      <label class="form-label">名称</label>
      <input class="form-input" id="ae-name" value="${esc(a?.name || '')}" placeholder="例如：产品专家" maxlength="60">
      <label class="form-label">描述</label>
      <textarea class="form-textarea" id="ae-desc" placeholder="智能体的职责与适用场景（可选）">${esc(a?.description || '')}</textarea>
      <div class="form-row2">
        <div>
          <label class="form-label">对话模型</label>
          <select class="form-select" id="ae-model">
            <option value="">系统默认${defaultModel('chat') ? '（' + esc(defaultModel('chat').name) + '）' : ''}</option>
            ${chatModels.map(m => `<option value="${m.id}" ${a?.model === m.id ? 'selected' : ''}>${esc(m.name)}</option>`).join('')}
          </select>
        </div>
        <div>
          <label class="form-label">头像配色</label>
          <div class="form-checks" id="ae-colors" style="margin-top:6px">
            ${AGENT_COLORS.map(c => `<span class="radio-pill" data-c="${c}" style="padding:6px 10px"><span style="width:16px;height:16px;border-radius:5px;background:${c};display:inline-block"></span></span>`).join('')}
          </div>
        </div>
      </div>
      <label class="form-label">绑定知识库</label>
      <div class="form-checks" id="ae-kbs">
        ${state.kbs.map(kb => `<label class="form-check"><input type="checkbox" value="${kb.id}" ${(a?.kb_ids || []).includes(kb.id) ? 'checked' : ''}>${esc(kb.name)}</label>`).join('') || '<span class="form-hint">暂无知识库</span>'}
      </div>
      <label class="form-label">启用工具</label>
      <div class="form-checks" id="ae-tools">
        ${state.tools.map(t => `<label class="form-check"><input type="checkbox" value="${t.key}" ${(a?.tools || []).includes(t.key) ? 'checked' : ''}>${esc(t.name)}</label>`).join('') || '<span class="form-hint">工具箱为空</span>'}
      </div>
      <label class="form-label">系统提示词</label>
      <textarea class="form-textarea" id="ae-prompt" rows="5" placeholder="定义智能体的角色、语气与回答规范…">${esc(a?.system_prompt || '')}</textarea>
    </div>
    <div class="dlg-foot">
      <button class="btn dlg-close">取消</button>
      <button class="btn primary" id="ae-save">${isNew ? '创建' : '保存'}</button>
    </div>`, { lg: true });
  let selColor = color;
  $$('#ae-colors .radio-pill', dlg).forEach(p => {
    if (p.getAttribute('data-c') === color) p.classList.add('on');
    p.addEventListener('click', () => {
      $$('#ae-colors .radio-pill', dlg).forEach(x => x.classList.remove('on'));
      p.classList.add('on');
      selColor = p.getAttribute('data-c');
    });
  });
  $('#ae-save', dlg).addEventListener('click', async () => {
    const name = $('#ae-name', dlg).value.trim();
    if (!name) return toast('请填写智能体名称', false);
    const kb_ids = $$('#ae-kbs input:checked', dlg).map(i => i.value);
    const tools = $$('#ae-tools input:checked', dlg).map(i => i.value);
    const body = {
      name,
      description: $('#ae-desc', dlg).value.trim(),
      color: selColor,
      model: $('#ae-model', dlg).value,
      kb_ids,
      tools,
      system_prompt: $('#ae-prompt', dlg).value,
    };
    try {
      if (isNew) await API.post('/agents', body);
      else await API.put('/agents/' + a.id, body);
      closeDialog();
      toast(isNew ? '智能体已创建' : '已保存');
      loadAgents();
    } catch (e){ toast(e.message, false); }
  });
}
$('#create-agent-btn').addEventListener('click', () => openAgentEditor(null));

/* ================= 产物 ================= */
async function loadArtifacts(){
  try {
    const data = await API.get('/artifacts');
    renderArtifacts(data.artifacts);
  } catch {}
}
function renderArtifacts(list){
  const box = $('#artifact-box');
  if (!list.length){
    box.innerHTML = '<div class="empty-page" style="min-height:320px"><div class="empty-icon"><svg class="ic" style="width:28px;height:28px" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M8 6l-4.5 6L8 18M16 6l4.5 6L16 18" stroke-linecap="round" stroke-linejoin="round"/></svg></div><h3>暂无产物</h3><p>对话中上传的附件与生成的文件会集中出现在这里，可随时预览与下载。</p><button class="btn primary" data-nav="chat-new">开始一次对话</button></div>';
    return;
  }
  box.innerHTML = '<div class="artifact-grid"></div>';
  const grid = $('.artifact-grid', box);
  for (const a of list){
    const card = document.createElement('div');
    card.className = 'artifact-card';
    card.innerHTML = `<div class="a-name">${esc(a.name)}</div><div class="a-meta"><span>${fmtSize(a.size)}</span><span>${fmtDate(a.created_at)}</span><span class="spacer"></span></div>`;
    $('.spacer', card).style.flex = '1';
    card.addEventListener('click', () => downloadFile(`/artifacts/${a.id}/download`, null, a.name));
    card.addEventListener('contextmenu', e => {
      e.preventDefault();
      popMenu(e.clientX, e.clientY, [
        { key: 'dl', label: '下载', run: () => downloadFile(`/artifacts/${a.id}/download`, null, a.name) },
        { key: 'del', label: '删除', danger: true, run: async () => {
          try { await API.del('/artifacts/' + a.id); toast('已删除'); loadArtifacts(); } catch (err2){ toast(err2.message, false); }
        } },
      ]);
    });
    grid.appendChild(card);
  }
}
$('#artifact-upload-btn').addEventListener('click', () => $('#artifact-input').click());
$('#artifact-input').addEventListener('change', async e => {
  const files = [...e.target.files];
  e.target.value = '';
  if (!files.length) return;
  const fd = new FormData();
  fd.append('file', files[0]);
  try {
    await API.upload('/artifacts', fd);
    toast('已上传到产物库');
    loadArtifacts();
  } catch (err2){ toast(err2.message, false); }
});

/* ================= 工具箱 ================= */
const TOOL_ICONS = {
  'web-search': '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.5 2.3 3.8 5.2 3.8 8.5s-1.3 6.2-3.8 8.5c-2.5-2.3-3.8-5.2-3.8-8.5S9.5 5.8 12 3.5z"/></svg>',
  'mcp': '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3.5" y="4" width="8" height="7" rx="1.5"/><rect x="12.5" y="13" width="8" height="7" rx="1.5"/><path d="M11.5 7.5H17a2 2 0 0 1 2 2v3.5M12.5 16.5H7a2 2 0 0 1-2-2V11" stroke-linecap="round"/></svg>',
  'browser': '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="3.5"/><path d="M12 3.5v5M12 15.5v5M3.5 12h5M15.5 12h5"/></svg>',
  'custom': '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M14.5 6.5a4 4 0 0 1 5-3.9l-2.8 2.8 2 2L21.5 4.6a4 4 0 0 1-5.4 5L8 17.7a2 2 0 1 1-2.8-2.8l8.3-8.4z" stroke-linejoin="round"/></svg>',
};
async function loadTools(){
  try {
    state.tools = (await API.get('/tools')).tools;
  } catch {}
  await loadTaskRegistry();
  renderTools();
}
function renderTools(){
  const grid = $('#toolbox-grid');
  grid.innerHTML = '';
  for (const t of state.tools){
    const card = document.createElement('div');
    card.className = 'tool-card';
    const badge = t.enabled ? '<span class="badge brand">已启用</span>' : '<span class="badge">未启用</span>';
    card.innerHTML = `<div class="tool-head"><span class="tool-icon">${t.custom ? TOOL_ICONS.custom : (TOOL_ICONS[t.key] || TOOL_ICONS.mcp)}</span><span class="tool-name">${esc(t.name)}</span>${badge}${t.custom ? '<button class="tool-del" title="删除工具"><svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M6 6l12 12M18 6L6 18" stroke-linecap="round"/></svg></button>' : ''}<button class="switch${t.enabled ? ' on' : ''}" title="${t.enabled ? '关闭' : '开启'}"></button></div><div class="tool-desc">${esc(t.description)}</div>` +
      (t.key === 'web-search' && t.enabled ? '<div class="form-hint">智能体勾选「网络搜索」工具后，对话时会自动检索互联网（需在下方配置 API Key）。</div>' : '') +
      (t.key === 'mcp' || t.key === 'browser' ? '<div class="form-hint">该能力通过配置接入，当前版本为占位开关。</div>' : '') +
      (t.custom ? '<div class="form-hint">自定义 JS 工具，服务端执行。编辑智能体时勾选后，模型将在对话中按需调用。</div>' : '');
    if (t.key === 'web-search' && t.enabled){
      const cfg = t.config || {};
      const row = document.createElement('div');
      row.innerHTML = `<label class="form-label" style="margin-top:4px">Tavily API Key</label><input class="form-input" type="password" placeholder="tvly-..." value="${esc(cfg.api_key || '')}">`;
      const input = $('input', row);
      let timer = null;
      input.addEventListener('input', () => {
        clearTimeout(timer);
        timer = setTimeout(async () => {
          try { await API.put('/tools/' + t.key, { config: { api_key: input.value.trim() } }); toast('API Key 已保存'); } catch {}
        }, 600);
      });
      card.appendChild(row);
    }
    if (t.custom){
      $('.tool-del', card).addEventListener('click', async () => {
        if (!confirm(`删除工具「${t.name}」？引用它的智能体将自动移除该工具。`)) return;
        try { await API.del('/tools/custom/' + t.key.slice(7)); toast('工具已删除'); loadTools(); } catch (e){ toast(e.message, false); }
      });
    }
    $('.switch', card).addEventListener('click', async () => {
      try {
        const r = await API.put('/tools/' + t.key, { enabled: !t.enabled });
        Object.assign(t, r.tool);
        renderTools();
        toast(t.enabled ? `已启用「${t.name}」` : `已关闭「${t.name}」`);
      } catch (e){ toast(e.message, false); }
    });
    grid.appendChild(card);
  }
  const up = document.createElement('div');
  up.className = 'tool-card tool-upload';
  up.innerHTML =
    '<div class="tool-head"><span class="tool-icon">' + TOOL_ICONS.custom + '</span><span class="tool-name">上传自定义工具</span></div>' +
    '<div class="tool-desc">上传 JS 文件（<code>export default</code> 一个包含 name、description、parameters、execute(args) 的对象），上传后即可在编辑智能体时勾选，由模型在对话中调用。仅上传可信代码。</div>';
  up.addEventListener('click', () => $('#tool-file-input').click());
  grid.appendChild(up);

  const registry = state.registryTools || [];
  const counts = registry.reduce((acc, t) => { acc[t.source] = (acc[t.source] || 0) + 1; return acc; }, {});
  const regCard = document.createElement('div');
  regCard.className = 'tool-card';
  regCard.innerHTML = `<div class="tool-head"><span class="tool-icon">${TOOL_ICONS.custom}</span><span class="tool-name">统一工具注册表</span><span class="badge brand">P0-4</span></div>
    <div class="tool-desc">任务执行只认可注册表与任务快照中的工具；默认拒绝，高风险调用需要一次性审批。当前内置 ${counts.builtin || 0} · 自定义 ${counts.custom || 0} · MCP ${counts.mcp || 0}。</div>
    <div class="form-hint">${state.user?.is_admin ? '在「系统设置 → 工具注册表」查看版本、副作用与审批策略。' : '工具策略由管理员维护；如需调整请联系管理员。'}</div>`;
  if (state.user?.is_admin){
    const btn = document.createElement('button');
    btn.className = 'btn small';
    btn.textContent = '管理策略';
    btn.addEventListener('click', () => openSettings('tool-registry'));
    regCard.appendChild(btn);
  }
  grid.appendChild(regCard);
}
async function uploadToolFile(file){
  if (!file) return;
  if (file.size > 256 * 1024){ toast('文件过大（上限 256KB）', false); return; }
  try {
    const code = await file.text();
    await API.post('/tools/upload', { code });
    toast(`工具「${file.name.replace(/\.[^.]+$/, '')}」已上传`);
    await loadTools();
  } catch (e){ toast(e.message, false); }
}
$('#tool-file-input').addEventListener('change', async e => {
  const f = e.target.files && e.target.files[0];
  e.target.value = '';
  await uploadToolFile(f);
});

/* ================= 任务（Agent 平台） ================= */
const TASK_STATUS_META = {
  queued: { label: '排队中', cls: 'warn' },
  running: { label: '执行中', cls: 'brand' },
  cancel_requested: { label: '取消中', cls: 'warn' },
  waiting_approval: { label: '待审批', cls: 'warn' },
  waiting_input: { label: '等待输入', cls: 'warn' },
  completed: { label: '已完成', cls: 'brand' },
  failed: { label: '失败', cls: 'error' },
  cancelled: { label: '已取消', cls: '' },
};
const TASK_FILTERS = {
  running: ['queued', 'running', 'cancel_requested', 'waiting_input'],
  waiting_approval: ['waiting_approval'],
  finished: ['completed', 'failed', 'cancelled'],
};
const TASK_EVENT_LABELS = {
  'task.created': '任务创建',
  'task.queued': '任务入队',
  'task.resumed': '任务恢复',
  'task.cancelled': '任务取消',
  'task.failed': '任务失败',
  'task.waiting_approval': '等待审批',
  'task.waiting_input': '等待输入',
  'tool.snapshot': '工具快照',
  'tool.requested': '请求工具',
  'tool.started': '开始执行工具',
  'tool.completed': '工具完成',
  'tool.failed': '工具失败',
  'policy.denied': '策略拒绝',
  'policy.scope_reduced': '范围收紧',
  'approval.decided': '审批结果',
  'evidence.retrieved': '检索证据',
  'evidence.version_changed': '证据版本变化',
  'message.created': '消息',
  'instruction.received': '收到指令',
  'input.received': '收到输入',
};

function taskStatusMeta(status){
  return TASK_STATUS_META[status] || { label: status || '未知', cls: '' };
}
function taskBadge(status){
  const meta = taskStatusMeta(status);
  return `<span class="badge ${meta.cls}">${esc(meta.label)}</span>`;
}
function shortId(id){
  const s = String(id || '');
  return s.length > 8 ? s.slice(0, 8) : s;
}
function shortHash(h){
  const s = String(h || '');
  return s.length > 16 ? s.slice(0, 16) + '…' : s;
}
function fmtMs(ms){
  const n = Number(ms) || 0;
  if (n < 1000) return n + ' ms';
  if (n < 60000) return (n / 1000).toFixed(1) + ' s';
  return Math.floor(n / 60000) + ' 分 ' + Math.round((n % 60000) / 1000) + ' 秒';
}
function taskMatchesFilter(t){
  if (state.taskFilter === 'all') return true;
  return (TASK_FILTERS[state.taskFilter] || []).includes(t.status);
}
function taskFromList(id){
  return state.tasks.find(t => t.id === id) || null;
}

async function loadTasks(){
  const box = $('#task-list');
  if (box) box.innerHTML = '<div class="task-loading">加载中…</div>';
  try {
    const d = await API.get('/tasks?limit=50');
    state.platformAvailable = true;
    state.tasks = d.tasks || [];
    renderTasks();
    loadTaskBadges();
  } catch (e){
    if (/不存在/.test(e.message)) state.platformAvailable = false;
    renderTasks(e);
  }
}
function renderTasks(err){
  const box = $('#task-list');
  if (!box) return;
  const q = ($('#task-search')?.value || '').trim().toLowerCase();
  const matched = state.tasks.filter(t => taskMatchesFilter(t)
    && (!q || String(t.title || '').toLowerCase().includes(q)
      || String(t.goal || '').toLowerCase().includes(q)));
  const counts = { all: state.tasks.length };
  for (const key of Object.keys(TASK_FILTERS)){
    counts[key] = state.tasks.filter(t => TASK_FILTERS[key].includes(t.status)).length;
  }
  $$('#task-tabs [data-filter]').forEach(btn => {
    const f = btn.getAttribute('data-filter');
    btn.classList.toggle('active', f === state.taskFilter);
    const countEl = $('[data-task-count]', btn);
    if (countEl) countEl.textContent = counts[f] || 0;
  });

  if (!state.platformAvailable){
    box.innerHTML = '<div class="empty-page task-empty"><div class="empty-icon">' + taskEmptyIcon() + '</div>'
      + '<h3>Agent 平台未启用</h3>'
      + '<p>任务、工具审批与 Agent 运行需要 PostgreSQL 控制面。设置 <code>AGENT_PLATFORM_ENABLED=1</code> 与 <code>DATABASE_URL</code>，执行 <code>npm run db:migrate</code>，并启动 <code>npm run worker</code> 后刷新。</p>'
      + '</div>';
    return;
  }
  if (err){
    box.innerHTML = `<div class="empty-page task-empty"><div class="empty-icon">${taskEmptyIcon()}</div><h3>任务读取失败</h3><p>${esc(err.message)}</p><button class="btn" id="task-retry">重试</button></div>`;
    $('#task-retry')?.addEventListener('click', loadTasks);
    return;
  }
  if (!matched.length){
    box.innerHTML = '<div class="empty-page task-empty"><div class="empty-icon">' + taskEmptyIcon() + '</div>'
      + `<h3>${state.tasks.length ? '没有符合条件的任务' : '还没有任务'}</h3>`
      + '<p>新建任务后，后台 Worker 会领取执行；遇到高风险工具调用会暂停并等待你审批。</p>'
      + '<button class="btn primary" id="task-empty-create">新建任务</button></div>';
    $('#task-empty-create')?.addEventListener('click', openCreateTask);
    return;
  }
  box.innerHTML = '<div class="task-list">' + matched.map(t => {
    const meta = taskStatusMeta(t.status);
    const usage = t.usage || {};
    return `<div class="task-row task-status-${esc(t.status)}" data-task-id="${esc(t.id)}">
      <span class="task-status-dot ${esc(meta.cls)}"></span>
      <div class="task-row-main">
        <div class="task-row-title">${esc(t.title || t.goal || '未命名任务')}</div>
        <div class="task-row-meta">
          <span class="mono">${esc(shortId(t.id))}</span>
          <span>${esc(meta.label)}</span>
          <span>工具 ${Number(usage.tool_calls) || 0}</span>
          <span>步骤 ${Number(usage.steps) || 0}</span>
          <span>${esc(relTime(new Date(t.updated_at || t.created_at).getTime()))}</span>
        </div>
      </div>
      ${t.status === 'waiting_approval' ? '<span class="badge warn">需要审批</span>' : ''}
      <span class="badge ${meta.cls}">${esc(meta.label)}</span>
      <svg class="task-arrow ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M9 6l6 6-6 6" stroke-linecap="round" stroke-linejoin="round"/></svg>
    </div>`;
  }).join('') + '</div>';
  $$('.task-row', box).forEach(row => row.addEventListener('click', () => openTask(row.getAttribute('data-task-id'))));
  if ($('#task-search')) $('#task-search').value = q;
}
function taskEmptyIcon(){
  return '<svg class="ic" style="width:28px;height:28px" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M6 4.5h12a1.5 1.5 0 0 1 1.5 1.5v13L12 15.5 4.5 19V6A1.5 1.5 0 0 1 6 4.5z" stroke-linejoin="round"/><path d="M8 8.5h8M8 12h5" stroke-linecap="round"/></svg>';
}

$('#task-refresh-btn').addEventListener('click', () => loadTasks());
$('#create-task-btn').addEventListener('click', () => openCreateTask());
$('#task-tabs').addEventListener('click', e => {
  const btn = e.target.closest('[data-filter]');
  if (!btn) return;
  state.taskFilter = btn.getAttribute('data-filter');
  renderTasks();
});
$('#task-search').addEventListener('input', () => renderTasks());

async function loadTaskRegistry(){
  try {
    state.registryTools = (await API.get('/tools/registry')).tools || [];
  } catch { state.registryTools = []; }
  return state.registryTools;
}

async function openCreateTask(){
  const tools = await loadTaskRegistry();
  const defaults = new Set(['knowledge.search', 'knowledge.get_document', 'knowledge.get_citation', 'knowledge.list_bases']);
  const dlg = openDialog(`
    <h3>新建任务</h3>
    <p class="dlg-sub">任务会进入队列，由 Worker 领取执行；工具调用经过策略判定，高风险操作自动暂停等待审批。</p>
    <div class="dlg-body">
      <label class="form-label">目标</label>
      <textarea class="form-textarea" id="ct-goal" rows="4" placeholder="例如：梳理知识库中的合同条款，列出付款义务与违约风险"></textarea>
      <label class="form-label">标题（可选）</label>
      <input class="form-input" id="ct-title" placeholder="自动使用目标摘要">
      <label class="form-label">审批模式</label>
      <select class="form-select" id="ct-approval">
        <option value="">按策略决定（推荐）</option>
        <option value="always">始终审批</option>
        <option value="never">从不审批（不降级高风险）</option>
      </select>
      <label class="form-label">知识范围</label>
      <select class="form-select" id="ct-kb-mode">
        <option value="visible">全部可见知识库</option>
        <option value="explicit">指定知识库</option>
        <option value="none">不使用知识库</option>
      </select>
      <div class="form-checks hide" id="ct-kb-list" style="margin-top:8px">
        ${(state.kbs || []).map(kb => `<label class="form-check"><input type="checkbox" value="${esc(kb.id)}">${esc(kb.name)}</label>`).join('') || '<span class="form-hint">暂无知识库</span>'}
      </div>
      <label class="form-label">可用工具</label>
      <p class="form-hint" style="margin-top:0;margin-bottom:6px">不勾选时使用默认的 4 个只读知识工具。自定义工具与 MCP 工具需先在后台注册。</p>
      <div class="task-tool-picker" id="ct-tools">
        ${tools.length ? tools.map(t => `<label class="form-check task-tool-option">
          <input type="checkbox" value="${esc(t.name)}" ${defaults.has(t.name) ? 'checked' : ''}>
          <span class="mono">${esc(t.name)}</span>
          <span class="badge">${esc(t.source || 'builtin')}</span>
          <span class="badge ${t.side_effect === 'read' ? '' : 'warn'}">${esc(t.side_effect || 'read')}</span>
        </label>`).join('') : '<span class="form-hint">工具注册表不可用，将使用默认知识工具。</span>'}
      </div>
    </div>
    <div class="dlg-foot">
      <button class="btn dlg-close">取消</button>
      <button class="btn primary" id="ct-create">创建任务</button>
    </div>`, { lg: true });
  $('#ct-goal', dlg).focus();
  $('#ct-kb-mode', dlg).addEventListener('change', e => {
    $('#ct-kb-list', dlg).classList.toggle('hide', e.target.value !== 'explicit');
  });
  $('#ct-create', dlg).addEventListener('click', async () => {
    const goal = $('#ct-goal', dlg).value.trim();
    if (!goal) return toast('请填写任务目标', false);
    const body = { goal, title: $('#ct-title', dlg).value.trim() };
    const approval = $('#ct-approval', dlg).value;
    if (approval) body.approval_mode = approval;
    const kbMode = $('#ct-kb-mode', dlg).value;
    const kbIds = $$('#ct-kb-list input:checked', dlg).map(i => i.value);
    if (kbMode === 'explicit' && !kbIds.length) return toast('请选择至少一个知识库', false);
    body.kb_scope = {
      mode: kbMode,
      ...(kbMode === 'explicit' ? { kb_ids: kbIds } : {}),
      version_policy: 'pin_on_first_use',
    };
    const selected = $$('#ct-tools input:checked', dlg).map(i => i.value);
    if (selected.length) body.tools = selected;
    try {
      const r = await API.post('/tasks', body);
      closeDialog();
      toast('任务已创建');
      await loadTasks();
      openTask(r.task.id);
    } catch (e){ toast(e.message, false); }
  });
}

async function openTask(id){
  state.currentTask = { id };
  state.taskEvents = [];
  state.taskMessages = [];
  state.taskEvidence = [];
  showView('task-detail');
  $('#task-detail-title').textContent = '加载中…';
  $('#task-detail-status').innerHTML = '';
  $('#task-detail-meta').textContent = '';
  $('#task-detail-actions').innerHTML = '';
  ['task-approval-card', 'task-messages-card', 'task-events-card', 'task-plan-card', 'task-tools-card', 'task-evidence-card', 'task-usage-card']
    .forEach(el => { $('#' + el).innerHTML = '<div class="task-loading">加载中…</div>'; });
  await refreshTaskDetail(true);
  if (state.currentTask?.id === id) connectTaskStream(id);
}

async function refreshTaskDetail(full = false){
  const id = state.currentTask?.id;
  if (!id) return;
  try {
    const d = await API.get('/tasks/' + id);
    if (state.currentTask?.id !== id) return;
    state.currentTask = d.task;
    if (full){
      await Promise.all([loadTaskMessages(id), loadTaskEvents(id), loadTaskEvidence(id)]);
    }
    renderTaskDetail();
  } catch (e){
    if (state.currentTask?.id !== id) return;
    const meta = taskStatusMeta(state.currentTask.status);
    $('#task-detail-title').textContent = state.currentTask.title || '任务';
    $('#task-detail-status').innerHTML = taskBadge(state.currentTask.status || meta.label);
    $('#task-detail-meta').textContent = e.message;
    $('#task-detail-actions').innerHTML = '<button class="btn" data-nav="tasks">返回任务列表</button>';
  }
}

async function loadTaskMessages(id){
  try {
    const d = await API.get(`/tasks/${id}/messages?limit=200`);
    if (state.currentTask?.id === id) state.taskMessages = d.messages || [];
  } catch {
    if (state.currentTask?.id === id) state.taskMessages = [];
  }
}
async function loadTaskEvents(id){
  try {
    let after = 0;
    const all = [];
    for (let i = 0; i < 10; i++){
      const d = await API.get(`/tasks/${id}/events/history?after=${after}&limit=200`);
      all.push(...(d.events || []));
      if (!d.events?.length || d.last_seq >= d.latest_seq) break;
      after = d.last_seq;
    }
    if (state.currentTask?.id === id) state.taskEvents = all.sort((a, b) => a.seq - b.seq);
  } catch {
    if (state.currentTask?.id === id) state.taskEvents = [];
  }
}
async function loadTaskEvidence(id){
  try {
    const d = await API.get(`/tasks/${id}/evidence?limit=100`);
    if (state.currentTask?.id === id) state.taskEvidence = d.evidence || [];
  } catch {
    if (state.currentTask?.id === id) state.taskEvidence = [];
  }
}

function renderTaskDetail(){
  const task = state.currentTask;
  if (!task || !task.id) return;
  $('#task-detail-title').textContent = task.title || task.goal || '未命名任务';
  $('#task-detail-status').innerHTML = taskBadge(task.status);
  const bits = [
    '#' + shortId(task.id),
    '创建于 ' + fmtTime(task.created_at),
    '更新于 ' + fmtTime(task.updated_at),
    task.recovery_count ? `崩溃恢复 ${task.recovery_count} 次` : '',
    task.resume_count ? `手动恢复 ${task.resume_count} 次` : '',
    task.last_error ? `错误 ${task.last_error.code}` : '',
  ].filter(Boolean);
  $('#task-detail-meta').textContent = bits.join(' · ');
  const actions = [];
  if (task.permissions?.can_cancel) actions.push('<button class="btn" id="task-cancel-btn">取消任务</button>');
  if (task.permissions?.can_resume) actions.push('<button class="btn primary" id="task-resume-btn">恢复任务</button>');
  actions.push('<button class="btn small" id="task-detail-refresh">刷新</button>');
  $('#task-detail-actions').innerHTML = actions.join('');
  $('#task-cancel-btn')?.addEventListener('click', () => taskAction('cancel'));
  $('#task-resume-btn')?.addEventListener('click', () => taskAction('resume'));
  $('#task-detail-refresh')?.addEventListener('click', () => refreshTaskDetail(true));

  renderTaskPending(task);
  renderTaskMessages(task);
  renderTaskEvents();
  renderTaskPlan(task);
  renderTaskTools(task);
  renderTaskEvidence(task);
  renderTaskUsage(task);
}

function renderTaskPending(task){
  const card = $('#task-approval-card');
  const approval = task.pending?.approval;
  const input = task.pending?.input;
  if (!approval && !input){
    card.innerHTML = '<div class="task-card-head"><span class="task-card-title">待处理</span></div><p class="task-muted">暂无待处理的审批或输入请求。</p>';
    return;
  }
  if (approval){
    const req = approval.request || {};
    const risk = approval.risk_level || 'medium';
    card.innerHTML = `<div class="task-card-head"><span class="task-card-title">需要审批</span><span class="badge warn">${esc(risk)} risk</span></div>
      <div class="task-approval-box">
        <div class="task-approval-tool"><span class="mono">${esc(req.tool_name || '未知工具')}</span><span class="badge">${esc(req.side_effect || '')}</span></div>
        <div class="task-kv"><span>调用参数</span></div>
        <pre class="task-args">${esc(JSON.stringify(approval['arguments'] ?? {}, null, 2))}</pre>
        <div class="task-kv"><span>审批模式</span><b>${esc(req.approval_mode || '—')}</b></div>
        <div class="task-kv"><span>参数哈希</span><code class="task-hash">${esc(approval.args_hash || req.args_hash || '')}</code></div>
        <div class="task-kv"><span>过期时间</span><b>${esc(fmtTime(approval.expires_at))}</b></div>
        <p class="form-hint">审批只对当前工具调用与参数哈希生效；参数变化后旧审批自动失效。</p>
        <div class="task-approval-actions">
          ${task.permissions?.can_approve
            ? '<button class="btn" id="task-deny-btn">拒绝</button><button class="btn primary" id="task-approve-btn">批准并执行</button>'
            : '<span class="form-hint">当前用户无权审批此请求（不能审批自己发起的请求）。</span>'}
        </div>
      </div>`;
    $('#task-approve-btn')?.addEventListener('click', () => decideTaskApproval(approval.id, 'approve'));
    $('#task-deny-btn')?.addEventListener('click', () => decideTaskApproval(approval.id, 'deny'));
  }
  if (input){
    const schema = input.input_schema || {};
    const props = schema.properties || {};
    const required = new Set(schema.required || []);
    const fields = Object.entries(props).map(([key, def]) => {
      const req = required.has(key) ? ' <span class="task-required">*</span>' : '';
      if (def.type === 'boolean'){
        return `<label class="form-check" style="margin-top:10px"><input type="checkbox" data-input-key="${esc(key)}" data-input-type="boolean"> ${esc(def.title || key)}${req}</label>`;
      }
      if (def.enum){
        return `<label class="form-label">${esc(def.title || key)}${req}</label><select class="form-select" data-input-key="${esc(key)}" data-input-type="string">${def.enum.map(v => `<option value="${esc(v)}">${esc(v)}</option>`).join('')}</select>`;
      }
      const type = ['number', 'integer', 'array'].includes(def.type) ? def.type : 'string';
      return `<label class="form-label">${esc(def.title || key)}${req}</label><input class="form-input" data-input-key="${esc(key)}" data-input-type="${type}" placeholder="${esc(def.description || (type === 'array' ? '多个值用逗号分隔' : ''))}">`;
    }).join('');
    card.innerHTML = `<div class="task-card-head"><span class="task-card-title">等待输入</span><span class="badge warn">Agent 提问</span></div>
      <p class="task-question">${esc(input.question || 'Agent 需要补充信息')}</p>
      ${fields || '<p class="task-muted">该请求没有声明输入字段。</p>'}
      <div class="task-approval-actions"><button class="btn primary" id="task-input-submit">提交输入</button></div>`;
    $('#task-input-submit')?.addEventListener('click', () => submitTaskInput(input.id, schema));
  }
}

async function decideTaskApproval(approvalId, decision){
  const approval = state.currentTask?.pending?.approval;
  if (!approval) return;
  const verb = decision === 'approve' ? '批准' : '拒绝';
  if (!confirm(`确认${verb}这次工具调用？`)) return;
  try {
    await API.post(`/approvals/${approvalId}/decision`, {
      decision, args_hash: approval.args_hash,
    });
    toast(decision === 'approve' ? '已批准，任务将重新入队执行' : '已拒绝，任务将取消');
    await refreshTaskDetail(true);
    loadTaskBadges();
    loadTasks();
  } catch (e){ toast(e.message, false); }
}
async function submitTaskInput(requestId, schema){
  const values = {};
  try {
    $$('#task-approval-card [data-input-key]').forEach(el => {
      const key = el.getAttribute('data-input-key');
      const type = el.getAttribute('data-input-type');
      if (type === 'boolean') values[key] = !!el.checked;
      else if (type === 'number' || type === 'integer'){
        if (el.value === '') return;
        const n = Number(el.value);
        if (!Number.isFinite(n)) throw new Error(`${key} 必须是数字`);
        values[key] = type === 'integer' ? Math.trunc(n) : n;
      } else if (type === 'array'){
        values[key] = el.value.split(/[,，\n]/).map(v => v.trim()).filter(Boolean);
      } else values[key] = el.value;
    });
  } catch (e){ return toast(e.message, false); }
  try {
    await API.post(`/tasks/${state.currentTask.id}/input`, { request_id: requestId, values });
    toast('输入已提交，任务将重新入队');
    await refreshTaskDetail(true);
    loadTaskBadges();
  } catch (e){ toast(e.message, false); }
}
async function taskAction(action){
  const task = state.currentTask;
  if (!task) return;
  const label = action === 'cancel' ? '取消' : '恢复';
  if (!confirm(`确认${label}任务「${task.title || shortId(task.id)}」？`)) return;
  try {
    await API.post(`/tasks/${task.id}/${action}`, {});
    toast(`任务已${label}`);
    await refreshTaskDetail(true);
    loadTasks();
  } catch (e){ toast(e.message, false); }
}

function renderTaskMessages(task){
  const card = $('#task-messages-card');
  const msgs = state.taskMessages;
  const roleLabel = { user: '用户', assistant: 'Agent', tool: '工具', system: '系统' };
  const list = msgs.length
    ? msgs.map(m => `<div class="task-msg task-msg-${esc(m.role)}">
        <div class="task-msg-head"><span>${esc(roleLabel[m.role] || m.role)}</span><span class="mono">#${esc(String(m.seq ?? ''))}</span></div>
        <div class="task-msg-body">${esc(m.content || '')}</div>
      </div>`).join('')
    : '<p class="task-muted">暂无消息。Worker 执行后会在这里显示模型输出与工具结果。</p>';
  const terminal = ['completed', 'failed', 'cancelled'].includes(task.status);
  card.innerHTML = `<div class="task-card-head"><span class="task-card-title">对话与工具结果</span><span class="badge">${msgs.length}</span></div>
    <div class="task-msg-list">${list}</div>
    <div class="task-instruction">
      <input class="form-input" id="task-instruction-input" placeholder="给 Agent 发送补充指令…" ${terminal ? 'disabled' : ''}>
      <button class="btn primary" id="task-instruction-send" ${terminal ? 'disabled' : ''}>发送</button>
    </div>`;
  const send = async () => {
    const text = $('#task-instruction-input').value.trim();
    if (!text) return;
    try {
      await API.post(`/tasks/${task.id}/messages`, { content: text });
      $('#task-instruction-input').value = '';
      toast('指令已发送');
      await loadTaskMessages(task.id);
      renderTaskMessages(task);
    } catch (e){ toast(e.message, false); }
  };
  $('#task-instruction-send')?.addEventListener('click', send);
  $('#task-instruction-input')?.addEventListener('keydown', e => { if (e.key === 'Enter') send(); });
}

function renderTaskEvents(){
  const card = $('#task-events-card');
  const events = state.taskEvents;
  if (!events.length){
    card.innerHTML = '<div class="task-card-head"><span class="task-card-title">事件时间线</span></div><p class="task-muted">暂无事件。</p>';
    return;
  }
  const rows = [...events].reverse().map(ev => {
    const label = TASK_EVENT_LABELS[ev.type] || ev.type;
    const p = ev.payload || {};
    const detail = p.tool_name || p.decision || p.error_code || p.question || p.content_preview || p.approval_id || '';
    const cls = ev.type.startsWith('tool.') ? 'tool' : ev.type.startsWith('approval.') ? 'approval'
      : ev.type === 'policy.denied' ? 'denied' : ev.type.startsWith('task.') ? 'task' : '';
    return `<div class="task-event ${cls}">
      <span class="task-event-seq mono">#${esc(String(ev.seq))}</span>
      <span class="task-event-dot"></span>
      <div class="task-event-main"><div class="task-event-title">${esc(label)}${p.actor_type ? '' : ''}</div>
        <div class="task-event-detail">${detail ? esc(String(detail).slice(0, 200)) : ''}${p.args_hash ? ' · ' + esc(shortHash(p.args_hash)) : ''}</div>
      </div>
      <span class="task-event-time">${esc(fmtTime(ev.ts))}</span>
    </div>`;
  }).join('');
  card.innerHTML = `<div class="task-card-head"><span class="task-card-title">事件时间线</span><span class="badge">${events.length}</span></div><div class="task-event-list">${rows}</div>`;
}

function renderTaskPlan(task){
  const card = $('#task-plan-card');
  const plan = task.plan || [];
  if (!plan.length){
    card.innerHTML = '<div class="task-card-head"><span class="task-card-title">执行计划</span></div><p class="task-muted">模型尚未生成计划。</p>';
    return;
  }
  card.innerHTML = `<div class="task-card-head"><span class="task-card-title">执行计划</span><span class="badge">${plan.length}</span></div>
    <div class="task-plan-list">${plan.map(p => `<div class="task-plan-item">
      <span class="task-plan-dot ${esc(p.status || '')}"></span>
      <div><div class="task-plan-title">${esc(p.title)}</div>${p.description ? `<div class="task-plan-desc">${esc(p.description)}</div>` : ''}</div>
      <span class="badge">${esc(p.status || '')}</span>
    </div>`).join('')}</div>`;
}
function renderTaskTools(task){
  const card = $('#task-tools-card');
  const tools = task.tools || [];
  if (!tools.length){
    card.innerHTML = '<div class="task-card-head"><span class="task-card-title">工具快照</span></div><p class="task-muted">该任务没有工具。</p>';
    return;
  }
  card.innerHTML = `<div class="task-card-head"><span class="task-card-title">工具快照</span><span class="badge">${tools.length}</span></div>
    <div class="task-tool-list">${tools.map(t => `<div class="task-tool-item">
      <div class="task-tool-name"><span class="mono">${esc(t.name)}</span><span class="badge">${esc(t.source || '')}</span></div>
      <div class="task-tool-meta">v${esc(t.version || '1.0.0')} · ${esc(t.side_effect || 'read')} · ${esc(t.approval_policy || '')}</div>
      ${t.description ? `<div class="task-tool-desc">${esc(t.description)}</div>` : ''}
      <div class="task-tool-hash mono">${esc(shortHash(t.schema_hash))}</div>
    </div>`).join('')}</div>`;
}
function renderTaskEvidence(task){
  const card = $('#task-evidence-card');
  const list = state.taskEvidence;
  card.innerHTML = `<div class="task-card-head"><span class="task-card-title">证据</span><span class="badge">${Number(task.evidence_count) || list.length}</span></div>`
    + (list.length ? `<div class="task-evidence-list">${list.map(e => `<div class="task-evidence-item">
        <div class="task-evidence-meta"><span>${esc(e.kb_id || '')}</span><span>${esc(e.document_id || '')}${e.document_version != null ? ' v' + esc(String(e.document_version)) : ''}</span>${e.score != null ? `<span>${Number(e.score).toFixed(3)}</span>` : ''}</div>
        <div class="task-evidence-excerpt">${esc(e.excerpt || '')}</div>
      </div>`).join('')}</div>` : '<p class="task-muted">尚未检索到证据。</p>');
}
function renderTaskUsage(task){
  const card = $('#task-usage-card');
  const u = task.usage || {};
  const items = [
    ['步骤', u.steps], ['模型调用', u.model_calls], ['工具调用', u.tool_calls],
    ['输入 tokens', u.input_tokens], ['输出 tokens', u.output_tokens], ['耗时', u.wall_ms ? fmtMs(u.wall_ms) : '—'],
  ];
  card.innerHTML = `<div class="task-card-head"><span class="task-card-title">用量</span></div>
    <div class="task-usage-grid">${items.map(([k, v]) => `<div class="task-usage-item"><div class="task-usage-k">${esc(k)}</div><div class="task-usage-v">${esc(String(v ?? 0))}</div></div>`).join('')}</div>
    <div class="task-kv" style="margin-top:10px"><span>事件序号</span><b>${esc(String(task.last_event_seq ?? 0))}</b></div>
    <div class="task-kv"><span>检查点步骤</span><b>${esc(String(task.checkpoint_step ?? 0))}</b></div>`;
}

function closeTaskStream(){
  if (state.taskStream){
    try { state.taskStream.abort(); } catch {}
    state.taskStream = null;
  }
  if (state.taskPollTimer){
    clearTimeout(state.taskPollTimer);
    state.taskPollTimer = null;
  }
}
let taskRefreshTimer = null;
function scheduleTaskRefresh(){
  clearTimeout(taskRefreshTimer);
  taskRefreshTimer = setTimeout(() => { refreshTaskDetail(false); }, 250);
}
async function connectTaskStream(taskId){
  closeTaskStream();
  const lastSeq = state.taskEvents.length ? state.taskEvents[state.taskEvents.length - 1].seq : 0;
  const ctrl = new AbortController();
  state.taskStream = ctrl;
  let gotAny = false;
  try {
    const res = await fetch(`/api/tasks/${taskId}/events?after=${Number(lastSeq) || 0}`, {
      headers: { Authorization: 'Bearer ' + API.token },
      signal: ctrl.signal,
    });
    if (!res.ok || !res.body) throw new Error('SSE unavailable');
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    while (true){
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n\n')) >= 0){
        const chunk = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        handleTaskStreamChunk(chunk);
        gotAny = true;
      }
    }
    state.taskStream = null;
    if (currentView === 'task-detail' && state.currentTask?.id === taskId){
      await refreshTaskDetail(false);
      scheduleTaskPoll(taskId);
    }
  } catch (e){
    if (e.name === 'AbortError') return;
    state.taskStream = null;
    scheduleTaskPoll(taskId);
  }
  if (!gotAny && currentView === 'task-detail' && state.currentTask?.id === taskId) scheduleTaskPoll(taskId);
}
function scheduleTaskPoll(taskId){
  if (state.taskPollTimer) clearTimeout(state.taskPollTimer);
  state.taskPollTimer = setTimeout(async () => {
    state.taskPollTimer = null;
    if (currentView !== 'task-detail' || state.currentTask?.id !== taskId) return;
    await refreshTaskDetail(false);
    if (!['completed', 'failed', 'cancelled'].includes(state.currentTask?.status)) scheduleTaskPoll(taskId);
  }, 3000);
}
function handleTaskStreamChunk(chunk){
  let ev = 'message';
  let data = null;
  for (const line of chunk.split('\n')){
    if (line.startsWith('event: ')) ev = line.slice(7).trim();
    else if (line.startsWith('data: ')) data = line.slice(6);
  }
  if (!data) return;
  if (ev === 'end' || ev === 'gap'){
    refreshTaskDetail(false).then(() => loadTaskBadges());
    return;
  }
  if (ev === 'error') return;
  let payload;
  try { payload = JSON.parse(data); } catch { return; }
  if (payload?.seq && !state.taskEvents.some(e => e.seq === payload.seq)) state.taskEvents.push(payload);
  if (ev === 'message.created'){
    loadTaskMessages(state.currentTask.id).then(() => renderTaskMessages(state.currentTask));
    scheduleTaskRefresh();
  } else if (ev === 'evidence.retrieved'){
    loadTaskEvidence(state.currentTask.id).then(() => renderTaskEvidence(state.currentTask));
    scheduleTaskRefresh();
  } else {
    scheduleTaskRefresh();
  }
  if (ev.startsWith('tool.') || ev === 'approval.decided' || ev === 'policy.denied') renderTaskEvents();
  if (ev === 'task.waiting_approval' || ev === 'task.waiting_input' || ev === 'task.completed' || ev === 'task.failed' || ev === 'task.cancelled'){
    loadTaskBadges();
  }
}

/* ================= Agent 平台管理 ================= */
function adminPlaceholder(box, { title = '需要管理员权限', text = '当前账户没有访问该配置的权限。', action = '' } = {}){
  box.innerHTML = `<div class="settings-placeholder"><div class="empty-icon"><svg class="ic" style="width:28px;height:28px" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="5" y="10" width="14" height="10" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></svg></div><h3>${esc(title)}</h3><p>${esc(text)}</p>${action}</div>`;
}
function platformDisabledHint(e){
  return /不存在/.test(String(e?.message || ''));
}

/* ---------- 工具注册表 ---------- */
async function renderToolRegistryPane(){
  const box = $('#settings-content');
  if (!state.user?.is_admin){
    adminPlaceholder(box, { title: '需要管理员权限', text: '工具策略仅平台管理员或组织 owner/admin 可配置。' });
    return;
  }
  box.innerHTML = '<div class="settings-section-title">统一工具注册表</div><p class="form-hint">任务创建时会把工具完整描述快照到任务中；执行时再次校验版本与哈希。默认策略为拒绝，未注册或已停用的工具无法被调用。</p><div id="registry-pane"><div class="task-loading">加载中…</div></div>';
  const pane = $('#registry-pane');
  try {
    const d = await API.get('/tools/registry');
    state.registryTools = d.tools || [];
  } catch (e){
    if (platformDisabledHint(e)) return adminPlaceholder(pane, { title: 'Agent 平台未启用', text: '设置 AGENT_PLATFORM_ENABLED=1 与 DATABASE_URL 后重试。' });
    return adminPlaceholder(pane, { title: '读取失败', text: e.message });
  }
  if (!state.registryTools.length){
    pane.innerHTML = '<p class="form-hint">注册表为空。内置知识工具会随服务启动自动提供；自定义工具在工具箱上传；MCP 工具在连接刷新后写入。</p>';
    return;
  }
  const groups = { builtin: [], custom: [], mcp: [] };
  for (const t of state.registryTools) (groups[t.source] || (groups[t.source] = [])).push(t);
  const section = (title, list) => list.length ? `<div class="settings-section-title">${title}</div><div class="registry-list">${list.map(t => {
    const risky = t.side_effect && t.side_effect !== 'read';
    return `<div class="registry-row">
      <div class="registry-main">
        <div class="registry-name"><span class="mono">${esc(t.name)}</span><span class="badge">${esc(t.source)}</span><span class="badge">v${esc(t.version || '1.0.0')}</span><span class="badge ${risky ? 'warn' : 'brand'}">${esc(t.side_effect || 'read')}</span>${t.enabled === false ? '<span class="badge error">已停用</span>' : ''}</div>
        <div class="registry-desc">${esc(t.description || '暂无描述')}</div>
        <div class="registry-meta">审批策略 ${esc(t.approval_policy || '—')} · schema ${esc(shortHash(t.schema_hash))}${t.owner_id ? ' · owner ' + esc(shortId(t.owner_id)) : ''}</div>
      </div>
      <button class="btn small" data-policy="${esc(t.name)}">策略</button>
    </div>`;
  }).join('')}</div>` : '';
  pane.innerHTML = section('内置工具', groups.builtin) + section('自定义工具', groups.custom) + section('MCP 工具', groups.mcp) + section('其他', groups.other || []);
  $$('[data-policy]', pane).forEach(btn => btn.addEventListener('click', () => openToolPolicyDialog(btn.getAttribute('data-policy'))));
}

async function openToolPolicyDialog(name){
  const tool = state.registryTools.find(t => t.name === name);
  if (!tool) return;
  let policies = [];
  try { policies = (await API.get(`/tools/registry/${encodeURIComponent(name)}/policies`)).policies || []; } catch {}
  const tenantPolicy = policies.find(p => p.principal_type === 'tenant') || policies[0] || {};
  const scopes = Array.isArray(tenantPolicy.allowed_scopes) ? tenantPolicy.allowed_scopes.join(', ') : '';
  const dlg = openDialog(`
    <h3>工具策略</h3>
    <p class="dlg-sub mono">${esc(name)}</p>
    <div class="dlg-body">
      <div class="dialog-note">策略优先级：user &gt; role &gt; preset &gt; tenant。未配置时默认按工具风险判断；高风险副作用始终需要审批。</div>
      <div class="form-row2">
        <div>
          <label class="form-label">主体类型</label>
          <select class="form-select" id="tp-type">
            <option value="tenant" ${(tenantPolicy.principal_type || 'tenant') === 'tenant' ? 'selected' : ''}>整个租户</option>
            <option value="user" ${tenantPolicy.principal_type === 'user' ? 'selected' : ''}>指定用户</option>
            <option value="role" ${tenantPolicy.principal_type === 'role' ? 'selected' : ''}>角色</option>
            <option value="preset" ${tenantPolicy.principal_type === 'preset' ? 'selected' : ''}>预设</option>
          </select>
        </div>
        <div>
          <label class="form-label">主体 ID</label>
          <input class="form-input" id="tp-principal" placeholder="tenant 可留空" value="${esc(tenantPolicy.principal_type === 'tenant' ? '' : tenantPolicy.principal_id || '')}">
        </div>
      </div>
      <label class="form-label">审批模式</label>
      <select class="form-select" id="tp-approval">
        <option value="risk_based" ${(tenantPolicy.approval_mode || 'risk_based') === 'risk_based' ? 'selected' : ''}>按风险（推荐）</option>
        <option value="always" ${tenantPolicy.approval_mode === 'always' ? 'selected' : ''}>始终审批</option>
        <option value="never" ${tenantPolicy.approval_mode === 'never' ? 'selected' : ''}>从不审批（不降级高风险）</option>
      </select>
      <label class="form-label">单任务最大调用次数</label>
      <input class="form-input" id="tp-max" type="number" min="0" placeholder="留空表示不限制" value="${tenantPolicy.max_calls_per_task ?? ''}">
      <label class="form-label">允许的资源范围</label>
      <input class="form-input" id="tp-scopes" placeholder="多个范围用逗号分隔，留空表示不限" value="${esc(scopes)}">
      <label class="form-check" style="margin-top:14px"><input type="checkbox" id="tp-enabled" ${tenantPolicy.enabled !== false ? 'checked' : ''}>启用该工具</label>
    </div>
    <div class="dlg-foot">
      <button class="btn dlg-close">取消</button>
      <button class="btn primary" id="tp-save">保存策略</button>
    </div>`);
  $('#tp-save', dlg).addEventListener('click', async () => {
    const principalType = $('#tp-type', dlg).value;
    const principalId = $('#tp-principal', dlg).value.trim();
    if (principalType !== 'tenant' && !principalId) return toast('请填写主体 ID', false);
    const max = $('#tp-max', dlg).value.trim();
    const body = {
      principal_type: principalType,
      principal_id: principalId || undefined,
      approval_mode: $('#tp-approval', dlg).value,
      max_calls_per_task: max === '' ? null : Number(max),
      allowed_scopes: $('#tp-scopes', dlg).value.split(/[,，]/).map(s => s.trim()).filter(Boolean),
      enabled: $('#tp-enabled', dlg).checked,
    };
    try {
      await API.req(`/tools/registry/${encodeURIComponent(name)}/policy`, { method: 'PATCH', body });
      closeDialog();
      toast('策略已保存');
      renderToolRegistryPane();
    } catch (e){ toast(e.message, false); }
  });
}

/* ---------- MCP 连接 ---------- */
async function renderMcpPane(){
  const box = $('#settings-content');
  if (!state.user?.is_admin){
    adminPlaceholder(box, { title: '需要管理员权限', text: 'MCP 连接仅平台管理员或组织 owner/admin 可配置。' });
    return;
  }
  box.innerHTML = '<div class="settings-section-title">MCP 连接（出站 Streamable HTTP）</div>'
    + '<p class="form-hint">只支持 Streamable HTTP。凭证只保存 <code>credential_ref</code>（如 <code>env:MCP_TOKEN</code>），接口不会回显。工具描述与结果一律视为不可信。</p>'
    + '<button class="btn primary" id="mcp-add" style="margin-bottom:14px">新增连接</button><div id="mcp-list"><div class="task-loading">加载中…</div></div>';
  $('#mcp-add').addEventListener('click', () => openMcpEditor(null));
  const list = $('#mcp-list');
  try {
    state.mcpConnections = (await API.get('/mcp/connections')).connections || [];
  } catch (e){
    if (platformDisabledHint(e)) return adminPlaceholder(list, { title: 'Agent 平台未启用', text: '设置 AGENT_PLATFORM_ENABLED=1 与 DATABASE_URL 后重试。' });
    return adminPlaceholder(list, { title: '读取失败', text: e.message });
  }
  if (!state.mcpConnections.length){
    list.innerHTML = '<p class="form-hint">还没有 MCP 连接。新增连接后点击「刷新工具」把远端工具写入注册表。</p>';
    return;
  }
  list.innerHTML = '<div class="registry-list">' + state.mcpConnections.map(c => `<div class="registry-row">
    <div class="registry-main">
      <div class="registry-name"><span class="mono">${esc(c.name)}</span><span class="badge ${c.status === 'healthy' ? 'brand' : ''}">${esc(c.status || 'unknown')}</span><span class="badge">${esc(c.transport)}</span>${c.credential_configured ? '<span class="badge brand">凭证已配置</span>' : '<span class="badge">无凭证</span>'}</div>
      <div class="registry-desc mono">${esc(c.endpoint)}</div>
      <div class="registry-meta">允许 ${c.allowed_tools?.length || 0} · 拒绝 ${c.denied_tools?.length || 0} · 最近健康检查 ${esc(fmtTime(c.last_health_at))}</div>
    </div>
    <div class="registry-actions">
      <button class="btn small" data-mcp-test="${esc(c.id)}">测试</button>
      <button class="btn small" data-mcp-tools="${esc(c.id)}">工具</button>
      <button class="btn small" data-mcp-refresh="${esc(c.id)}">刷新工具</button>
      <button class="btn small" data-mcp-edit="${esc(c.id)}">编辑</button>
      <button class="btn small" data-mcp-del="${esc(c.id)}">删除</button>
    </div>
  </div>`).join('') + '</div>';
  $$('[data-mcp-test]', list).forEach(b => b.addEventListener('click', () => mcpTest(b.getAttribute('data-mcp-test'))));
  $$('[data-mcp-tools]', list).forEach(b => b.addEventListener('click', () => showMcpTools(b.getAttribute('data-mcp-tools'))));
  $$('[data-mcp-refresh]', list).forEach(b => b.addEventListener('click', () => mcpRefresh(b.getAttribute('data-mcp-refresh'))));
  $$('[data-mcp-edit]', list).forEach(b => b.addEventListener('click', () => openMcpEditor(state.mcpConnections.find(c => c.id === b.getAttribute('data-mcp-edit')))));
  $$('[data-mcp-del]', list).forEach(b => b.addEventListener('click', () => mcpDelete(b.getAttribute('data-mcp-del'))));
}
function openMcpEditor(conn){
  const isNew = !conn;
  const dlg = openDialog(`
    <h3>${isNew ? '新增 MCP 连接' : '编辑 MCP 连接'}</h3>
    <p class="dlg-sub">Streamable HTTP 端点。stdio 在 P0 阶段不开放。</p>
    <div class="dlg-body">
      <label class="form-label">名称</label>
      <input class="form-input" id="mc-name" value="${esc(conn?.name || '')}" placeholder="例如：company-tools" ${isNew ? '' : 'disabled'}>
      <label class="form-label">Endpoint</label>
      <input class="form-input" id="mc-endpoint" value="${esc(conn?.endpoint || '')}" placeholder="https://mcp.example.com/mcp">
      <div class="form-row2">
        <div>
          <label class="form-label">认证方式</label>
          <select class="form-select" id="mc-auth"><option value="none" ${conn?.auth_type !== 'bearer' ? 'selected' : ''}>无</option><option value="bearer" ${conn?.auth_type === 'bearer' ? 'selected' : ''}>Bearer</option></select>
        </div>
        <div>
          <label class="form-label">凭证引用</label>
          <input class="form-input" id="mc-credential" placeholder="env:MCP_TOKEN" value="">
        </div>
      </div>
      <p class="form-hint">凭证仅保存引用，不回显。留空表示不修改${isNew ? '' : '（当前' + (conn.credential_configured ? '已配置' : '未配置') + '）'}。</p>
      <label class="form-label">允许的工具</label>
      <input class="form-input" id="mc-allowed" placeholder="逗号分隔；留空表示全部允许" value="${esc((conn?.allowed_tools || []).join(', '))}">
      <label class="form-label">拒绝的工具</label>
      <input class="form-input" id="mc-denied" placeholder="逗号分隔" value="${esc((conn?.denied_tools || []).join(', '))}">
    </div>
    <div class="dlg-foot"><button class="btn dlg-close">取消</button><button class="btn primary" id="mc-save">保存</button></div>`);
  $('#mc-save', dlg).addEventListener('click', async () => {
    const name = $('#mc-name', dlg).value.trim();
    const endpoint = $('#mc-endpoint', dlg).value.trim();
    if (!name || !endpoint) return toast('名称与 Endpoint 不能为空', false);
    const body = {
      name, endpoint,
      transport: 'streamable_http',
      auth_type: $('#mc-auth', dlg).value,
      allowed_tools: $('#mc-allowed', dlg).value.split(/[,，]/).map(s => s.trim()).filter(Boolean),
      denied_tools: $('#mc-denied', dlg).value.split(/[,，]/).map(s => s.trim()).filter(Boolean),
    };
    const cred = $('#mc-credential', dlg).value.trim();
    if (cred) body.credential_ref = cred;
    try {
      if (isNew) await API.post('/mcp/connections', body);
      else await API.req('/mcp/connections/' + conn.id, { method: 'PATCH', body });
      closeDialog();
      toast('MCP 连接已保存');
      renderMcpPane();
    } catch (e){ toast(e.message, false); }
  });
}
async function mcpTest(id){
  try {
    const r = await API.post(`/mcp/connections/${id}/test`, {});
    toast(r.ok ? `连接正常，发现 ${r.tools_count} 个工具` : `连接失败：${r.message}`, !!r.ok);
    renderMcpPane();
  } catch (e){ toast(e.message, false); }
}
async function mcpRefresh(id){
  try {
    const r = await API.post(`/mcp/connections/${id}/refresh`, {});
    toast(`已刷新 ${r.tools.length} 个工具`);
    renderMcpPane();
  } catch (e){ toast(e.message, false); }
}
async function showMcpTools(id){
  try {
    const d = await API.get(`/mcp/connections/${id}/tools`);
    const list = d.tools || [];
    const dlg = openDialog(`<h3>MCP 工具</h3><p class="dlg-sub">共 ${list.length} 个缓存工具（描述不可信）</p>
      <div class="dlg-body">${list.length ? `<div class="registry-list">${list.map(t => `<div class="registry-row"><div class="registry-main"><div class="registry-name"><span class="mono">${esc(t.tool_name || t.name || '')}</span></div><div class="registry-desc">${esc(t.description || '')}</div><div class="registry-meta">schema ${esc(shortHash(t.schema_hash))}</div></div></div>`).join('')}</div>` : '<p class="task-muted">暂无缓存工具，请先刷新。</p>'}</div>
      <div class="dlg-foot"><button class="btn dlg-close">关闭</button></div>`, { lg: true });
  } catch (e){ toast(e.message, false); }
}
async function mcpDelete(id){
  const conn = state.mcpConnections.find(c => c.id === id);
  if (!conn || !confirm(`删除 MCP 连接「${conn.name}」？相关 MCP 工具将停用。`)) return;
  try {
    await API.del('/mcp/connections/' + id);
    toast('已删除');
    renderMcpPane();
  } catch (e){ toast(e.message, false); }
}

/* ---------- 平台模型 ---------- */
async function renderModelProfilesPane(){
  const box = $('#settings-content');
  if (!state.user?.is_platform_admin){
    adminPlaceholder(box, { title: '需要平台管理员权限', text: 'Agent 任务的模型 profile 仅平台管理员（PLATFORM_ADMIN_EMAILS）可配置。' });
    return;
  }
  box.innerHTML = '<div class="settings-section-title">Agent 模型 profile</div>'
    + '<p class="form-hint">供 Worker 解析任务预设所用。凭证只保存 <code>env:NAME</code> 或 <code>file:相对路径</code> 引用，接口只返回是否已配置。</p>'
    + '<button class="btn primary" id="mp-add" style="margin-bottom:14px">添加模型 profile</button><div id="mp-list"><div class="task-loading">加载中…</div></div>';
  $('#mp-add').addEventListener('click', () => openModelProfileEditor(null));
  const list = $('#mp-list');
  try {
    state.modelProfiles = (await API.get('/model-profiles')).profiles || [];
  } catch (e){
    if (platformDisabledHint(e)) return adminPlaceholder(list, { title: 'Agent 平台未启用', text: '设置 AGENT_PLATFORM_ENABLED=1 与 DATABASE_URL 后重试。' });
    return adminPlaceholder(list, { title: '读取失败', text: e.message });
  }
  if (!state.modelProfiles.length){
    list.innerHTML = '<p class="form-hint">还没有模型 profile。任务如果没有绑定预设，Worker 会回退到环境变量中的模型配置。</p>';
    return;
  }
  list.innerHTML = '<div class="registry-list">' + state.modelProfiles.map(p => `<div class="registry-row">
    <div class="registry-main">
      <div class="registry-name"><span>${esc(p.name)}</span><span class="badge">${esc(p.provider || '兼容接口')}</span><span class="badge">${esc(p.model_name)}</span>${p.enabled ? '<span class="badge brand">启用</span>' : '<span class="badge">停用</span>'}<span class="badge ${p.credential_configured ? 'brand' : 'warn'}">${p.credential_configured ? '凭证已配置' : '缺少凭证'}</span></div>
      <div class="registry-desc mono">${esc(p.base_url)}</div>
      <div class="registry-meta">上下文 ${esc(String(p.context_window || '—'))} · 能力 ${esc(JSON.stringify(p.capabilities || {}))}</div>
    </div>
    <div class="registry-actions">
      <button class="btn small" data-mp-test="${esc(p.id)}">测试</button>
      <button class="btn small" data-mp-edit="${esc(p.id)}">编辑</button>
      <button class="btn small" data-mp-del="${esc(p.id)}">删除</button>
    </div>
  </div>`).join('') + '</div>';
  $$('[data-mp-test]', list).forEach(b => b.addEventListener('click', () => testModelProfile(b.getAttribute('data-mp-test'))));
  $$('[data-mp-edit]', list).forEach(b => b.addEventListener('click', () => openModelProfileEditor(state.modelProfiles.find(p => p.id === b.getAttribute('data-mp-edit')))));
  $$('[data-mp-del]', list).forEach(b => b.addEventListener('click', () => deleteModelProfile(b.getAttribute('data-mp-del'))));
}
function openModelProfileEditor(profile){
  const isNew = !profile;
  const dlg = openDialog(`
    <h3>${isNew ? '添加模型 profile' : '编辑模型 profile'}</h3>
    <p class="dlg-sub">用于 Agent 任务 Worker。Base URL 不能指向本机、私网或云元数据地址。</p>
    <div class="dlg-body">
      <label class="form-label">名称</label>
      <input class="form-input" id="mpe-name" value="${esc(profile?.name || '')}" placeholder="例如：生产对话模型">
      <div class="form-row2">
        <div><label class="form-label">供应商</label><input class="form-input" id="mpe-provider" value="${esc(profile?.provider || '')}" placeholder="deepseek / qwen / vllm"></div>
        <div><label class="form-label">模型 ID</label><input class="form-input" id="mpe-model" value="${esc(profile?.model_name || '')}" placeholder="deepseek-chat"></div>
      </div>
      <label class="form-label">Base URL</label>
      <input class="form-input" id="mpe-url" value="${esc(profile?.base_url || '')}" placeholder="https://api.deepseek.com/v1">
      <label class="form-label">凭证引用</label>
      <input class="form-input" id="mpe-credential" placeholder="env:DEEPSEEK_API_KEY 或 file:deepseek.key" value="">
      <p class="form-hint">只写 <code>env:变量名</code> 或 <code>file:EKH_MODEL_SECRET_DIR 下的相对路径</code>，不会回显。${isNew ? '' : '留空表示保持不变。'}</p>
      <div class="form-row2">
        <div><label class="form-label">上下文窗口</label><input class="form-input" id="mpe-ctx" type="number" min="0" value="${profile?.context_window ?? ''}" placeholder="128000"></div>
        <div><label class="form-label">能力</label><input class="form-input" id="mpe-cap" placeholder='{"tools":true}' value="${esc(profile ? JSON.stringify(profile.capabilities || {}) : '')}"></div>
      </div>
      <label class="form-check" style="margin-top:14px"><input type="checkbox" id="mpe-enabled" ${profile?.enabled !== false ? 'checked' : ''}>启用</label>
    </div>
    <div class="dlg-foot"><button class="btn dlg-close">取消</button><button class="btn primary" id="mpe-save">保存</button></div>`);
  $('#mpe-save', dlg).addEventListener('click', async () => {
    const name = $('#mpe-name', dlg).value.trim();
    const baseUrl = $('#mpe-url', dlg).value.trim();
    const modelName = $('#mpe-model', dlg).value.trim();
    if (!name || !baseUrl || !modelName) return toast('名称、Base URL 与模型 ID 不能为空', false);
    let capabilities = {};
    const capRaw = $('#mpe-cap', dlg).value.trim();
    if (capRaw){
      try { capabilities = JSON.parse(capRaw); } catch { return toast('能力必须是合法 JSON', false); }
    }
    const body = {
      name, provider: $('#mpe-provider', dlg).value.trim(), base_url: baseUrl, model_name: modelName,
      capabilities, context_window: Number($('#mpe-ctx', dlg).value) || null,
      enabled: $('#mpe-enabled', dlg).checked,
    };
    const cred = $('#mpe-credential', dlg).value.trim();
    if (cred) body.credential_ref = cred;
    try {
      if (isNew) await API.post('/model-profiles', body);
      else await API.req('/model-profiles/' + profile.id, { method: 'PATCH', body });
      closeDialog();
      toast('模型 profile 已保存');
      renderModelProfilesPane();
    } catch (e){ toast(e.message, false); }
  });
}
async function testModelProfile(id){
  try {
    const r = await API.post(`/model-profiles/${id}/test`, {});
    toast(r.ok ? `连接正常：${r.message}` : `连接失败：${r.message}`, !!r.ok);
  } catch (e){ toast(e.message, false); }
}
async function deleteModelProfile(id){
  const p = state.modelProfiles.find(x => x.id === id);
  if (!p || !confirm(`删除模型 profile「${p.name}」？`)) return;
  try {
    await API.del('/model-profiles/' + id);
    toast('已删除');
    renderModelProfilesPane();
  } catch (e){ toast(e.message, false); }
}

/* ---------- 服务主体 ---------- */
async function renderServicePrincipalsPane(){
  const box = $('#settings-content');
  if (!state.user?.is_platform_admin){
    adminPlaceholder(box, { title: '需要平台管理员权限', text: '服务主体仅平台管理员可创建与轮换。' });
    return;
  }
  await loadTaskRegistry();
  box.innerHTML = '<div class="settings-section-title">服务主体（入站 API / MCP）</div>'
    + '<p class="form-hint">服务主体 token 只保存 SHA-256；创建或轮换时明文只显示一次。知识库范围默认拒绝，需显式授权。</p>'
    + '<button class="btn primary" id="sp-add" style="margin-bottom:14px">创建服务主体</button><div id="sp-list"><div class="task-loading">加载中…</div></div>';
  $('#sp-add').addEventListener('click', openServicePrincipalEditor);
  const list = $('#sp-list');
  try {
    state.servicePrincipals = (await API.get('/service-principals')).principals || [];
  } catch (e){
    if (platformDisabledHint(e)) return adminPlaceholder(list, { title: 'Agent 平台未启用', text: '设置 AGENT_PLATFORM_ENABLED=1 与 DATABASE_URL 后重试。' });
    return adminPlaceholder(list, { title: '读取失败', text: e.message });
  }
  if (!state.servicePrincipals.length){
    list.innerHTML = '<p class="form-hint">还没有服务主体。旧全局 <code>EKH_SERVICE_TOKEN</code> 只作为兼容主体使用，生产环境建议关闭。</p>';
    return;
  }
  list.innerHTML = '<div class="registry-list">' + state.servicePrincipals.map(p => {
    const scopes = p.scopes || {};
    const scopeText = scopes.all_kbs ? '全部知识库' : `${(scopes.kb_ids || []).length} 个知识库`;
    return `<div class="registry-row">
      <div class="registry-main">
        <div class="registry-name"><span>${esc(p.name)}</span>${p.revoked_at ? '<span class="badge error">已吊销</span>' : '<span class="badge brand">有效</span>'}<span class="badge">${scopeText}</span><span class="badge">${(scopes.tools || []).length} 个工具</span></div>
        <div class="registry-meta">创建 ${esc(fmtTime(p.created_at))} · 最近使用 ${esc(p.last_used_at ? fmtTime(p.last_used_at) : '—')} · 过期 ${esc(p.expires_at ? fmtTime(p.expires_at) : '永不过期')}</div>
      </div>
      <div class="registry-actions">
        <button class="btn small" data-sp-rotate="${esc(p.id)}" ${p.revoked_at ? 'disabled' : ''}>轮换 token</button>
        <button class="btn small" data-sp-revoke="${esc(p.id)}" ${p.revoked_at ? 'disabled' : ''}>吊销</button>
      </div>
    </div>`;
  }).join('') + '</div>';
  $$('[data-sp-rotate]', list).forEach(b => b.addEventListener('click', () => rotateServicePrincipal(b.getAttribute('data-sp-rotate'))));
  $$('[data-sp-revoke]', list).forEach(b => b.addEventListener('click', () => revokeServicePrincipal(b.getAttribute('data-sp-revoke'))));
}
function openServicePrincipalEditor(){
  const kbs = state.kbs || [];
  const tools = state.registryTools || [];
  const dlg = openDialog(`
    <h3>创建服务主体</h3>
    <p class="dlg-sub">用于 <code>/api/retrieve</code> 与 <code>/mcp</code>。token 只显示一次。</p>
    <div class="dlg-body">
      <label class="form-label">名称</label>
      <input class="form-input" id="spe-name" placeholder="例如：bi-dashboard">
      <label class="form-check" style="margin-top:14px"><input type="checkbox" id="spe-all-kbs" checked>允许访问全部知识库</label>
      <label class="form-label">知识库白名单</label>
      <div class="form-checks" id="spe-kbs">${kbs.map(kb => `<label class="form-check"><input type="checkbox" value="${esc(kb.id)}" disabled>${esc(kb.name)}</label>`).join('') || '<span class="form-hint">暂无知识库</span>'}</div>
      <label class="form-label">允许的工具</label>
      <div class="form-checks" id="spe-tools">${tools.map(t => `<label class="form-check"><input type="checkbox" value="${esc(t.name)}"><span class="mono">${esc(t.name)}</span></label>`).join('') || '<span class="form-hint">工具注册表不可用</span>'}</div>
      <label class="form-label">过期时间（可选）</label>
      <input class="form-input" id="spe-expires" type="datetime-local">
    </div>
    <div class="dlg-foot"><button class="btn dlg-close">取消</button><button class="btn primary" id="spe-save">创建</button></div>`, { lg: true });
  const toggleKbs = () => {
    const all = $('#spe-all-kbs', dlg).checked;
    $$('#spe-kbs input', dlg).forEach(i => { i.disabled = all; if (all) i.checked = false; });
  };
  $('#spe-all-kbs', dlg).addEventListener('change', toggleKbs);
  toggleKbs();
  $('#spe-save', dlg).addEventListener('click', async () => {
    const name = $('#spe-name', dlg).value.trim();
    if (!name) return toast('请填写名称', false);
    const allKbs = $('#spe-all-kbs', dlg).checked;
    const expires = $('#spe-expires', dlg).value;
    const body = {
      name,
      scopes: {
        all_kbs: allKbs,
        kb_ids: allKbs ? [] : $$('#spe-kbs input:checked', dlg).map(i => i.value),
        tools: $$('#spe-tools input:checked', dlg).map(i => i.value),
      },
      expires_at: expires ? new Date(expires).toISOString() : null,
    };
    try {
      const r = await API.post('/service-principals', body);
      closeDialog();
      showServiceToken(r.token, r.principal);
      renderServicePrincipalsPane();
    } catch (e){ toast(e.message, false); }
  });
}
function showServiceToken(token, principal){
  const dlg = openDialog(`
    <h3>服务主体 token</h3>
    <p class="dlg-sub">明文 token 只显示这一次，关闭后无法再次查看。</p>
    <div class="dlg-body">
      <label class="form-label">${esc(principal?.name || '')}</label>
      <textarea class="form-textarea mono" id="st-token" rows="3" readonly>${esc(token)}</textarea>
      <p class="form-hint">请立即复制并存入密钥管理系统。</p>
      <div class="test-result ok" id="st-copied"></div>
    </div>
    <div class="dlg-foot"><button class="btn primary" id="st-copy">复制 token</button><button class="btn dlg-close">我已保存</button></div>`);
  $('#st-copy', dlg).addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(token);
      $('#st-copied', dlg).textContent = '已复制到剪贴板';
    } catch { $('#st-token', dlg).select(); $('#st-copied', dlg).textContent = '已选中，请手动复制'; }
  });
}
async function rotateServicePrincipal(id){
  if (!confirm('轮换后旧 token 立即失效，确认继续？')) return;
  try {
    const r = await API.post(`/service-principals/${id}/rotate`, {});
    showServiceToken(r.token, r.principal);
    renderServicePrincipalsPane();
  } catch (e){ toast(e.message, false); }
}
async function revokeServicePrincipal(id){
  if (!confirm('确认吊销该服务主体？')) return;
  try {
    await API.del(`/service-principals/${id}`);
    toast('已吊销');
    renderServicePrincipalsPane();
  } catch (e){ toast(e.message, false); }
}

/* ================= 共享空间 ================= */
async function loadOrgs(){
  try {
    state.orgs = (await API.get('/orgs')).orgs;
    renderOrgs();
  } catch {}
}
function renderOrgs(){
  const box = $('#org-box');
  if (!state.orgs.length){
    box.innerHTML = '<div class="empty-page" style="min-height:300px"><div class="empty-icon"><svg class="ic" style="width:28px;height:28px" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="4" y="8" width="7" height="12" rx="1.5"/><rect x="13" y="4" width="7" height="16" rx="1.5"/></svg></div><h3>暂无共享空间</h3><p>创建共享空间，与团队成员协作管理知识库与智能体；也可以通过邀请码加入他人创建的空间。</p></div>';
    return;
  }
  box.innerHTML = '<div class="org-grid"></div>';
  const grid = $('.org-grid', box);
  for (const o of state.orgs){
    const card = document.createElement('div');
    card.className = 'org-card';
    const roleLabel = { owner: 'Owner', admin: 'Admin', contributor: 'Contributor', viewer: 'Viewer' }[o.my_role] || '';
    card.innerHTML =
      `<div class="org-head"><span class="org-icon"><svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="4" y="8" width="7" height="12" rx="1.5"/><rect x="13" y="4" width="7" height="16" rx="1.5"/></svg></span><span class="org-name">${esc(o.name)}</span><span class="badge brand">${roleLabel}</span></div>` +
      `<div class="org-desc">${esc(o.description || '暂无描述')}</div>` +
      `<div class="org-meta"><span>${o.members.length} 位成员</span><span>${o.kb_count} 个共享知识库</span><span>邀请码 <span class="org-code">${esc(o.invite_code)}</span></span></div>`;
    card.addEventListener('click', () => openOrgDetail(o));
    grid.appendChild(card);
  }
}
function openOrgDetail(o){
  const isOwner = o.owner_id === state.user.id;
  const myRole = o.my_role;
  const canManage = isOwner;
  const canLeave = !isOwner;
  const roleNames = { owner: 'Owner', admin: 'Admin', contributor: 'Contributor', viewer: 'Viewer' };
  const dlg = openDialog(`
    <h3>${esc(o.name)}</h3>
    <p class="dlg-sub">${esc(o.description || '')} · 邀请码 <span class="org-code">${esc(o.invite_code)}</span> <button class="btn text" id="od-copy" style="height:24px;padding:0 8px;font-size:12px">复制</button></p>
    <div class="dlg-body">
      <div class="settings-section-title">成员（${o.members.length}）</div>
      ${o.members.map(m => `
        <div class="member-row" data-uid="${m.id}">
          <div class="avatar" style="width:32px;height:32px;font-size:12px">${esc(m.name.charAt(0))}</div>
          <div class="m-meta"><div class="n">${esc(m.name)}${m.id === state.user.id ? '（我）' : ''}</div><div class="e">${esc(m.email)}</div></div>
          ${canManage && m.role !== 'owner'
            ? `<select class="role-select" data-uid="${m.id}">${Object.entries(roleNames).map(([k, v]) => `<option value="${k}" ${m.role === k ? 'selected' : ''}>${v}</option>`).join('')}</select>
               <button class="icon-btn" data-remove="${m.id}" title="移除"><svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M6 6l12 12M18 6L6 18" stroke-linecap="round"/></svg></button>`
            : `<span class="member-role">${roleNames[m.role] || m.role}</span>`}
        </div>`).join('')}
    </div>
    <div class="dlg-foot">
      ${canLeave ? '<button class="btn" id="od-leave" style="color:#e34d59;border-color:rgba(227,77,89,.4)">退出空间</button>' : ''}
      ${isOwner ? '<button class="btn" id="od-del" style="color:#e34d59;border-color:rgba(227,77,89,.4)">删除空间</button>' : ''}
      <span style="flex:1"></span>
      <button class="btn dlg-close">关闭</button>
    </div>`, { lg: true });
  $('#od-copy', dlg).addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(o.invite_code); toast('邀请码已复制'); } catch { toast('复制失败，请手动复制：' + o.invite_code, false); }
  });
  $$('.role-select', dlg).forEach(sel => sel.addEventListener('change', async () => {
    try {
      const r = await API.put(`/orgs/${o.id}/members/${sel.getAttribute('data-uid')}`, { role: sel.value });
      Object.assign(o, r.org);
      toast('角色已更新');
      closeDialog();
      openOrgDetail(r.org);
    } catch (e){ toast(e.message, false); }
  }));
  $$('button[data-remove]', dlg).forEach(b => b.addEventListener('click', async () => {
    const uid = b.getAttribute('data-remove');
    const m = o.members.find(x => x.id === uid);
    if (!confirm(`移除成员「${m?.name}」？`)) return;
    try { await API.del(`/orgs/${o.id}/members/${uid}`); toast('已移除'); closeDialog(); loadOrgs(); } catch (e){ toast(e.message, false); }
  }));
  const leave = $('#od-leave', dlg);
  if (leave) leave.addEventListener('click', async () => {
    if (!confirm(`退出空间「${o.name}」？`)) return;
    try { await API.post(`/orgs/${o.id}/leave`); toast('已退出'); closeDialog(); loadOrgs(); } catch (e){ toast(e.message, false); }
  });
  const del = $('#od-del', dlg);
  if (del) del.addEventListener('click', async () => {
    if (!confirm(`删除空间「${o.name}」？空间内知识库将转为私有。`)) return;
    try { await API.del('/orgs/' + o.id); toast('空间已删除'); closeDialog(); loadOrgs(); loadKbs(); } catch (e){ toast(e.message, false); }
  });
}
$('#create-org-btn').addEventListener('click', () => {
  const dlg = openDialog(`
    <h3>创建共享空间</h3>
    <div class="dlg-body">
      <label class="form-label">空间名称</label>
      <input class="form-input" id="co-name" placeholder="例如：产品与研发中心" maxlength="60">
      <label class="form-label">描述</label>
      <textarea class="form-textarea" id="co-desc" placeholder="空间的用途说明（可选）"></textarea>
    </div>
    <div class="dlg-foot"><button class="btn dlg-close">取消</button><button class="btn primary" id="co-submit">创建</button></div>`);
  $('#co-name', dlg).focus();
  $('#co-submit', dlg).addEventListener('click', async () => {
    const name = $('#co-name', dlg).value.trim();
    if (!name) return toast('请填写空间名称', false);
    try {
      const r = await API.post('/orgs', { name, description: $('#co-desc', dlg).value.trim() });
      closeDialog();
      toast('空间已创建，邀请码：' + r.org.invite_code);
      loadOrgs();
    } catch (e){ toast(e.message, false); }
  });
});
$('#join-org-btn').addEventListener('click', () => {
  const dlg = openDialog(`
    <h3>使用邀请码加入</h3>
    <div class="dlg-body"><label class="form-label">邀请码</label><input class="form-input" id="jo-code" placeholder="ORG-XXXXXX"></div>
    <div class="dlg-foot"><button class="btn dlg-close">取消</button><button class="btn primary" id="jo-submit">加入</button></div>`);
  $('#jo-code', dlg).focus();
  $('#jo-submit', dlg).addEventListener('click', async () => {
    const code = $('#jo-code', dlg).value.trim();
    if (!code) return toast('请填写邀请码', false);
    try {
      await API.post('/orgs/join', { code });
      closeDialog();
      toast('已加入空间');
      loadOrgs();
    } catch (e){ toast(e.message, false); }
  });
});

/* ================= 设置 ================= */
let settingsPane = 'models';
function openSettings(pane){
  settingsPane = pane || 'models';
  $$('#settings-nav .nav-item').forEach(n => n.classList.toggle('active', n.getAttribute('data-pane') === settingsPane));
  renderSettings();
  $('#settings-overlay').classList.add('show');
}
function closeSettings(){ $('#settings-overlay').classList.remove('show'); }
$('#menu-settings').addEventListener('click', () => openSettings());
$('#settings-close').addEventListener('click', closeSettings);
$('#settings-overlay').addEventListener('click', e => { if (e.target === $('#settings-overlay')) closeSettings(); });
$('#settings-nav').addEventListener('click', e => {
  const item = e.target.closest('.nav-item');
  if (!item) return;
  $$('#settings-nav .nav-item').forEach(n => n.classList.remove('active'));
  item.classList.add('active');
  settingsPane = item.getAttribute('data-pane');
  renderSettings();
});

function renderSettings(){
  const box = $('#settings-content');
  const titles = {
    general: '常规设置', profile: '用户信息', memories: '我的记忆', models: '模型管理', members: '成员管理', tools: '工具开关', about: '关于',
    'tool-registry': '工具注册表', mcp: 'MCP 连接', 'model-profiles': '平台模型', 'service-principals': '服务主体',
  };
  $('#settings-title').textContent = titles[settingsPane] || '设置';
  if (settingsPane === 'general'){
    const chatModels = state.models.filter(m => m.kind === 'chat');
    const def = defaultModel('chat');
    box.innerHTML =
      '<div class="settings-section-title">默认对话模型</div>' +
      (chatModels.length
        ? `<select class="form-select" id="gs-model" style="max-width:360px">${chatModels.map(m => `<option value="${m.id}" ${def && def.id === m.id ? 'selected' : ''}>${esc(m.name)}</option>`).join('')}</select>`
        : '<p class="form-hint">尚未配置对话模型，请前往「模型管理」添加。未配置时系统以抽取方式返回检索片段。</p>') +
      '<div class="settings-section-title">外观</div>' +
      '<div class="radio-row"><span class="radio-pill" id="pref-light">浅色模式</span><span class="radio-pill" id="pref-dark">深色模式</span></div>' +
      '<div class="settings-section-title">数据</div>' +
      '<button class="btn" id="gs-relogin">退出登录</button>';
    if (chatModels.length){
      $('#gs-model').addEventListener('change', async e => {
        try {
          await API.put('/models/' + e.target.value, { is_default: true });
          await loadModels();
          toast('默认模型已更新');
        } catch (err2){ toast(err2.message, false); }
      });
    }
    const dark = document.documentElement.getAttribute('data-theme') === 'dark';
    $('#pref-light').classList.toggle('on', !dark);
    $('#pref-dark').classList.toggle('on', dark);
    $('#pref-light').addEventListener('click', () => { setTheme('light'); syncPref(); });
    $('#pref-dark').addEventListener('click', () => { setTheme('dark'); syncPref(); });
    function syncPref(){
      const d = document.documentElement.getAttribute('data-theme') === 'dark';
      $('#pref-light').classList.toggle('on', !d);
      $('#pref-dark').classList.toggle('on', d);
    }
    $('#gs-relogin').addEventListener('click', () => { closeSettings(); doLogout(); });
    return;
  }
  if (settingsPane === 'profile'){
    box.innerHTML =
      '<div class="settings-section-title">基础信息</div>' +
      `<div class="member-row"><div class="avatar">${esc(state.user.name.charAt(0).toUpperCase())}</div><div class="m-meta"><div class="n">${esc(state.user.name)}</div><div class="e">${esc(state.user.email)}</div></div><span class="badge brand">${esc(state.user.role || 'Member')}</span></div>` +
      '<label class="form-label" style="margin-top:16px">昵称</label>' +
      `<input class="form-input" id="pf-name" value="${esc(state.user.name)}" style="max-width:300px">` +
      '<button class="btn primary" id="pf-save" style="margin-top:10px">保存昵称</button>' +
      '<div class="settings-section-title">修改密码</div>' +
      '<input class="form-input" id="pf-pwd" type="password" placeholder="新密码（至少 6 位）" style="max-width:300px">' +
      '<button class="btn" id="pf-pwd-save" style="margin-top:10px">更新密码</button>';
    $('#pf-save').addEventListener('click', async () => {
      try {
        const r = await API.put('/me', { name: $('#pf-name').value.trim() });
        state.user = { ...state.user, ...r.user };
        $('#user-name').textContent = r.user.name;
        $('#user-avatar').textContent = r.user.name.charAt(0).toUpperCase();
        $('#chat-hero-title').textContent = 'Hi，' + r.user.name;
        toast('昵称已更新');
      } catch (e){ toast(e.message, false); }
    });
    $('#pf-pwd-save').addEventListener('click', async () => {
      const pwd = $('#pf-pwd').value;
      if (pwd.length < 6) return toast('密码至少 6 位', false);
      try {
        await API.put('/me', { password: pwd });
        $('#pf-pwd').value = '';
        toast('密码已更新');
      } catch (e){ toast(e.message, false); }
    });
    return;
  }
  if (settingsPane === 'memories'){
    loadMemoriesPane();
    return;
  }
  if (settingsPane === 'models'){
    renderModelsPane();
    return;
  }
  if (settingsPane === 'tool-registry'){ renderToolRegistryPane(); return; }
  if (settingsPane === 'mcp'){ renderMcpPane(); return; }
  if (settingsPane === 'model-profiles'){ renderModelProfilesPane(); return; }
  if (settingsPane === 'service-principals'){ renderServicePrincipalsPane(); return; }
  if (settingsPane === 'members'){
    renderMembersPane();
    return;
  }
  if (settingsPane === 'tools'){
    box.innerHTML = '<p class="form-hint" style="margin-bottom:12px">工具开关与配置请前往「工具箱」页面管理，智能体在编辑时勾选可用工具。</p><button class="btn primary" id="goto-tools">打开工具箱</button>';
    $('#goto-tools').addEventListener('click', () => { closeSettings(); showView('toolbox'); });
    return;
  }
  if (settingsPane === 'about'){
    box.innerHTML =
      '<div class="settings-section-title">企业知识库</div>' +
      '<p class="form-hint" style="line-height:2">RAG 问答 · 智能体 · 共享空间，大模型驱动的企业级知识框架。<br>后端：Node.js + SQLite（数据保存在本地 data/ 目录）<br>前端：原生 HTML/CSS/JS，无构建依赖<br>模型协议：OpenAI 兼容（对话 / Embedding / Rerank）<br><br>演示账号：lzy@example.com / password</p>';
    return;
  }
}
async function loadMemoriesPane(){
  const box = $('#settings-content');
  box.innerHTML = '<p class="form-hint" style="margin-bottom:12px">保存你的偏好与背景信息，对话时会作为长期记忆提供给模型参考。</p>' +
    '<div style="display:flex;gap:8px;max-width:520px"><input class="form-input" id="mem-input" placeholder="例如：我偏好简洁的要点式回答"><button class="btn primary" id="mem-add">添加</button></div><div id="mem-list" style="margin-top:14px"></div>';
  $('#mem-add').addEventListener('click', async () => {
    const v = $('#mem-input').value.trim();
    if (!v) return;
    try {
      await API.post('/memories', { content: v });
      $('#mem-input').value = '';
      loadMemoriesPane();
    } catch (e){ toast(e.message, false); }
  });
  try {
    const data = await API.get('/memories');
    const list = $('#mem-list');
    if (!data.memories.length) list.innerHTML = '<p class="form-hint">还没有记忆条目。</p>';
    for (const m of data.memories){
      const row = document.createElement('div');
      row.className = 'member-row';
      row.innerHTML = `<div class="m-meta"><div class="n" style="font-weight:400">${esc(m.content)}</div><div class="e">${fmtDate(m.created_at)}</div></div><button class="icon-btn" title="删除"><svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M6 6l12 12M18 6L6 18" stroke-linecap="round"/></svg></button>`;
      $('button', row).addEventListener('click', async () => { try { await API.del('/memories/' + m.id); loadMemoriesPane(); } catch {} });
      list.appendChild(row);
    }
  } catch {}
}
const MODEL_KIND_ORDER = ['chat', 'embedding', 'rerank'];
function renderModelsPane(){
  const box = $('#settings-content');
  const canManage = !!state.user?.is_platform_admin;
  box.innerHTML = (canManage
    ? '<button class="btn primary" id="add-model-btn" style="margin-bottom:16px"><svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 5v14M5 12h14" stroke-linecap="round"/></svg>添加模型</button>'
    : '<p class="form-hint" style="margin-bottom:16px">模型配置由平台管理员（<code>PLATFORM_ADMIN_EMAILS</code>）维护，当前为只读视图。</p>')
    + '<div id="model-groups"></div>';
  const gbox = $('#model-groups');
  for (const kind of MODEL_KIND_ORDER){
    const list = state.models.filter(m => m.kind === kind);
    if (!list.length) continue;
    const sec = document.createElement('div');
    sec.innerHTML = `<div class="settings-section-title">${DEFAULT_MODEL_KIND[kind]}</div>`;
    for (const m of list){
      const row = document.createElement('div');
      row.className = 'model-row';
      row.innerHTML =
        `<span class="m-icon" style="background:${MODEL_COLORS[m.kind]};color:#fff"><svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="5" y="7" width="14" height="12" rx="3"/><path d="M12 4v3"/></svg></span>` +
        '<div class="m-info"><div class="m-name"></div><div class="m-provider"></div></div>' +
        `${m.is_default ? '<span class="badge brand">默认</span>' : ''}<span class="m-usage"></span>` +
        (canManage
          ? '<button class="icon-btn" title="编辑"><svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4.5 19.5l1-4L16 5a2.1 2.1 0 0 1 3 3L8.5 18.5l-4 1z" stroke-linejoin="round"/></svg></button>' +
            '<button class="icon-btn" title="删除"><svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4.5 7h15M9.5 7V5.5A1.5 1.5 0 0 1 11 4h2a1.5 1.5 0 0 1 1.5 1.5V7m3 0l-.8 11.2a2 2 0 0 1-2 1.8H8.8a2 2 0 0 1-2-1.8L6 7" stroke-linecap="round"/></svg></button>'
          : '');
      $('.m-name', row).textContent = m.name;
      $('.m-provider', row).textContent = `${m.provider || '自定义接口'} · ${m.model_name}`;
      $('.m-usage', row).textContent = m.base_url;
      if (canManage){
        const [editBtn, delBtn] = $$('button.icon-btn', row);
        editBtn.addEventListener('click', () => openModelEditor(m));
        delBtn.addEventListener('click', async () => {
          if (!confirm(`删除模型「${m.name}」？`)) return;
          try { await API.del('/models/' + m.id); await loadModels(); renderModelsPane(); toast('已删除'); } catch (e){ toast(e.message, false); }
        });
        row.addEventListener('dblclick', async () => {
          try { await API.put('/models/' + m.id, { is_default: true }); await loadModels(); renderModelsPane(); toast('已设为默认'); } catch {}
        });
      }
      sec.appendChild(row);
    }
    gbox.appendChild(sec);
  }
  $('#add-model-btn')?.addEventListener('click', () => openModelEditor(null));
}
function openModelEditor(m){
  const isNew = !m;
  const dlg = openDialog(`
    <h3>${isNew ? '添加模型' : '编辑模型'}</h3>
    <p class="dlg-sub">支持 OpenAI 兼容接口（DeepSeek / Qwen / Ollama / vLLM 等）</p>
    <div class="dlg-body">
      <label class="form-label">类型</label>
      <select class="form-select" id="me-kind" ${isNew ? '' : 'disabled'}>
        ${MODEL_KIND_ORDER.map(k => `<option value="${k}" ${m?.kind === k ? 'selected' : ''}>${DEFAULT_MODEL_KIND[k]}</option>`).join('')}
      </select>
      <label class="form-label">显示名称</label>
      <input class="form-input" id="me-name" placeholder="例如：DeepSeek-V3" value="${esc(m?.name || '')}">
      <label class="form-label">供应商备注</label>
      <input class="form-input" id="me-provider" placeholder="例如：阿里云百炼 / 本地 vLLM" value="${esc(m?.provider || '')}">
      <label class="form-label">接口地址（Base URL）</label>
      <input class="form-input" id="me-url" placeholder="https://api.deepseek.com/v1" value="${esc(m?.base_url || '')}">
      <label class="form-label">API Key</label>
      <input class="form-input" id="me-key" type="password" placeholder="本地服务可留空" value="">
      <label class="form-label">模型 ID</label>
      <input class="form-input" id="me-model" placeholder="例如：deepseek-chat" value="${esc(m?.model_name || '')}">
      <label class="form-check" style="margin-top:12px"><input type="checkbox" id="me-default" ${m?.is_default ? 'checked' : ''}>设为该类型的默认模型</label>
      <div class="test-result" id="me-test-result"></div>
    </div>
    <div class="dlg-foot">
      <button class="btn" id="me-test">测试连接</button>
      <span style="flex:1"></span>
      <button class="btn dlg-close">取消</button>
      <button class="btn primary" id="me-save">保存</button>
    </div>`);
  if (!isNew && m.api_key) $('#me-key', dlg).value = '••••••••';
  $('#me-save', dlg).addEventListener('click', async () => {
    const body = {
      kind: $('#me-kind', dlg).value,
      name: $('#me-name', dlg).value.trim(),
      provider: $('#me-provider', dlg).value.trim(),
      base_url: $('#me-url', dlg).value.trim(),
      api_key: $('#me-key', dlg).value.trim(),
      model_name: $('#me-model', dlg).value.trim(),
      is_default: $('#me-default', dlg).checked ? 1 : 0,
    };
    if (!body.name || !body.base_url || !body.model_name) return toast('名称、接口地址与模型 ID 不能为空', false);
    try {
      if (isNew) await API.post('/models', body);
      else await API.put('/models/' + m.id, body);
      await loadModels();
      closeDialog();
      renderModelsPane();
      toast(isNew ? '模型已添加' : '已保存');
    } catch (e){ toast(e.message, false); }
  });
  $('#me-test', dlg).addEventListener('click', async () => {
    const el = $('#me-test-result', dlg);
    el.className = 'test-result';
    el.textContent = '测试中…';
    try {
      const r = await API.post('/models/test', {
        kind: $('#me-kind', dlg).value,
        base_url: $('#me-url', dlg).value.trim(),
        api_key: $('#me-key', dlg).value.trim(),
        model_name: $('#me-model', dlg).value.trim(),
      });
      el.className = 'test-result ' + (r.ok ? 'ok' : 'fail');
      el.textContent = r.message;
    } catch (e){ el.className = 'test-result fail'; el.textContent = e.message; }
  });
}
async function renderMembersPane(){
  const box = $('#settings-content');
  await loadOrgs();
  if (!state.orgs.length){
    box.innerHTML = '<p class="form-hint">你还没有加入任何共享空间。创建空间或使用邀请码加入后，即可在这里管理成员。</p><button class="btn primary" id="goto-orgs">前往共享空间</button>';
    $('#goto-orgs').addEventListener('click', () => { closeSettings(); showView('organizations'); });
    return;
  }
  const o = state.orgs[0];
  box.innerHTML =
    `<div class="settings-section-title">当前空间：${esc(o.name)}</div>` +
    `<p class="form-hint" style="margin-bottom:12px">邀请码：<span class="org-code">${esc(o.invite_code)}</span> · 成员 ${o.members.length} 位</p>` +
    '<button class="btn" id="mg-open" style="margin-bottom:10px">打开空间管理</button><div></div>';
  $('#mg-open').addEventListener('click', () => { closeSettings(); showView('organizations'); openOrgDetail(o); });
}

/* ================= ⌘K ================= */
function baseCommands(){
  const items = [
    { label: '新建对话', hint: 'N', icon: 'chat', run: () => { resetNewChat(); showView('chat-new'); } },
    { label: '打开知识库', icon: 'kb', run: () => showView('kb-list') },
    { label: '打开智能体', icon: 'agent', run: () => showView('agents') },
    { label: '打开任务', icon: 'task', run: () => showView('tasks') },
    { label: '新建任务', hint: 'Agent', icon: 'task', run: () => { showView('tasks'); openCreateTask(); } },
    { label: '打开产物库', icon: 'art', run: () => showView('artifacts') },
    { label: '打开工具箱', icon: 'tool', run: () => showView('toolbox') },
    { label: '打开共享空间', icon: 'org', run: () => showView('organizations') },
    { label: '打开系统设置', icon: 'set', run: () => openSettings() },
    { label: '切换深色 / 浅色主题', icon: 'theme', run: () => $('#theme-btn').click() },
  ];
  if (state.user?.is_admin){
    items.push({ label: '工具注册表', icon: 'tool', run: () => openSettings('tool-registry') });
    items.push({ label: 'MCP 连接', icon: 'tool', run: () => openSettings('mcp') });
  }
  if (state.user?.is_platform_admin){
    items.push({ label: '平台模型', icon: 'set', run: () => openSettings('model-profiles') });
    items.push({ label: '服务主体', icon: 'set', run: () => openSettings('service-principals') });
  }
  return items;
}
async function buildCmdk(q){
  const items = [];
  if (q){
    try {
      const r = await API.get('/search?q=' + encodeURIComponent(q));
      r.kbs.forEach(kb => items.push({ label: '知识库：' + kb.name, icon: 'kb', run: () => openKbDetail(kb) }));
      r.agents.forEach(a => items.push({ label: '智能体：' + a.name, icon: 'agent', run: () => showView('agents') }));
      r.sessions.forEach(s => items.push({ label: '对话：' + s.title, icon: 'chat', run: () => openSession(s.id) }));
    } catch {}
  }
  baseCommands().forEach(c => {
    if (!q || c.label.toLowerCase().includes(q.toLowerCase())) items.push(c);
  });
  return items;
}
async function renderCmdk(q){
  const list = $('#cmdk-list');
  state.cmdkItems = await buildCmdk(q.trim());
  state.cmdkSel = 0;
  list.innerHTML = '';
  if (!state.cmdkItems.length){
    list.innerHTML = '<div style="padding:20px;text-align:center;color:var(--text-4);font-size:13px">没有匹配的结果</div>';
    return;
  }
  state.cmdkItems.forEach((c, i) => {
    const div = document.createElement('div');
    div.className = 'cmdk-item' + (i === 0 ? ' sel' : '');
    div.innerHTML = '<span class="k-label"></span>' + (c.hint ? `<span class="k-hint">${c.hint}</span>` : '');
    $('.k-label', div).textContent = c.label;
    div.addEventListener('click', () => { closeCmdk(); c.run(); });
    list.appendChild(div);
  });
}
function openCmdk(){
  renderCmdk('');
  $('#cmdk-input').value = '';
  $('#cmdk-overlay').classList.add('show');
  setTimeout(() => $('#cmdk-input').focus(), 50);
}
function closeCmdk(){ $('#cmdk-overlay').classList.remove('show'); }
$('#cmdk-open').addEventListener('click', openCmdk);
$('#cmdk-overlay').addEventListener('click', e => { if (e.target === $('#cmdk-overlay')) closeCmdk(); });
$('#cmdk-input').addEventListener('input', () => renderCmdk($('#cmdk-input').value));
document.addEventListener('keydown', e => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k'){
    e.preventDefault();
    $('#cmdk-overlay').classList.contains('show') ? closeCmdk() : openCmdk();
  }
  if (e.key === 'Escape'){ closeCmdk(); closeSettings(); closeDialog(); }
  if ($('#cmdk-overlay').classList.contains('show') && (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter')){
    e.preventDefault();
    const items = $$('.cmdk-item');
    if (!items.length) return;
    if (e.key === 'Enter'){
      const item = state.cmdkItems[state.cmdkSel];
      if (item){ closeCmdk(); item.run(); }
      return;
    }
    state.cmdkSel = (state.cmdkSel + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length;
    items.forEach((it, i) => it.classList.toggle('sel', i === state.cmdkSel));
    items[state.cmdkSel].scrollIntoView({ block: 'nearest' });
  }
});

/* ================= 初始化 ================= */
setTheme(localStorage.getItem('ekh_theme') || 'light');
if (API.token){
  API.get('/auth/me').then(r => boot(r.user)).catch(() => doLogout(false));
} else {
  $('#view-login').style.display = '';
}
