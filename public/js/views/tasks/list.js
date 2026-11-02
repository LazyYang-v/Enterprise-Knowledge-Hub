// 任务控制台：服务端筛选/搜索/游标分页与创建任务。
import { $, $$, esc } from '../../core/dom.js';
import { api } from '../../core/api.js';
import { ApiError, describeApiError } from '../../core/api-error.js';
import {
  TASK_FILTERS, statusForFilter, statusMeta, budgetMeters,
} from '../../core/task-model.js';
import { fmtTime, relTime, shortId } from '../../core/format.js';
import {
  toast, openDialog, errorBlock, emptyBlock, skeletonRows, statusBadge,
  platformDisabledBlock, bindRetry, bindTabKeys,
} from '../../core/ui.js';
import { navigate, replaceUrl } from '../../core/navigation.js';
import { store } from '../../core/store.js';

const BUDGET_PRESETS = {
  light: { max_steps: 12, max_model_calls: 12, max_tool_calls: 8, max_tokens: 60000, max_wall_ms: 10 * 60 * 1000 },
  standard: { max_steps: 40, max_model_calls: 40, max_tool_calls: 25, max_tokens: 200000, max_wall_ms: 30 * 60 * 1000 },
  deep: { max_steps: 80, max_model_calls: 80, max_tool_calls: 50, max_tokens: 500000, max_wall_ms: 60 * 60 * 1000 },
};

function taskRow(task){
  const meta = statusMeta(task.status);
  const usage = task.usage || {};
  const budget = task.budget || {};
  const extras = [];
  if (task.last_error_code) extras.push(`<span class="muted">错误：${esc(task.last_error_code)}</span>`);
  if (task.result_summary) extras.push(`<span class="muted">${esc(task.result_summary)}</span>`);
  return `<a class="task-row" href="#/tasks/${esc(task.id)}" data-task-id="${esc(task.id)}">
    <div class="task-row-main">
      <div class="task-row-title">${esc(task.title || '未命名任务')}</div>
      <div class="task-row-goal">${esc(task.goal || '')}</div>
      <div class="task-row-meta">
        <span>优先级 ${Number(task.priority ?? 100)}</span>
        <span>步骤 ${Number(usage.steps || 0)} / ${Number(budget.max_steps || '—')}</span>
        <span>${esc(relTime(task.updated_at))}</span>
        ${extras.join('')}
      </div>
    </div>
    <div class="task-row-side">
      ${statusBadge(meta.label, meta.tone)}
      <span class="muted mono">#${esc(shortId(task.id, 8))}</span>
    </div>
  </a>`;
}

