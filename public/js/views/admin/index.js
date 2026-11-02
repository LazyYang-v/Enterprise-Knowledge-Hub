// 管理控制台：工具注册表、MCP、平台模型、服务主体与 Skills。
import { $, $$, esc } from '../../core/dom.js';
import { api } from '../../core/api.js';
import { describeApiError } from '../../core/api-error.js';
import { fmtTime, relTime, prettyJson, fmtSize, shortId } from '../../core/format.js';
import {
  toast, openDialog, openDrawer, confirmDialog, errorBlock, emptyBlock, skeletonRows,
  statusBadge, platformDisabledBlock, bindRetry,
} from '../../core/ui.js';
import { navigate } from '../../core/navigation.js';
import { store } from '../../core/store.js';
import { isAdmin, isPlatformAdmin } from '../../core/permissions.js';

const SECTIONS = [
  { key: 'tools', label: '工具注册表', href: '#/admin/tools', admin: 'org', desc: '查看工具描述、schema、执行属性与租户策略，启停 MCP/自定义工具。' },
  { key: 'mcp', label: 'MCP 连接', href: '#/admin/mcp', admin: 'org', desc: '管理 Streamable HTTP 连接、出网允许列表与工具刷新。' },
  { key: 'models', label: '平台模型', href: '#/admin/models', admin: 'platform', desc: '配置任务 Worker 使用的模型与凭证引用。' },
  { key: 'principals', label: '服务主体', href: '#/admin/principals', admin: 'platform', desc: '创建服务令牌并限定知识库与工具范围。' },
  { key: 'skills', label: 'Skills', href: '#/admin/skills', admin: 'platform', desc: '查看 Skill 风险、所需工具与加载状态。' },
];

function allowed(section){
  if (section.admin === 'platform') return isPlatformAdmin();
  return isAdmin();
}

function shell(section, key, actions = ''){
  const active = SECTIONS.find(item => item.key === key);
  section.innerHTML = `<div class="page admin-page">
    <header class="page-header">
      <div><h2 tabindex="-1">管理 · ${esc(active.label)}</h2><p class="subtitle">${esc(active.desc)}</p></div>
      <div class="header-actions">${actions}</div>
    </header>
    <div class="admin-layout">
      <nav class="admin-nav" aria-label="管理导航">
        ${SECTIONS.map(item => `<a class="admin-nav-item${item.key === key ? ' active' : ''}" href="${item.href}"${item.key === key ? ' aria-current="page"' : ''}${allowed(item) ? '' : ' hidden'}>${esc(item.label)}</a>`).join('')}
      </nav>
      <div class="admin-content" data-admin-content>${skeletonRows(4)}</div>
    </div>
  </div>`;
  return $('[data-admin-content]', section);
}

function guardSection(section, key){
  if (!store.platformEnabled){
    section.innerHTML = `<div class="page">${platformDisabledBlock()}</div>`;
    return false;
  }
  const item = SECTIONS.find(entry => entry.key === key);
  if (item && !allowed(item)){
    section.innerHTML = `<div class="page">${emptyBlock('没有权限', '该管理区块需要更高的管理员权限。')}</div>`;
    return false;
  }
  return true;
}

