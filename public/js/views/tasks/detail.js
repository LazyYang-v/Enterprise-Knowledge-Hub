// 任务详情：标签页、预算、审批、事件流、消息与产物。
import { $, $$, esc } from '../../core/dom.js';
import { api, downloadUrl, apiErrorMessage } from '../../core/api.js';
import { describeApiError } from '../../core/api-error.js';
import {
  statusMeta, budgetMeters, eventLabel, eventTone, TERMINAL_STATUSES,
} from '../../core/task-model.js';
import { fmtTime, relTime, fmtDuration, fmtSize, fmtPercent, prettyJson, renderTextMarkdown, countdown, shortId } from '../../core/format.js';
import {
  toast, confirmDialog, openDialog, errorBlock, emptyBlock, skeletonRows, statusBadge,
  platformDisabledBlock, bindRetry, bindTabKeys,
} from '../../core/ui.js';
import { replaceUrl } from '../../core/navigation.js';
import { store } from '../../core/store.js';
import { SSEClient } from '../../core/sse.js';

const TABS = [
  ['overview', '概览'], ['chat', '对话'], ['events', '事件'], ['plan', '计划'],
  ['tools', '工具'], ['evidence', '证据'], ['artifacts', '产物'],
];

function renderApproval(pending){
  if (!pending) return '';
  const approval = pending.approval;
  const input = pending.input;
  let html = '';
  if (approval){
    html += `<section class="alert warning" data-approval>
      <div class="alert-main">
        <strong>需要审批：${esc(approval.kind || '工具调用')}</strong>
        <p>风险 ${esc(approval.risk_level || 'low')} · ${esc(countdown(approval.expires_at))}</p>
        <details><summary>查看参数</summary><pre class="code-block">${esc(prettyJson(approval.arguments || approval.request))}</pre></details>
      </div>
      <div class="alert-actions">
        <button class="btn primary small" data-approve>批准</button>
        <button class="btn danger small" data-deny>拒绝</button>
      </div>
    </section>`;
  }
  if (input){
    html += `<section class="alert warning" data-input>
      <div class="alert-main"><strong>需要补充输入</strong><p>${esc(input.question || '')}</p></div>
      <button class="btn primary small" data-answer-input>填写</button>
    </section>`;
  }
  return html;
}