export async function mountTaskList(ctx, signal){
  const section = $('#view-tasks');
  if (!store.platformEnabled){
    section.innerHTML = `<div class="page">${platformDisabledBlock()}</div>`;
    return;
  }
  const initialFilter = ctx.query.filter || 'all';
  const initialQuery = ctx.query.q || '';
  section.innerHTML = `<div class="page console-page">
    <header class="page-header">
      <div>
        <h2 tabindex="-1">任务</h2>
        <p class="subtitle">Agent 任务编排、工具调用与人类审批。创建后由 Worker 领取执行。</p>
      </div>
      <div class="header-actions">
        <button class="btn" data-refresh>刷新</button>
        <button class="btn primary" data-create>新建任务</button>
      </div>
    </header>
    <div class="toolbar">
      <div class="tabs" role="tablist" aria-label="任务状态筛选">
        ${TASK_FILTERS.map((item, index) => `<button class="tab${item.key === initialFilter ? ' active' : ''}" role="tab" data-filter="${item.key}" aria-selected="${item.key === initialFilter}" tabindex="${item.key === initialFilter ? 0 : -1}">${item.label} <span class="tab-badge" data-count="${item.key}"></span></button>`).join('')}
      </div>
      <div class="toolbar-group">
        <input class="input search-input" type="search" placeholder="搜索标题或目标…" data-search value="${esc(initialQuery)}" aria-label="搜索任务">
      </div>
    </div>
    <div class="content-scroll" data-list>${skeletonRows(3)}</div>
  </div>`;

  const listBox = $('[data-list]', section);
  let filter = initialFilter;
  let query = initialQuery;
  let cursor = null;
  let items = [];
  let nextCursor = null;
  let loading = false;
  let sequence = 0;
  let timer = null;

  const tabs = $$('[data-filter]', section);
  function selectFilter(next){
    filter = next;
    tabs.forEach(tab => {
      const active = tab.dataset.filter === next;
      tab.classList.toggle('active', active);
      tab.setAttribute('aria-selected', active ? 'true' : 'false');
      tab.tabIndex = active ? 0 : -1;
    });
    replaceUrl('/tasks', { filter: next === 'all' ? null : next, q: query || null });
    load(true);
  }
  tabs.forEach(tab => tab.addEventListener('click', () => selectFilter(tab.dataset.filter)));
  bindTabKeys(tabs, tab => selectFilter(tab.dataset.filter));

  const search = $('[data-search]', section);
  let debounce = null;
  search.addEventListener('input', () => {
    clearTimeout(debounce);
    debounce = setTimeout(() => {
      query = search.value.trim();
      replaceUrl('/tasks', { filter: filter === 'all' ? null : filter, q: query || null });
      load(true);
    }, 300);
  });

  $('[data-refresh]', section).addEventListener('click', () => load(true));
  $('[data-create]', section).addEventListener('click', () => openCreateTask());

  function render(){
    if (!items.length){
      listBox.innerHTML = emptyBlock(
        query ? '没有匹配的任务' : '还没有任务',
        query ? '换一个关键词或清空筛选。' : '用一句话描述目标，平台会规划步骤并调用工具。',
        '<button class="btn primary" data-create-empty>新建任务</button>',
      );
      $('[data-create-empty]', listBox)?.addEventListener('click', () => openCreateTask());
      return;
    }
    listBox.innerHTML = `<div class="task-list">${items.map(taskRow).join('')}</div>
      ${nextCursor ? '<div class="load-more"><button class="btn" data-more>加载更多</button></div>' : ''}`;
    $('[data-more]', listBox)?.addEventListener('click', () => load(false));
  }

  function renderCounts(counts){
    for (const key of Object.keys(counts || {})){
      const target = $(`[data-count="${key}"]`, section);
      if (target) target.textContent = counts[key] ? String(counts[key]) : '';
    }
  }

  async function load(reset){
    if (loading && !reset) return;
    const seq = ++sequence;
    const requestKey = `${filter}|${query}`;
    if (reset){
      cursor = null;
      items = [];
      listBox.innerHTML = skeletonRows(3);
    }
    loading = true;
    const params = new URLSearchParams({ limit: '20' });
    const statuses = statusForFilter(filter);
    if (statuses) params.set('status', statuses);
    if (query) params.set('q', query);
    if (!reset && cursor) params.set('cursor', cursor);
    try {
      const data = await api.get(`/tasks?${params.toString()}`, { signal });
      if (seq !== sequence || signal.aborted) return;
      const page = data.tasks || [];
      items = reset ? page : items.concat(page);
      cursor = data.next_cursor || null;
      nextCursor = data.next_cursor || null;
      renderCounts(data.counts);
      render();
      // 保留查询键，避免慢请求覆盖新筛选。
      if (requestKey !== `${filter}|${query}`) load(true);
    } catch (error){
      if (signal.aborted || error.name === 'AbortError') return;
      if (seq !== sequence) return;
      listBox.innerHTML = errorBlock(error);
      bindRetry(listBox, () => load(true));
    } finally {
      if (seq === sequence) loading = false;
    }
  }

  function scheduleRefresh(){
    clearInterval(timer);
    timer = setInterval(() => {
      if (document.visibilityState === 'visible') load(true);
    }, 5000);
  }

  const cleanup = () => { clearInterval(timer); clearTimeout(debounce); };
  signal.addEventListener('abort', cleanup, { once: true });

  await load(true);
  scheduleRefresh();
}