/* ================= 工具注册表 ================= */
async function mountTools(section, signal){
  if (!guardSection(section, 'tools')) return;
  const root = shell(section, 'tools', '<button class="btn" data-refresh>刷新</button>');
  let tools = [];
  let source = 'all';
  let query = '';
  let loading = false;

  async function load(){
    if (loading) return;
    loading = true;
    root.innerHTML = skeletonRows(4);
    try {
      const data = await api.get('/tools/registry?include_disabled=1', { signal });
      if (signal.aborted) return;
      tools = data.tools || [];
      render();
    } catch (error){
      if (signal.aborted) return;
      root.innerHTML = errorBlock(error);
      bindRetry(root, load);
    } finally { loading = false; }
  }

  function filtered(){
    return tools.filter(tool => (source === 'all' || tool.source === source)
      && (!query || tool.name.toLowerCase().includes(query.toLowerCase())));
  }

  function renderRows(){
    const tbody = $('[data-tbody]', root);
    if (!tbody) return;
    const rows = filtered();
    tbody.innerHTML = rows.map(tool => `<tr>
      <td><strong>${esc(tool.name)}</strong><div class="muted clamp-1">${esc(tool.description || '')}</div></td>
      <td>${esc(tool.source)}</td>
      <td class="mono">${esc(tool.version || '')}</td>
      <td>${esc(tool.side_effect || '')}</td>
      <td>${esc(tool.approval_policy || '')}</td>
      <td>${tool.source === 'builtin'
        ? '<span class="muted">内置</span>'
        : `<label class="switch"><input type="checkbox" data-enable="${esc(tool.name)}" ${tool.enabled !== false ? 'checked' : ''} aria-label="启用 ${esc(tool.name)}"><span></span></label>`}</td>
      <td class="row-actions"><button class="btn small" data-detail="${esc(tool.name)}">详情</button></td>
    </tr>`).join('') || `<tr><td colspan="7">${emptyBlock('没有匹配工具')}</td></tr>`;
    $$('[data-detail]', tbody).forEach(button => button.addEventListener('click', () => showToolDetail(button.dataset.detail)));
    $$('[data-enable]', tbody).forEach(input => input.addEventListener('change', () => toggleTool(input.dataset.enable, input.checked, input)));
  }

  function render(){
    root.innerHTML = `<div class="toolbar">
      <div class="segmented" role="group" aria-label="工具来源">
        ${['all', 'builtin', 'custom', 'mcp'].map(value => `<button class="segmented-item${source === value ? ' active' : ''}" data-source="${value}">${value === 'all' ? '全部' : value}</button>`).join('')}
      </div>
      <input class="input search-input" type="search" data-search value="${esc(query)}" placeholder="搜索工具名…" aria-label="搜索工具">
    </div>
    <div class="table-wrap"><table class="data-table">
      <thead><tr><th>工具</th><th>来源</th><th>版本</th><th>副作用</th><th>审批</th><th>启用</th><th></th></tr></thead>
      <tbody data-tbody></tbody>
    </table></div>`;
    $$('[data-source]', root).forEach(button => button.addEventListener('click', () => {
      source = button.dataset.source;
      $$('[data-source]', root).forEach(item => item.classList.toggle('active', item === button));
      renderRows();
    }));
    const search = $('[data-search]', root);
    search.addEventListener('input', () => { query = search.value.trim(); renderRows(); });
    renderRows();
  }

  async function toggleTool(name, enabled, input){
    input.disabled = true;
    try {
      await api.patch(`/tools/registry/${encodeURIComponent(name)}/enabled`, { enabled });
      const tool = tools.find(item => item.name === name);
      if (tool) tool.enabled = enabled;
      toast(`${name} 已${enabled ? '启用' : '停用'}`);
    } catch (error){
      input.checked = !enabled;
      toast(describeApiError(error), false);
    } finally { input.disabled = false; }
  }

  async function showToolDetail(name){
    const tool = tools.find(item => item.name === name);
    if (!tool) return;
    const { el } = openDrawer({
      title: tool.name,
      wide: true,
      body: `<div class="stack">
        <p>${esc(tool.description || '')}</p>
        <dl class="kv">
          <div><dt>来源</dt><dd>${esc(tool.source)}</dd></div>
          <div><dt>版本</dt><dd class="mono">${esc(tool.version || '')}</dd></div>
          <div><dt>副作用</dt><dd>${esc(tool.side_effect || '')}</dd></div>
          <div><dt>幂等</dt><dd>${esc(tool.idempotency || '')}</dd></div>
          <div><dt>沙箱</dt><dd>${esc(tool.sandbox_profile || '')}</dd></div>
          <div><dt>Schema 哈希</dt><dd class="mono">${esc(String(tool.schema_hash || '').slice(0, 16))}</dd></div>
        </dl>
        <section><h4>输入 Schema</h4><pre class="code-block">${esc(prettyJson(tool.input_schema || {}))}</pre></section>
        <section><h4>租户策略</h4><div data-policies>加载中…</div></section>
      </div>`,
      footer: '<button class="btn" data-drawer-close>关闭</button><button class="btn primary" data-add-policy>新增策略</button>',
    });
    $('[data-add-policy]', el).addEventListener('click', () => openPolicyDialog(name, null, loadPolicies));
    const policiesBox = $('[data-policies]', el);
    async function loadPolicies(){
      try {
        const data = await api.get(`/tools/registry/${encodeURIComponent(name)}/policies`);
        renderPolicies(data.policies || []);
      } catch (error){ policiesBox.innerHTML = errorBlock(error); }
    }
    function renderPolicies(policies){
      policiesBox.innerHTML = policies.length ? `<table class="data-table compact">
        <thead><tr><th>主体</th><th>审批</th><th>次数</th><th>启用</th><th></th></tr></thead>
        <tbody>${policies.map(policy => `<tr>
          <td>${esc(policy.principal_type)}:${esc(policy.principal_id)}</td>
          <td>${esc(policy.approval_mode)}</td>
          <td>${policy.max_calls_per_task ?? '—'}</td>
          <td>${policy.enabled ? '是' : '否'}</td>
          <td class="row-actions"><button class="btn small" data-edit-policy="${esc(policy.id)}">编辑</button>
          <button class="btn small danger" data-delete-policy="${esc(policy.id)}">删除</button></td>
        </tr>`).join('')}</tbody></table>` : '<p class="muted">没有租户策略。</p>';
      $$('[data-edit-policy]', policiesBox).forEach(button => button.addEventListener('click', () => {
        const policy = policies.find(item => item.id === button.dataset.editPolicy);
        openPolicyDialog(name, policy, loadPolicies);
      }));
      $$('[data-delete-policy]', policiesBox).forEach(button => button.addEventListener('click', async () => {
        const policy = policies.find(item => item.id === button.dataset.deletePolicy);
        if (!policy) return;
        const ok = await confirmDialog({ title: '删除策略', message: '删除后该主体回退到默认策略，确定继续？', confirmText: '删除', danger: true });
        if (!ok) return;
        try {
          await api.del(`/tools/registry/${encodeURIComponent(name)}/policy?principal_type=${encodeURIComponent(policy.principal_type)}&principal_id=${encodeURIComponent(policy.principal_id)}`);
          toast('策略已删除');
          loadPolicies();
        } catch (error){ toast(describeApiError(error), false); }
      }));
    }
    loadPolicies();
  }

  function openPolicyDialog(name, policy, onSaved){
    const principalType = policy?.principal_type || 'tenant';
    const { el, close } = openDialog(`<div class="dialog-header"><h3 class="dialog-title">${policy ? '编辑' : '新增'}工具策略</h3><button class="icon-btn" data-dialog-close>✕</button></div>
      <form class="dialog-body" data-policy-form>
        <div class="form-grid">
          <label class="field"><span class="field-label">主体类型</span><select class="select" name="principal_type">
            ${['tenant', 'user', 'role', 'preset'].map(value => `<option value="${value}"${value === principalType ? ' selected' : ''}>${value}</option>`).join('')}
          </select></label>
          <label class="field"><span class="field-label">主体 ID</span><input class="input" name="principal_id" value="${esc(policy?.principal_id || '')}" placeholder="tenant 可留空"></label>
        </div>
        <div class="form-grid">
          <label class="field"><span class="field-label">审批模式</span><select class="select" name="approval_mode">
            ${['risk_based', 'always', 'never'].map(value => `<option value="${value}"${value === (policy?.approval_mode || 'risk_based') ? ' selected' : ''}>${value}</option>`).join('')}
          </select></label>
          <label class="field"><span class="field-label">单任务最大调用</span><input class="input" type="number" min="0" name="max_calls_per_task" value="${policy?.max_calls_per_task ?? ''}"></label>
        </div>
        <label class="field"><span class="field-label">允许范围（逗号分隔）</span><input class="input" name="allowed_scopes" value="${esc((policy?.allowed_scopes || []).join(', '))}"></label>
        <label class="check-row"><input type="checkbox" name="enabled" ${policy?.enabled !== false ? 'checked' : ''}><span>启用</span></label>
        <p class="form-error" data-form-error role="alert" hidden></p>
        <div class="dialog-footer"><button type="button" class="btn" data-dialog-close>取消</button><button class="btn primary" type="submit">保存</button></div>
      </form>`);
    $('[data-policy-form]', el).addEventListener('submit', async event => {
      event.preventDefault();
      const form = event.target;
      const errorBox = $('[data-form-error]', el);
      const maxCalls = form.elements.max_calls_per_task.value;
      try {
        await api.patch(`/tools/registry/${encodeURIComponent(name)}/policy`, {
          principal_type: form.elements.principal_type.value,
          principal_id: form.elements.principal_id.value.trim() || undefined,
          approval_mode: form.elements.approval_mode.value,
          max_calls_per_task: maxCalls === '' ? null : Number(maxCalls),
          allowed_scopes: form.elements.allowed_scopes.value.split(',').map(item => item.trim()).filter(Boolean),
          enabled: form.elements.enabled.checked,
        });
        close();
        toast('策略已保存');
        onSaved?.();
      } catch (error){
        errorBox.textContent = describeApiError(error);
        errorBox.hidden = false;
      }
    });
  }

  $('[data-refresh]', section)?.addEventListener('click', load);
  await load();
}