function renderOverview(snapshot){
  const meta = statusMeta(snapshot.status);
  const meters = budgetMeters(snapshot);
  return `<div class="stack">
    ${renderApproval(snapshot.pending)}
    <section class="task-card">
      <h3>目标</h3>
      <p class="task-goal">${esc(snapshot.goal || '')}</p>
      ${snapshot.result_summary ? `<div class="result-summary"><strong>结果摘要</strong><p>${esc(snapshot.result_summary)}</p></div>` : ''}
      ${snapshot.last_error ? `<div class="alert danger"><div><strong>最近错误</strong><p>${esc(snapshot.last_error.code)}：${esc(snapshot.last_error.detail || '')}</p></div></div>` : ''}
    </section>
    <section class="task-card">
      <h3>预算</h3>
      <div class="budget-grid">
        ${meters.map(meter => `<div class="budget-item">
          <div class="budget-head"><span>${esc(meter.label)}</span><span class="muted">${meter.duration ? fmtDuration(meter.used) + ' / ' + fmtDuration(meter.limit) : `${meter.used} / ${meter.limit}`}</span></div>
          <div class="progress ${meter.tone}" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${meter.pct}" aria-label="${esc(meter.label)}预算">
            <span class="progress-fill" style="width:${meter.pct}%"></span>
          </div>
          <div class="budget-pct">${fmtPercent(meter.pct)}</div>
        </div>`).join('')}
      </div>
    </section>
    <section class="task-card">
      <h3>执行信息</h3>
      <dl class="kv">
        <div><dt>状态</dt><dd>${statusBadge(meta.label, meta.tone)}</dd></div>
        <div><dt>当前步骤</dt><dd>${snapshot.current_step ? esc(`${snapshot.current_step.kind} #${snapshot.current_step.seq} · ${snapshot.current_step.status}`) : '—'}</dd></div>
        <div><dt>知识范围</dt><dd>${esc(snapshot.knowledge?.mode || '未设置')} · ${Number(snapshot.knowledge?.kb_ids?.length || 0)} 个知识库</dd></div>
        <div><dt>Skill</dt><dd>${snapshot.skill ? esc(`${snapshot.skill.name}@${snapshot.skill.version}`) : '—'}</dd></div>
        <div><dt>证据 / 产物</dt><dd>${Number(snapshot.evidence_count || 0)} / ${Number(snapshot.artifacts?.length || 0)}</dd></div>
        <div><dt>恢复 / 重试</dt><dd>${Number(snapshot.recovery_count || 0)} / ${Number(snapshot.resume_count || 0)}</dd></div>
        <div><dt>创建</dt><dd>${esc(fmtTime(snapshot.created_at))}</dd></div>
        <div><dt>更新</dt><dd>${esc(relTime(snapshot.updated_at))}</dd></div>
      </dl>
    </section>
  </div>`;
}

function renderMessages(messages){
  if (!messages.length) return emptyBlock('还没有消息', '任务开始后，模型与工具消息会出现在这里。');
  return `<div class="message-list">${messages.map(message => {
    const role = message.role || 'assistant';
    const label = role === 'user' ? '你' : role === 'tool' ? '工具' : role === 'assistant' ? '模型' : role;
    const body = role === 'tool'
      ? `<pre class="code-block">${esc(message.content || '')}</pre>`
      : `<div class="message-text">${renderTextMarkdown(message.content || '')}</div>`;
    return `<article class="message ${esc(role)}">
      <header><span class="message-role">${esc(label)}</span><time>${esc(relTime(message.created_at))}</time></header>
      ${body}
    </article>`;
  }).join('')}</div>`;
}

function renderEvents(events, filter = 'all'){
  const visible = filter === 'all' ? events : events.filter(event => event.type === filter);
  if (!visible.length) return emptyBlock('暂无事件', '任务执行时会产生可审计的事件流。');
  return `<div class="timeline">${visible.map(event => `<details class="timeline-item ${eventTone(event.type)}">
    <summary>
      <span class="timeline-dot" aria-hidden="true"></span>
      <span class="timeline-label">${esc(eventLabel(event.type))}</span>
      <span class="muted mono">#${event.seq}</span>
      <time>${esc(fmtTime(event.ts || event.created_at))}</time>
    </summary>
    <pre class="code-block">${esc(prettyJson(event.payload))}</pre>
  </details>`).join('')}</div>`;
}

function renderPlan(plan){
  if (!plan?.length) return emptyBlock('暂无计划', '模型尚未提交计划。');
  return `<ol class="plan-list">${plan.map(item => `<li class="plan-item ${esc(item.status || '')}">
    <span class="plan-dot" aria-hidden="true"></span>
    <div><strong>${esc(item.title)}</strong>${item.description ? `<p class="muted">${esc(item.description)}</p>` : ''}</div>
    <span class="tag">${esc(item.status || 'pending')}</span>
  </li>`).join('')}</ol>`;
}

function renderTools(tools){
  if (!tools?.length) return emptyBlock('没有工具快照', '任务创建时会固定工具描述与版本。');
  return `<div class="tool-list">${tools.map(tool => `<article class="tool-card">
    <div class="row"><strong>${esc(tool.name)}</strong><span class="tag">${esc(tool.version || '')}</span></div>
    <p class="muted">${esc(tool.description || '')}</p>
    <div class="tool-meta"><span>${esc(tool.source || 'builtin')}</span><span>副作用：${esc(tool.side_effect || 'read')}</span><span>审批：${esc(tool.approval_policy || '')}</span></div>
  </article>`).join('')}</div>`;
}

function renderEvidence(rows){
  if (!rows?.length) return emptyBlock('暂无证据', '知识检索命中的片段会在这里留痕。');
  return `<div class="evidence-list">${rows.map(row => `<article class="evidence-card">
    <div class="row"><strong>${esc(row.document_id || row.chunk_id || '文档片段')}</strong><span class="tag">${row.score == null ? '—' : Number(row.score).toFixed(3)}</span></div>
    <p class="muted">知识库 ${esc(row.kb_id || '—')} · 版本 ${esc(row.document_version ?? '—')}</p>
    <blockquote>${esc(row.excerpt || '')}</blockquote>
  </article>`).join('')}</div>`;
}

function renderArtifacts(rows, canUpload){
  return `<div class="stack">
    <div class="toolbar">
      <span class="muted">${rows.length} 个产物</span>
      <div class="toolbar-group">
        ${canUpload ? '<button class="btn small" data-upload-artifact>上传附件</button>' : ''}
      </div>
    </div>
    ${rows.length ? `<div class="artifact-list">${rows.map(row => `<div class="artifact-row">
      <div class="artifact-main"><strong>${esc(row.name)}</strong><span class="muted">${esc(row.kind)} · v${row.version} · ${fmtSize(row.size_bytes)}</span></div>
      <div class="row-actions">
        <button class="btn small" data-download-artifact="${esc(row.id)}" data-name="${esc(row.name)}">下载</button>
        <button class="btn small danger" data-delete-artifact="${esc(row.id)}" data-name="${esc(row.name)}">删除</button>
      </div>
    </div>`).join('')}</div>` : emptyBlock('暂无产物', '任务生成的报告、表格与中间文件会出现在这里。')}
    <input type="file" hidden data-artifact-file>
  </div>`;
}

export async function mountTaskDetail(ctx, signal){
  const section = $('#view-task-detail');
  if (!store.platformEnabled){
    section.innerHTML = `<div class="page">${platformDisabledBlock()}</div>`;
    return;
  }
  const taskId = ctx.params.id;
  if (!taskId){
    section.innerHTML = errorBlock(new Error('缺少任务 ID'));
    return;
  }
  const initialTab = TABS.some(([key]) => key === ctx.params.tab) ? ctx.params.tab : 'overview';
  let tab = initialTab;
  let snapshot = null;
  let messages = null;
  let events = null;
  let evidence = null;
  let artifacts = null;
  let eventFilter = 'all';
  let sse = null;
  let refreshTimer = null;
  let closed = false;

  section.innerHTML = `<div class="page task-detail-page">
    <header class="task-detail-head">
      <a class="back-btn" href="#/tasks" aria-label="返回任务列表">←</a>
      <div class="task-detail-title">
        <div class="row1"><h2 tabindex="-1" data-title>任务</h2><span data-status></span></div>
        <div class="meta" data-meta></div>
      </div>
      <div class="header-actions" data-actions></div>
    </header>
    <div class="task-detail-scroll">
      <div class="task-tabs-row">
        <div class="tabs" role="tablist" aria-label="任务详情">
          ${TABS.map(([key, label]) => `<button class="tab${key === tab ? ' active' : ''}" role="tab" data-tab="${key}" aria-selected="${key === tab}" tabindex="${key === tab ? 0 : -1}">${label}</button>`).join('')}
        </div>
        <span class="live-pill" data-live><span class="live-dot"></span><span data-live-text>连接中</span></span>
      </div>
      <div class="task-panel" data-panel>${skeletonRows(3)}</div>
    </div>
    <div class="dialog-scrim" data-input-overlay hidden></div>
  </div>`;

  const panel = $('[data-panel]', section);
  const actions = $('[data-actions]', section);
  const tabs = $$('[data-tab]', section);

  function setTab(next){
    tab = next;
    tabs.forEach(tabEl => {
      const active = tabEl.dataset.tab === next;
      tabEl.classList.toggle('active', active);
      tabEl.setAttribute('aria-selected', active ? 'true' : 'false');
      tabEl.tabIndex = active ? 0 : -1;
    });
    replaceUrl(`/tasks/${taskId}`, { tab: next === 'overview' ? null : next });
    renderPanel();
  }
  tabs.forEach(tabEl => tabEl.addEventListener('click', () => setTab(tabEl.dataset.tab)));
  bindTabKeys(tabs, tabEl => setTab(tabEl.dataset.tab));

  function renderHeader(){
    if (!snapshot) return;
    const meta = statusMeta(snapshot.status);
    $('[data-title]', section).textContent = snapshot.title || '任务';
    $('[data-status]', section).innerHTML = statusBadge(meta.label, meta.tone);
    $('[data-meta]', section).innerHTML = `<span class="mono">#${esc(shortId(taskId, 8))}</span>
      <span>优先级 ${Number(snapshot.priority ?? 100)}</span>
      <span>更新 ${esc(relTime(snapshot.updated_at))}</span>
      ${snapshot.current_step ? `<span>步骤 ${esc(snapshot.current_step.seq)} · ${esc(snapshot.current_step.kind)}</span>` : ''}`;
    const buttons = [];
    if (snapshot.permissions?.can_cancel) buttons.push('<button class="btn" data-cancel>取消任务</button>');
    if (snapshot.permissions?.can_resume) buttons.push('<button class="btn primary" data-resume>恢复任务</button>');
    buttons.push('<button class="btn" data-copy>复制链接</button>');
    buttons.push('<button class="btn" data-refresh>刷新</button>');
    actions.innerHTML = buttons.join('');
    $('[data-cancel]', actions)?.addEventListener('click', cancelTask);
    $('[data-resume]', actions)?.addEventListener('click', resumeTask);
    $('[data-copy]', actions)?.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(location.href); toast('链接已复制'); }
      catch { toast('复制失败', false); }
    });
    $('[data-refresh]', actions)?.addEventListener('click', () => refreshAll(true));
  }

  function renderPanel(){
    if (!snapshot){
      panel.innerHTML = skeletonRows(3);
      return;
    }
    if (tab === 'overview') panel.innerHTML = renderOverview(snapshot);
    else if (tab === 'chat'){
      panel.innerHTML = `<div class="stack">
        <div data-messages>${messages ? renderMessages(messages) : skeletonRows(2)}</div>
        <form class="composer" data-composer>
          <textarea class="textarea" name="content" rows="2" maxlength="8000" placeholder="补充指令，任务运行中也可以发送…"></textarea>
          <button class="btn primary" type="submit">发送</button>
        </form>
      </div>`;
      bindChat();
      if (!messages) loadMessages();
    } else if (tab === 'events'){
      const types = ['all', ...new Set((events || []).map(event => event.type))];
      panel.innerHTML = `<div class="stack">
        <div class="toolbar"><select class="select" data-event-filter aria-label="事件类型">${types.map(type => `<option value="${esc(type)}"${type === eventFilter ? ' selected' : ''}>${type === 'all' ? '全部事件' : esc(eventLabel(type))}</option>`).join('')}</select></div>
        <div data-events>${events ? renderEvents(events, eventFilter) : skeletonRows(3)}</div>
      </div>`;
      $('[data-event-filter]', panel)?.addEventListener('change', event => {
        eventFilter = event.target.value;
        $('[data-events]', panel).innerHTML = renderEvents(events || [], eventFilter);
      });
      if (!events) loadEvents();
    } else if (tab === 'plan') panel.innerHTML = renderPlan(snapshot.plan);
    else if (tab === 'tools') panel.innerHTML = renderTools(snapshot.tools);
    else if (tab === 'evidence'){
      panel.innerHTML = evidence ? renderEvidence(evidence) : skeletonRows(2);
      if (!evidence) loadEvidence();
    } else if (tab === 'artifacts'){
      panel.innerHTML = renderArtifacts(artifacts || snapshot.artifacts || [], snapshot.permissions?.can_upload_attachment);
      bindArtifacts();
      if (!artifacts) loadArtifacts();
    }
    bindApproval();
  }

  async function loadMessages(){
    try {
      const data = await api.get(`/tasks/${taskId}/messages?limit=200`, { signal });
      if (signal.aborted) return;
      messages = data.messages || [];
      if (tab === 'chat') panel.innerHTML = `<div class="stack"><div data-messages>${renderMessages(messages)}</div>${composerHtml()}</div>`, bindChat();
    } catch (error){
      if (!signal.aborted && tab === 'chat') panel.innerHTML = errorBlock(error);
    }
  }

  function composerHtml(){
    return `<form class="composer" data-composer>
      <textarea class="textarea" name="content" rows="2" maxlength="8000" placeholder="补充指令，任务运行中也可以发送…"></textarea>
      <button class="btn primary" type="submit">发送</button>
    </form>`;
  }

  function bindChat(){
    const form = $('[data-composer]', panel);
    if (!form) return;
    form.addEventListener('submit', async event => {
      event.preventDefault();
      const content = String(form.elements.content.value || '').trim();
      if (!content) return;
      const button = $('button[type="submit"]', form);
      button.disabled = true;
      try {
        await api.post(`/tasks/${taskId}/messages`, { content });
        form.elements.content.value = '';
        messages = null;
        await loadMessages();
      } catch (error){ toast(apiErrorMessage(error), false); }
      finally { button.disabled = false; }
    });
  }

  async function loadEvents(){
    try {
      const data = await api.get(`/tasks/${taskId}/events/history?after=0&limit=500`, { signal });
      if (signal.aborted) return;
      events = data.events || [];
      if (tab === 'events') renderPanel();
    } catch (error){ if (!signal.aborted && tab === 'events') panel.innerHTML = errorBlock(error); }
  }

  async function loadEvidence(){
    try {
      const data = await api.get(`/tasks/${taskId}/evidence`, { signal });
      if (signal.aborted) return;
      evidence = data.evidence || [];
      if (tab === 'evidence') panel.innerHTML = renderEvidence(evidence);
    } catch (error){ if (!signal.aborted && tab === 'evidence') panel.innerHTML = errorBlock(error); }
  }

  async function loadArtifacts(){
    try {
      const data = await api.get(`/tasks/${taskId}/artifacts?limit=200`, { signal });
      if (signal.aborted) return;
      artifacts = data.artifacts || [];
      if (tab === 'artifacts'){
        panel.innerHTML = renderArtifacts(artifacts, snapshot?.permissions?.can_upload_attachment);
        bindArtifacts();
      }
    } catch (error){ if (!signal.aborted && tab === 'artifacts') panel.innerHTML = errorBlock(error); }
  }

  function bindArtifacts(){
    $('[data-upload-artifact]', panel)?.addEventListener('click', () => $('[data-artifact-file]', panel)?.click());
    const fileInput = $('[data-artifact-file]', panel);
    fileInput?.addEventListener('change', async () => {
      const file = fileInput.files?.[0];
      if (!file) return;
      const formData = new FormData();
      formData.append('file', file);
      try {
        await api.upload(`/tasks/${taskId}/attachments`, formData);
        toast('附件已上传');
        await Promise.all([loadArtifacts(), refreshSnapshot()]);
      } catch (error){ toast(apiErrorMessage(error), false); }
    });
    $$('[data-download-artifact]', panel).forEach(button => button.addEventListener('click', async () => {
      try { await downloadUrl(`/tasks/${taskId}/artifacts/${button.dataset.downloadArtifact}/download`, button.dataset.name); }
      catch (error){ toast(apiErrorMessage(error), false); }
    }));
    $$('[data-delete-artifact]', panel).forEach(button => button.addEventListener('click', async () => {
      const ok = await confirmDialog({
        title: '删除产物', message: `确定删除「${button.dataset.name}」？`, confirmText: '删除', danger: true,
      });
      if (!ok) return;
      try {
        await api.del(`/tasks/${taskId}/artifacts/${button.dataset.deleteArtifact}`);
        toast('产物已删除');
        await Promise.all([loadArtifacts(), refreshSnapshot()]);
      } catch (error){ toast(apiErrorMessage(error), false); }
    }));
  }

  function bindApproval(){
    const approval = snapshot?.pending?.approval;
    $('[data-approve]', panel)?.addEventListener('click', () => decide('approve', approval));
    $('[data-deny]', panel)?.addEventListener('click', () => decide('deny', approval));
    $('[data-answer-input]', panel)?.addEventListener('click', openInputDialog);
  }

  async function decide(decision, approval){
    if (!approval) return;
    const comment = decision === 'deny' ? String(prompt('拒绝原因（可选）') || '') : '';
    try {
      await api.post(`/approvals/${approval.id}/decision`, {
        decision, args_hash: approval.args_hash, comment,
      });
      toast(decision === 'approve' ? '已批准' : '已拒绝');
      await refreshSnapshot();
    } catch (error){
      toast(describeApiError(error), false);
      await refreshSnapshot();
    }
  }

  function openInputDialog(){
    const request = snapshot?.pending?.input;
    if (!request) return;
    const properties = request.input_schema?.properties || {};
    const fields = Object.entries(properties).map(([key, field]) => {
      if (field.type === 'boolean') return `<label class="check-row"><input type="checkbox" name="${esc(key)}" ${field.required ? 'required' : ''}><span>${esc(field.title || key)}</span></label>`;
      return `<label class="field"><span class="field-label">${esc(field.title || key)}${field.required ? ' *' : ''}</span>
        <input class="input" name="${esc(key)}" type="${field.type === 'number' || field.type === 'integer' ? 'number' : 'text'}"></label>`;
    }).join('');
    const { el, close } = openDialog(`<div class="dialog-header"><h3 class="dialog-title">补充输入</h3><button class="icon-btn" data-dialog-close>✕</button></div>
      <form class="dialog-body" data-input-form><p>${esc(request.question || '')}</p>${fields}
      <div class="dialog-footer"><button type="button" class="btn" data-dialog-close>取消</button><button class="btn primary" type="submit">提交</button></div></form>`);
    $('[data-input-form]', el).addEventListener('submit', async event => {
      event.preventDefault();
      const values = {};
      for (const [key, field] of Object.entries(properties)){
        const input = event.target.elements[key];
        if (!input) continue;
        if (field.type === 'boolean') values[key] = input.checked;
        else if (field.type === 'number' || field.type === 'integer') values[key] = Number(input.value);
        else if (field.type === 'string[]') values[key] = input.value.split(',').map(item => item.trim()).filter(Boolean);
        else if (input.value !== '') values[key] = input.value;
      }
      try {
        await api.post(`/tasks/${taskId}/input`, { request_id: request.id, values });
        close();
        toast('输入已提交');
        await refreshSnapshot();
      } catch (error){ toast(apiErrorMessage(error), false); }
    });
  }

  async function refreshSnapshot(){
    try {
      const data = await api.get(`/tasks/${taskId}`, { signal });
      if (signal.aborted) return null;
      snapshot = data.task;
      renderHeader();
      if (tab === 'overview' || tab === 'plan' || tab === 'tools') renderPanel();
      return snapshot;
    } catch (error){
      if (!signal.aborted && !snapshot){
        section.innerHTML = `<div class="page">${errorBlock(error)}</div>`;
        bindRetry(section, () => refreshAll(true));
      }
      return null;
    }
  }

  async function refreshAll(manual = false){
    await refreshSnapshot();
    if (tab === 'chat') await loadMessages();
    if (tab === 'events') await loadEvents();
    if (tab === 'evidence') await loadEvidence();
    if (tab === 'artifacts') await loadArtifacts();
    if (manual) toast('已刷新');
  }

  function scheduleRefresh(){
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(async () => {
      if (closed) return;
      await refreshSnapshot();
    }, 250);
  }

  function startStream(){
    if (!snapshot || TERMINAL_STATUSES.has(snapshot.status)) return;
    sse?.close();
    const live = $('[data-live]', section);
    const liveText = $('[data-live-text]', section);
    sse = new SSEClient({
      url: `/api/tasks/${taskId}/events`,
      lastEventId: snapshot.last_event_seq || null,
      onState(state){
        live.classList.toggle('live', state === 'live');
        live.classList.toggle('error', state === 'error');
        liveText.textContent = state === 'live' ? '实时' : state === 'reconnecting' ? '重连中' : state === 'ended' ? '已结束' : state === 'error' ? '离线' : '连接中';
      },
      onEvent(event){
        if (event.data?.seq && event.data.seq <= (snapshot?.last_event_seq || 0)) return;
        const type = event.data?.type || event.event;
        if (type === 'message.created' || type === 'instruction.received'){
          messages = null;
          if (tab === 'chat') loadMessages();
        }
        if (type === 'artifact.created' || type === 'artifact.attached' || type === 'artifact.deleted'){
          artifacts = null;
          if (tab === 'artifacts') loadArtifacts();
        }
        if (type === 'evidence.retrieved'){
          evidence = null;
          if (tab === 'evidence') loadEvidence();
        }
        if (tab === 'events') loadEvents();
        scheduleRefresh();
      },
      onGap(){
        toast('事件流存在缺口，已重新同步', false);
        events = null;
        if (tab === 'events') loadEvents();
        refreshSnapshot();
      },
      onEnd(){
        refreshSnapshot();
      },
      onError(){
        // 状态由 onState 反馈；重连交给 SSEClient。
      },
    });
    sse.start();
  }

  async function cancelTask(){
    const ok = await confirmDialog({ title: '取消任务', message: '确定取消该任务？正在执行的工具会被中止。', confirmText: '取消任务', danger: true });
    if (!ok) return;
    try {
      await api.post(`/tasks/${taskId}/cancel`, { reason: 'user_cancelled' });
      toast('已请求取消');
      await refreshSnapshot();
    } catch (error){ toast(apiErrorMessage(error), false); }
  }

  async function resumeTask(){
    try {
      await api.post(`/tasks/${taskId}/resume`, { reason: 'manual_resume' });
      toast('任务已恢复');
      await refreshSnapshot();
      startStream();
    } catch (error){ toast(apiErrorMessage(error), false); }
  }

  signal.addEventListener('abort', () => {
    closed = true;
    clearTimeout(refreshTimer);
    sse?.close();
  }, { once: true });

  await refreshSnapshot();
  if (!snapshot) return;
  renderPanel();
  startStream();
}