export async function openCreateTask(){
  const { el, close } = openDialog(`
    <div class="dialog-header">
      <h3 class="dialog-title" id="create-task-title">新建任务</h3>
      <button class="icon-btn" data-dialog-close aria-label="关闭">✕</button>
    </div>
    <form class="dialog-body task-create-form" data-create-form aria-labelledby="create-task-title">
      <label class="field">
        <span class="field-label">目标 <em>必填</em></span>
        <textarea class="textarea" name="goal" rows="4" maxlength="8000" required placeholder="例如：整理本季度客户反馈，生成一份带引用的分析报告"></textarea>
        <span class="field-hint">描述期望结果、范围与约束。最多 8000 字符。</span>
      </label>
      <div class="form-grid">
        <label class="field"><span class="field-label">标题</span><input class="input" name="title" maxlength="200" placeholder="留空则从目标截取"></label>
        <label class="field"><span class="field-label">优先级</span><input class="input" name="priority" type="number" min="0" max="1000" value="100"><span class="field-hint">数字越小越先执行。</span></label>
      </div>
      <div class="form-grid">
        <label class="field"><span class="field-label">审批模式</span>
          <select class="select" name="approval_mode">
            <option value="risk_based">按风险审批（推荐）</option>
            <option value="always">每次工具调用都审批</option>
            <option value="never">不审批（高风险仍会拦截）</option>
          </select>
        </label>
        <label class="field"><span class="field-label">知识范围</span>
          <select class="select" name="kb_mode">
            <option value="visible">全部可见知识库</option>
            <option value="explicit">指定知识库</option>
            <option value="none">不使用知识库</option>
          </select>
        </label>
      </div>
      <div class="field" data-kb-wrap hidden>
        <span class="field-label">指定知识库</span>
        <select class="select" name="kb_ids" multiple size="4" data-kb-select></select>
        <span class="field-hint">按住 ⌘/Ctrl 多选。</span>
      </div>
      <label class="field"><span class="field-label">Skill</span>
        <select class="select" name="skill"><option value="">不使用</option></select>
      </label>
      <div class="field">
        <span class="field-label">工具</span>
        <div class="tool-picker" data-tool-picker>加载中…</div>
        <span class="field-hint">不选择时使用平台默认读工具。</span>
      </div>
      <details class="details">
        <summary>预算与高级设置</summary>
        <div class="budget-presets" data-presets>
          <button type="button" class="btn small" data-preset="light">轻量</button>
          <button type="button" class="btn small" data-preset="standard">标准</button>
          <button type="button" class="btn small" data-preset="deep">深度</button>
        </div>
        <div class="form-grid" data-budget-fields>
          <label class="field"><span class="field-label">最大步骤</span><input class="input" type="number" min="1" name="max_steps" placeholder="40"></label>
          <label class="field"><span class="field-label">最大模型调用</span><input class="input" type="number" min="1" name="max_model_calls" placeholder="40"></label>
          <label class="field"><span class="field-label">最大工具调用</span><input class="input" type="number" min="1" name="max_tool_calls" placeholder="25"></label>
          <label class="field"><span class="field-label">最大 Token</span><input class="input" type="number" min="1" name="max_tokens" placeholder="200000"></label>
          <label class="field"><span class="field-label">最长时长（分钟）</span><input class="input" type="number" min="1" name="max_wall_minutes" placeholder="30"></label>
        </div>
      </details>
      <label class="field">
        <span class="field-label">附件</span>
        <input class="input" type="file" name="attachments" multiple data-attachments>
        <span class="field-hint">创建后逐个上传；单个文件与数量受平台限额约束。</span>
      </label>
      <p class="form-error" data-form-error role="alert" hidden></p>
      <div class="dialog-footer">
        <button type="button" class="btn" data-dialog-close>取消</button>
        <button type="submit" class="btn primary" data-submit>创建任务</button>
      </div>
    </form>
  `, { lg: true, labelledBy: 'create-task-title' });

  const form = $('[data-create-form]', el);
  const errorBox = $('[data-form-error]', el);
  const submit = $('[data-submit]', el);
  const kbMode = form.elements.kb_mode;
  const kbWrap = $('[data-kb-wrap]', el);
  const idempotencyKey = crypto.randomUUID();
  let cooldownTimer = null;
  let coolingDown = false;

  kbMode.addEventListener('change', () => { kbWrap.hidden = kbMode.value !== 'explicit'; });

  const [kbs, tools, skills] = await Promise.all([
    api.get('/kbs').catch(() => ({ kbs: [] })),
    api.get('/tools/registry').catch(() => ({ tools: [] })),
    api.get('/skills').catch(() => ({ skills: [] })),
  ]);
  const kbSelect = $('[data-kb-select]', el);
  kbSelect.innerHTML = (kbs.kbs || []).map(kb => `<option value="${esc(kb.id)}">${esc(kb.name)}</option>`).join('');
  const skillSelect = form.elements.skill;
  skillSelect.innerHTML = '<option value="">不使用</option>' + (skills.skills || [])
    .filter(skill => skill.selectable)
    .map(skill => `<option value="${esc(skill.name)}">${esc(skill.name)} · ${esc(skill.version)}</option>`).join('');

  const picker = $('[data-tool-picker]', el);
  const groups = ['builtin', 'custom', 'mcp'];
  const grouped = groups.map(source => ({
    source,
    items: (tools.tools || []).filter(tool => tool.source === source && tool.enabled !== false),
  })).filter(group => group.items.length);
  picker.innerHTML = grouped.length ? grouped.map(group => `
    <div class="tool-group">
      <div class="tool-group-title">${group.source === 'builtin' ? '内置' : group.source === 'custom' ? '自定义' : 'MCP'}</div>
      ${group.items.map(tool => `<label class="check-row">
        <input type="checkbox" name="tools" value="${esc(tool.name)}" ${['knowledge.search', 'knowledge.get_document', 'knowledge.get_citation', 'knowledge.list_bases'].includes(tool.name) ? 'checked' : ''}>
        <span><strong>${esc(tool.name)}</strong><span class="muted"> ${esc(tool.description || '')}</span></span>
        <span class="tag">${esc(tool.side_effect || 'read')}</span>
      </label>`).join('')}
    </div>`).join('') : '<span class="muted">没有可用工具</span>';

  function applyPreset(key){
    const preset = BUDGET_PRESETS[key];
    if (!preset) return;
    form.elements.max_steps.value = preset.max_steps;
    form.elements.max_model_calls.value = preset.max_model_calls;
    form.elements.max_tool_calls.value = preset.max_tool_calls;
    form.elements.max_tokens.value = preset.max_tokens;
    form.elements.max_wall_minutes.value = String(Math.round(preset.max_wall_ms / 60000));
  }
  $$('[data-preset]', el).forEach(button => button.addEventListener('click', () => applyPreset(button.dataset.preset)));

  function setError(message){
    errorBox.textContent = message;
    errorBox.hidden = !message;
  }

  form.addEventListener('submit', async event => {
    event.preventDefault();
    setError('');
    const goal = String(form.elements.goal.value || '').trim();
    if (!goal) return setError('请填写任务目标');
    const budget = {};
    for (const key of ['max_steps', 'max_model_calls', 'max_tool_calls', 'max_tokens']){
      const value = Number(form.elements[key].value);
      if (Number.isFinite(value) && value > 0) budget[key] = value;
    }
    const wallMinutes = Number(form.elements.max_wall_minutes.value);
    if (Number.isFinite(wallMinutes) && wallMinutes > 0) budget.max_wall_ms = wallMinutes * 60000;
    const body = {
      goal,
      title: String(form.elements.title.value || '').trim(),
      priority: Number(form.elements.priority.value || 100),
      approval_mode: form.elements.approval_mode.value,
      kb_scope: { mode: kbMode.value, version_policy: 'pin_on_first_use' },
      tools: $$('input[name="tools"]:checked', el).map(input => input.value),
    };
    if (kbMode.value === 'explicit'){
      body.kb_scope.kb_ids = Array.from(kbSelect.selectedOptions).map(option => option.value);
    }
    if (form.elements.skill.value) body.skill = { ref: form.elements.skill.value };
    if (Object.keys(budget).length) body.budget = budget;

    submit.disabled = true;
    submit.textContent = '创建中…';
    try {
      const data = await api.post('/tasks', body, { headers: { 'Idempotency-Key': idempotencyKey } });
      const taskId = data.task.id;
      const files = Array.from(form.elements.attachments.files || []);
      let failed = 0;
      for (let i = 0; i < files.length; i += 1){
        submit.textContent = `上传附件 ${i + 1}/${files.length}`;
        const formData = new FormData();
        formData.append('file', files[i]);
        try { await api.upload(`/tasks/${taskId}/attachments`, formData); }
        catch { failed += 1; }
      }
      close();
      toast(failed ? `任务已创建，${failed} 个附件上传失败` : '任务已创建', !failed);
      navigate(`/tasks/${taskId}`);
    } catch (error){
      if (error instanceof ApiError && error.code === 'rate_limited'){
        const retry = Number(error.retryAfter || error.details?.retry_after_seconds || 5);
        setError(`创建过快，请 ${retry} 秒后重试`);
        submit.disabled = true;
        coolingDown = true;
        submit.textContent = `等待 ${retry}s`;
        clearTimeout(cooldownTimer);
        cooldownTimer = setTimeout(() => {
          coolingDown = false;
          submit.disabled = false;
          submit.textContent = '创建任务';
        }, retry * 1000);
        return;
      }
      setError(describeApiError(error));
    } finally {
      if (!coolingDown) {
        submit.disabled = false;
        submit.textContent = '创建任务';
      }
    }
  });
}