/* ================= MCP 连接 ================= */
async function mountMcp(section, signal){
  if (!guardSection(section, 'mcp')) return;
  const root = shell(section, 'mcp', '<button class="btn primary" data-create>新建连接</button>');
  let connections = [];

  async function load(){
    root.innerHTML = skeletonRows(3);
    try {
      const data = await api.get('/mcp/connections', { signal });
      if (signal.aborted) return;
      connections = data.connections || [];
      render();
    } catch (error){
      if (signal.aborted) return;
      root.innerHTML = errorBlock(error);
      bindRetry(root, load);
    }
  }

  function render(){
    root.innerHTML = `<div class="table-wrap"><table class="data-table">
      <thead><tr><th>名称</th><th>Endpoint</th><th>状态</th><th>凭证</th><th>允许列表</th><th>最近健康</th><th></th></tr></thead>
      <tbody>${connections.map(connection => `<tr>
        <td><strong>${esc(connection.name)}</strong><div class="muted">${esc(connection.transport)}</div></td>
        <td class="mono clamp-1">${esc(connection.endpoint)}</td>
        <td>${statusBadge(connection.status, connection.status === 'active' ? 'success' : 'neutral')}</td>
        <td>${connection.credential_configured ? '已配置' : '无'}</td>
        <td>${(connection.egress_allowlist || []).length} 项</td>
        <td>${esc(connection.last_health_at ? relTime(connection.last_health_at) : '—')}</td>
        <td class="row-actions">
          <button class="btn small" data-edit="${esc(connection.id)}">编辑</button>
          <button class="btn small" data-test="${esc(connection.id)}">测试</button>
          <button class="btn small" data-refresh-tools="${esc(connection.id)}">刷新工具</button>
          <button class="btn small" data-tools="${esc(connection.id)}">工具</button>
          <button class="btn small danger" data-delete="${esc(connection.id)}">删除</button>
        </td>
      </tr>`).join('') || `<tr><td colspan="7">${emptyBlock('还没有 MCP 连接', '创建一个 Streamable HTTP 连接后刷新工具。')}</td></tr>`}</tbody>
    </table></div>`;
    $('[data-create]', section).addEventListener('click', () => editConnection(null));
    $$('[data-edit]', root).forEach(button => button.addEventListener('click', () => editConnection(connections.find(item => item.id === button.dataset.edit))));
    $$('[data-test]', root).forEach(button => button.addEventListener('click', () => testConnection(button.dataset.test, button)));
    $$('[data-refresh-tools]', root).forEach(button => button.addEventListener('click', () => refreshTools(button.dataset.refreshTools, button)));
    $$('[data-tools]', root).forEach(button => button.addEventListener('click', () => showTools(button.dataset.tools)));
    $$('[data-delete]', root).forEach(button => button.addEventListener('click', () => removeConnection(button.dataset.delete)));
  }

  function readList(form, name){
    return String(form.elements[name].value || '').split(',').map(item => item.trim()).filter(Boolean);
  }

  function editConnection(connection){
    const { el, close } = openDialog(`<div class="dialog-header"><h3 class="dialog-title">${connection ? '编辑' : '新建'} MCP 连接</h3><button class="icon-btn" data-dialog-close>✕</button></div>
      <form class="dialog-body" data-mcp-form>
        <div class="form-grid">
          <label class="field"><span class="field-label">名称</span><input class="input" name="name" value="${esc(connection?.name || '')}" ${connection ? 'disabled' : ''} required placeholder="crm"></label>
          <label class="field"><span class="field-label">认证类型</span><input class="input" name="auth_type" value="${esc(connection?.auth_type || 'none')}" placeholder="none / bearer"></label>
        </div>
        <label class="field"><span class="field-label">Endpoint</span><input class="input" name="endpoint" value="${esc(connection?.endpoint || '')}" required placeholder="https://mcp.example.com/mcp"></label>
        <label class="field"><span class="field-label">凭证引用</span><input class="input" name="credential_ref" type="password" placeholder="${connection?.credential_configured ? '留空保持现有凭证' : 'env:CRM_TOKEN 或 file:/path'}"><span class="field-hint">只保存引用，不回显密钥。</span></label>
        <div class="form-grid">
          <label class="field"><span class="field-label">允许工具（逗号分隔）</span><input class="input" name="allowed_tools" value="${esc((connection?.allowed_tools || []).join(', '))}"></label>
          <label class="field"><span class="field-label">拒绝工具</span><input class="input" name="denied_tools" value="${esc((connection?.denied_tools || []).join(', '))}"></label>
        </div>
        <label class="field"><span class="field-label">出网允许列表</span><input class="input" name="egress_allowlist" value="${esc((connection?.egress_allowlist || []).join(', '))}" placeholder="mcp.example.com"><span class="field-hint">默认拒绝私网与元数据地址；留空不额外限制主机。</span></label>
        <p class="form-error" data-form-error role="alert" hidden></p>
        <div class="dialog-footer"><button type="button" class="btn" data-dialog-close>取消</button><button class="btn primary" type="submit">保存</button></div>
      </form>`, { lg: true });
    $('[data-mcp-form]', el).addEventListener('submit', async event => {
      event.preventDefault();
      const form = event.target;
      const body = {
        endpoint: form.elements.endpoint.value.trim(),
        auth_type: form.elements.auth_type.value.trim() || 'none',
        credential_ref: form.elements.credential_ref.value.trim(),
        allowed_tools: readList(form, 'allowed_tools'),
        denied_tools: readList(form, 'denied_tools'),
        egress_allowlist: readList(form, 'egress_allowlist'),
      };
      if (!connection){
        body.name = form.elements.name.value.trim();
        body.transport = 'streamable_http';
      } else if (!body.credential_ref){
        delete body.credential_ref;
      }
      try {
        if (connection) await api.patch(`/mcp/connections/${connection.id}`, body);
        else await api.post('/mcp/connections', body);
        close();
        toast('MCP 连接已保存');
        load();
      } catch (error){
        const box = $('[data-form-error]', el);
        box.textContent = describeApiError(error);
        box.hidden = false;
      }
    });
  }

  async function testConnection(id, button){
    button.disabled = true;
    button.textContent = '测试中…';
    try {
      const result = await api.post(`/mcp/connections/${id}/test`, {});
      toast(result.ok ? `连接成功，发现 ${result.tools_count} 个工具` : `连接失败：${result.message || ''}`, !!result.ok);
      load();
    } catch (error){ toast(describeApiError(error), false); }
    finally { button.disabled = false; button.textContent = '测试'; }
  }

  async function refreshTools(id, button){
    button.disabled = true;
    button.textContent = '刷新中…';
    try {
      const result = await api.post(`/mcp/connections/${id}/refresh`, {});
      toast(`已刷新 ${result.tools?.length || 0} 个工具`);
      load();
    } catch (error){ toast(describeApiError(error), false); }
    finally { button.disabled = false; button.textContent = '刷新工具'; }
  }

  async function showTools(id){
    const connection = connections.find(item => item.id === id);
    const { el } = openDrawer({ title: `工具 · ${connection?.name || ''}`, wide: true, body: '<div data-tools-body>加载中…</div>' });
    try {
      const data = await api.get(`/mcp/connections/${id}/tools`);
      $('[data-tools-body]', el).innerHTML = (data.tools || []).length
        ? `<div class="tool-list">${data.tools.map(tool => `<article class="tool-card"><strong>${esc(tool.name)}</strong><p class="muted">${esc(tool.description || '')}</p>${tool.schema_hash ? `<div class="mono muted">${esc(tool.schema_hash.slice(0, 16))}</div>` : ''}</article>`).join('')}</div>`
        : '<p class="muted">缓存中没有工具，请先刷新。</p>';
    } catch (error){ $('[data-tools-body]', el).innerHTML = errorBlock(error); }
  }

  async function removeConnection(id){
    const connection = connections.find(item => item.id === id);
    const ok = await confirmDialog({ title: '删除 MCP 连接', message: `确定删除「${connection?.name || ''}」及其注册工具？`, confirmText: '删除', danger: true });
    if (!ok) return;
    try { await api.del(`/mcp/connections/${id}`); toast('连接已删除'); load(); }
    catch (error){ toast(describeApiError(error), false); }
  }

  await load();
}

/* ================= 平台模型 ================= */
async function mountModels(section, signal){
  if (!guardSection(section, 'models')) return;
  const root = shell(section, 'models', '<button class="btn primary" data-create>新建模型</button>');
  let profiles = [];

  async function load(){
    root.innerHTML = skeletonRows(3);
    try {
      const data = await api.get('/model-profiles', { signal });
      if (signal.aborted) return;
      profiles = data.profiles || [];
      render();
    } catch (error){
      if (signal.aborted) return;
      root.innerHTML = errorBlock(error);
      bindRetry(root, load);
    }
  }

  function render(){
    root.innerHTML = `<div class="table-wrap"><table class="data-table">
      <thead><tr><th>名称</th><th>Provider</th><th>模型</th><th>Base URL</th><th>上下文</th><th>凭证</th><th>启用</th><th></th></tr></thead>
      <tbody>${profiles.map(profile => `<tr>
        <td><strong>${esc(profile.name)}</strong></td>
        <td>${esc(profile.provider || '—')}</td>
        <td class="mono">${esc(profile.model_name || '')}</td>
        <td class="mono clamp-1">${esc(profile.base_url || '')}</td>
        <td>${profile.context_window ?? '—'}</td>
        <td>${profile.credential_configured ? '已配置' : '无'}</td>
        <td>${profile.enabled ? '是' : '否'}</td>
        <td class="row-actions">
          <button class="btn small" data-edit="${esc(profile.id)}">编辑</button>
          <button class="btn small" data-test="${esc(profile.id)}">测试</button>
          <button class="btn small danger" data-delete="${esc(profile.id)}">删除</button>
        </td>
      </tr>`).join('') || `<tr><td colspan="8">${emptyBlock('还没有模型配置', '创建后 Worker 才能执行任务。')}</td></tr>`}</tbody>
    </table></div>`;
    $('[data-create]', section).addEventListener('click', () => editProfile(null));
    $$('[data-edit]', root).forEach(button => button.addEventListener('click', () => editProfile(profiles.find(item => item.id === button.dataset.edit))));
    $$('[data-test]', root).forEach(button => button.addEventListener('click', () => testProfile(button.dataset.test, button)));
    $$('[data-delete]', root).forEach(button => button.addEventListener('click', () => removeProfile(button.dataset.delete)));
  }

  function editProfile(profile){
    const { el, close } = openDialog(`<div class="dialog-header"><h3 class="dialog-title">${profile ? '编辑' : '新建'}模型</h3><button class="icon-btn" data-dialog-close>✕</button></div>
      <form class="dialog-body" data-model-form>
        <div class="form-grid">
          <label class="field"><span class="field-label">名称</span><input class="input" name="name" value="${esc(profile?.name || '')}" required></label>
          <label class="field"><span class="field-label">Provider</span><input class="input" name="provider" value="${esc(profile?.provider || '')}" placeholder="anthropic / openai-compatible"></label>
        </div>
        <label class="field"><span class="field-label">模型 ID</span><input class="input" name="model_name" value="${esc(profile?.model_name || '')}" required></label>
        <label class="field"><span class="field-label">Base URL</span><input class="input" name="base_url" value="${esc(profile?.base_url || '')}" required placeholder="https://api.example.com/v1"></label>
        <label class="field"><span class="field-label">凭证引用</span><input class="input" name="credential_ref" type="password" placeholder="${profile?.credential_configured ? '留空保持现有凭证' : 'env:MODEL_API_KEY'}"><span class="field-hint">只保存引用，不回显密钥。</span></label>
        <div class="form-grid">
          <label class="field"><span class="field-label">上下文窗口</span><input class="input" type="number" min="1" name="context_window" value="${profile?.context_window ?? ''}"></label>
          <label class="field"><span class="field-label">能力 JSON</span><textarea class="textarea" name="capabilities" rows="3">${esc(prettyJson(profile?.capabilities || {}))}</textarea></label>
        </div>
        <label class="check-row"><input type="checkbox" name="enabled" ${profile?.enabled !== false ? 'checked' : ''}><span>启用</span></label>
        <p class="form-error" data-form-error role="alert" hidden></p>
        <div class="dialog-footer"><button type="button" class="btn" data-dialog-close>取消</button><button class="btn primary" type="submit">保存</button></div>
      </form>`, { lg: true });
    $('[data-model-form]', el).addEventListener('submit', async event => {
      event.preventDefault();
      const form = event.target;
      let capabilities;
      try { capabilities = JSON.parse(form.elements.capabilities.value || '{}'); }
      catch { const box = $('[data-form-error]', el); box.textContent = '能力 JSON 不合法'; box.hidden = false; return; }
      const body = {
        name: form.elements.name.value.trim(),
        provider: form.elements.provider.value.trim(),
        model_name: form.elements.model_name.value.trim(),
        base_url: form.elements.base_url.value.trim(),
        context_window: form.elements.context_window.value ? Number(form.elements.context_window.value) : null,
        capabilities,
        enabled: form.elements.enabled.checked,
      };
      const credential = form.elements.credential_ref.value.trim();
      if (credential) body.credential_ref = credential;
      try {
        if (profile) await api.patch(`/model-profiles/${profile.id}`, body);
        else await api.post('/model-profiles', body);
        close();
        toast('模型配置已保存');
        load();
      } catch (error){
        const box = $('[data-form-error]', el);
        box.textContent = describeApiError(error);
        box.hidden = false;
      }
    });
  }

  async function testProfile(id, button){
    button.disabled = true;
    button.textContent = '测试中…';
    try {
      const result = await api.post(`/model-profiles/${id}/test`, {});
      toast(result.ok ? `模型可用：${result.model || ''}` : `模型不可用：${result.message || ''}`, !!result.ok);
    } catch (error){ toast(describeApiError(error), false); }
    finally { button.disabled = false; button.textContent = '测试'; }
  }

  async function removeProfile(id){
    const profile = profiles.find(item => item.id === id);
    const ok = await confirmDialog({ title: '删除模型', message: `确定删除「${profile?.name || ''}」？`, confirmText: '删除', danger: true });
    if (!ok) return;
    try { await api.del(`/model-profiles/${id}`); toast('模型已删除'); load(); }
    catch (error){ toast(describeApiError(error), false); }
  }

  await load();
}

function principalStatus(principal){
  if (principal.revoked_at) return 'revoked';
  if (principal.expires_at && new Date(principal.expires_at).getTime() <= Date.now()) return 'expired';
  return 'active';
}

/* ================= 服务主体 ================= */
async function mountPrincipals(section, signal){
  if (!guardSection(section, 'principals')) return;
  const root = shell(section, 'principals', '<button class="btn primary" data-create>新建服务主体</button>');
  let principals = [];

  async function load(){
    root.innerHTML = skeletonRows(3);
    try {
      const data = await api.get('/service-principals', { signal });
      if (signal.aborted) return;
      principals = data.principals || [];
      render();
    } catch (error){
      if (signal.aborted) return;
      root.innerHTML = errorBlock(error);
      bindRetry(root, load);
    }
  }

  function render(){
    root.innerHTML = `<div class="table-wrap"><table class="data-table">
      <thead><tr><th>名称</th><th>状态</th><th>范围</th><th>创建</th><th>最近使用</th><th>过期</th><th></th></tr></thead>
      <tbody>${principals.map(principal => {
        const status = principalStatus(principal);
        return `<tr>
        <td><strong>${esc(principal.name)}</strong><div class="muted mono">#${esc(shortId(principal.id, 8))}</div></td>
        <td>${statusBadge(status, status === 'active' ? 'success' : status === 'revoked' ? 'danger' : 'neutral')}</td>
        <td>${principal.scopes?.all_kbs ? '全部知识库' : `${(principal.scopes?.kb_ids || []).length} 个知识库`} · ${(principal.scopes?.tools || []).length} 个工具</td>
        <td>${esc(fmtTime(principal.created_at))}</td>
        <td>${esc(principal.last_used_at ? relTime(principal.last_used_at) : '—')}</td>
        <td>${esc(principal.expires_at ? fmtTime(principal.expires_at) : '—')}</td>
        <td class="row-actions">
          ${status === 'active' ? `<button class="btn small" data-rotate="${esc(principal.id)}">轮换</button>
          <button class="btn small danger" data-revoke="${esc(principal.id)}">吊销</button>` : ''}
        </td>
      </tr>`;
      }).join('') || `<tr><td colspan="7">${emptyBlock('还没有服务主体', '创建后用于 MCP 或检索接口的服务身份。')}</td></tr>`}</tbody>
    </table></div>`;
    $('[data-create]', section).addEventListener('click', openCreate);
    $$('[data-rotate]', root).forEach(button => button.addEventListener('click', () => rotate(button.dataset.rotate)));
    $$('[data-revoke]', root).forEach(button => button.addEventListener('click', () => revoke(button.dataset.revoke)));
  }

  async function openCreate(){
    const { el, close } = openDialog(`<div class="dialog-header"><h3 class="dialog-title">新建服务主体</h3><button class="icon-btn" data-dialog-close>✕</button></div>
      <form class="dialog-body" data-principal-form>
        <label class="field"><span class="field-label">名称</span><input class="input" name="name" required maxlength="120"></label>
        <label class="check-row"><input type="checkbox" name="all_kbs"><span>允许访问全部知识库</span></label>
        <label class="field"><span class="field-label">指定知识库</span><select class="select" name="kb_ids" multiple size="4" data-kb-select></select></label>
        <label class="field"><span class="field-label">允许工具</span><select class="select" name="tools" multiple size="4" data-tool-select></select></label>
        <label class="field"><span class="field-label">过期时间</span><input class="input" type="datetime-local" name="expires_at"></label>
        <p class="form-error" data-form-error role="alert" hidden></p>
        <div class="dialog-footer"><button type="button" class="btn" data-dialog-close>取消</button><button class="btn primary" type="submit">创建</button></div>
      </form>`, { lg: true });
    const [kbs, tools] = await Promise.all([
      api.get('/kbs').catch(() => ({ kbs: [] })),
      api.get('/tools/registry').catch(() => ({ tools: [] })),
    ]);
    $('[data-kb-select]', el).innerHTML = (kbs.kbs || []).map(kb => `<option value="${esc(kb.id)}">${esc(kb.name)}</option>`).join('');
    $('[data-tool-select]', el).innerHTML = (tools.tools || []).map(tool => `<option value="${esc(tool.name)}">${esc(tool.name)}</option>`).join('');
    $('[data-principal-form]', el).addEventListener('submit', async event => {
      event.preventDefault();
      const form = event.target;
      const body = {
        name: form.elements.name.value.trim(),
        scopes: {
          all_kbs: form.elements.all_kbs.checked,
          kb_ids: form.elements.all_kbs.checked ? [] : Array.from(form.elements.kb_ids.selectedOptions).map(option => option.value),
          tools: Array.from(form.elements.tools.selectedOptions).map(option => option.value),
        },
        expires_at: form.elements.expires_at.value || null,
      };
      try {
        const data = await api.post('/service-principals', body);
        close();
        showToken(data.token, data.principal?.name || body.name);
        load();
      } catch (error){
        const box = $('[data-form-error]', el);
        box.textContent = describeApiError(error);
        box.hidden = false;
      }
    });
  }

  function showToken(token, name){
    const { el } = openDialog(`<div class="dialog-header"><h3 class="dialog-title">服务令牌（仅显示一次）</h3><button class="icon-btn" data-dialog-close>✕</button></div>
      <div class="dialog-body"><p>请立即复制并安全保存 <strong>${esc(name)}</strong> 的令牌。关闭后无法再次查看。</p>
      <pre class="code-block token-value">${esc(token)}</pre></div>
      <div class="dialog-footer"><button class="btn" data-copy>复制</button><button class="btn primary" data-dialog-close>我已保存</button></div>`);
    $('[data-copy]', el).addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(token); toast('令牌已复制'); }
      catch { toast('复制失败，请手动选择', false); }
    });
  }

  async function rotate(id){
    const ok = await confirmDialog({ title: '轮换令牌', message: '旧令牌会立即失效，确定继续？', confirmText: '轮换', danger: true });
    if (!ok) return;
    try {
      const data = await api.post(`/service-principals/${id}/rotate`, {});
      showToken(data.token, data.principal?.name || '');
      load();
    } catch (error){ toast(describeApiError(error), false); }
  }

  async function revoke(id){
    const ok = await confirmDialog({ title: '吊销服务主体', message: '吊销后该身份立即失效，且不可恢复。', confirmText: '吊销', danger: true });
    if (!ok) return;
    try { await api.del(`/service-principals/${id}`); toast('已吊销'); load(); }
    catch (error){ toast(describeApiError(error), false); }
  }

  await load();
}

/* ================= Skills ================= */
async function mountSkills(section, signal){
  if (!guardSection(section, 'skills')) return;
  const root = shell(section, 'skills', isPlatformAdmin() ? '<button class="btn" data-reload>重新扫描</button>' : '');
  let skills = [];

  async function load(){
    root.innerHTML = skeletonRows(3);
    try {
      const data = await api.get('/skills', { signal });
      if (signal.aborted) return;
      skills = data.skills || [];
      render();
    } catch (error){
      if (signal.aborted) return;
      root.innerHTML = errorBlock(error);
      bindRetry(root, load);
    }
  }

  function render(){
    root.innerHTML = `<div class="profile-list">${skills.map(skill => `<div class="profile-row">
      <div><strong>${esc(skill.name)}</strong><span class="muted"> · ${esc(skill.version)}</span>
        <p class="muted">${esc(skill.description || '')}</p>
        <div class="row wrap">${(skill.required_tools || []).map(tool => `<span class="tag">${esc(tool)}</span>`).join('')}</div>
      </div>
      <div class="row-actions">
        ${statusBadge(skill.status, skill.status === 'active' ? 'success' : 'neutral')}
        ${statusBadge(skill.risk_level, skill.risk_level === 'high' ? 'danger' : skill.risk_level === 'medium' ? 'warning' : 'neutral')}
        <button class="btn small" data-detail="${esc(skill.id)}">详情</button>
      </div>
    </div>`).join('') || emptyBlock('还没有 Skill', '把 SKILL.md 放入 skills 目录后重新扫描。')}</div>`;
    $('[data-reload]', section)?.addEventListener('click', reloadSkills);
    $$('[data-detail]', root).forEach(button => button.addEventListener('click', () => showSkill(button.dataset.detail)));
  }

  async function showSkill(id){
    try {
      const data = await api.get(`/skills/${id}`);
      const skill = data.skill;
      openDrawer({
        title: `${skill.name}@${skill.version}`,
        wide: true,
        body: `<div class="stack">
          <p>${esc(skill.description || '')}</p>
          <dl class="kv">
            <div><dt>状态</dt><dd>${esc(skill.status)}</dd></div>
            <div><dt>风险</dt><dd>${esc(skill.risk_level)}</dd></div>
            <div><dt>可选</dt><dd>${skill.selectable ? '是' : esc(skill.unavailable_reason || '否')}</dd></div>
            <div><dt>哈希</dt><dd class="mono">${esc(String(skill.content_hash || '').slice(0, 16))}</dd></div>
          </dl>
          <section><h4>指令</h4><pre class="code-block">${esc(skill.instructions || '')}</pre></section>
        </div>`,
      });
    } catch (error){ toast(describeApiError(error), false); }
  }

  async function reloadSkills(){
    try {
      const result = await api.post('/skills/reload', {});
      toast(`发现 ${result.discovered}，加载 ${result.loaded}，新增 ${result.inserted}，更新 ${result.updated}`);
      load();
    } catch (error){ toast(describeApiError(error), false); }
  }

  await load();
}

const MOUNTERS = {
  tools: mountTools,
  mcp: mountMcp,
  models: mountModels,
  principals: mountPrincipals,
  skills: mountSkills,
};

export function adminRoute(key){
  return {
    path: `/admin/${key}`,
    name: `admin-${key}`,
    viewId: 'admin',
    nav: 'admin',
    label: SECTIONS.find(item => item.key === key)?.label || '管理',
    title: () => `管理 · ${SECTIONS.find(item => item.key === key)?.label || ''}`,
    guard: () => {
      const item = SECTIONS.find(entry => entry.key === key);
      if (!item || allowed(item)) return { ok: true };
      return { ok: false, title: '没有权限', desc: '该管理区块需要更高的管理员权限。', tone: 'disabled' };
    },
    mount: (ctx, signal) => MOUNTERS[key]($('#view-admin'), signal),
  };
}

export function adminIndexRoute(){
  return { path: '/admin', name: 'admin', viewId: 'admin', mount(){ navigate('/admin/tools', { replace: true }); } };
}
