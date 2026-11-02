// 审批收件箱：按状态筛选、参数预览与就地决策。
import { $, $$, esc } from '../core/dom.js';
import { api } from '../core/api.js';
import { describeApiError } from '../core/api-error.js';
import { fmtTime, relTime, countdown, prettyJson } from '../core/format.js';
import {
  toast, openDialog, errorBlock, emptyBlock, skeletonRows, statusBadge, platformDisabledBlock, bindRetry, bindTabKeys,
} from '../core/ui.js';
import { canDecideApproval } from '../core/permissions.js';
import { store } from '../core/store.js';

const STATUSES = [
  ['pending', '待审批'], ['approved', '已通过'], ['denied', '已拒绝'], ['expired', '已过期'], ['cancelled', '已取消'],
];

function riskTone(risk){
  return risk === 'high' ? 'danger' : risk === 'medium' ? 'warning' : 'neutral';
}

function approvalCard(item){
  const canDecide = canDecideApproval(item);
  return `<article class="approval-card" data-approval-card="${esc(item.id)}">
    <div class="approval-main">
      <div class="row">
        <strong>${esc(item.tool_name || item.kind || '工具调用')}</strong>
        ${statusBadge(`风险 ${item.risk_level || 'low'}`, riskTone(item.risk_level))}
        ${statusBadge(item.status, item.status === 'pending' ? 'warning' : item.status === 'approved' ? 'success' : 'neutral')}
      </div>
      <p class="muted">任务：<a href="#/tasks/${esc(item.task_id)}">${esc(item.task_title || item.task_id)}</a> · 请求人 ${esc(item.requested_by || '—')}</p>
      <div class="approval-meta">
        <span>请求 ${esc(relTime(item.created_at))}</span>
        <span>${esc(countdown(item.expires_at))}</span>
        <span class="mono">#${esc(String(item.id).slice(0, 8))}</span>
      </div>
      <details><summary>查看参数</summary><pre class="code-block">${esc(prettyJson(item.arguments || item.request))}</pre></details>
    </div>
    <div class="approval-actions">
      ${canDecide ? `<button class="btn primary small" data-approve="${esc(item.id)}">批准</button>
        <button class="btn danger small" data-deny="${esc(item.id)}">拒绝</button>` : '<span class="muted">不可审批</span>'}
    </div>
  </article>`;
}

export async function mountApprovals(ctx, signal){
  const section = $('#view-approvals');
  if (!store.platformEnabled){
    section.innerHTML = `<div class="page">${platformDisabledBlock()}</div>`;
    return;
  }
  let status = STATUSES.some(([key]) => key === ctx.query.status) ? ctx.query.status : 'pending';
  let items = [];
  let loading = false;
  let timer = null;

  section.innerHTML = `<div class="page console-page">
    <header class="page-header">
      <div><h2 tabindex="-1">审批</h2><p class="subtitle">需要你决定的高风险工具调用与人工对账请求。</p></div>
      <div class="header-actions"><button class="btn" data-refresh>刷新</button></div>
    </header>
    <div class="toolbar">
      <div class="tabs" role="tablist" aria-label="审批状态">
        ${STATUSES.map(([key, label]) => `<button class="tab${key === status ? ' active' : ''}" role="tab" data-status="${key}" aria-selected="${key === status}">${label}</button>`).join('')}
      </div>
    </div>
    <div class="content-scroll" data-list>${skeletonRows(3)}</div>
  </div>`;

  const list = $('[data-list]', section);
  const tabs = $$('[data-status]', section);

  function selectStatus(next){
    status = next;
    tabs.forEach(tab => {
      const active = tab.dataset.status === next;
      tab.classList.toggle('active', active);
      tab.setAttribute('aria-selected', active ? 'true' : 'false');
    });
    history.replaceState(null, '', `#/approvals${next === 'pending' ? '' : `?status=${next}`}`);
    load();
  }
  tabs.forEach(tab => tab.addEventListener('click', () => selectStatus(tab.dataset.status)));
  bindTabKeys(tabs, tab => selectStatus(tab.dataset.status));
  $('[data-refresh]', section).addEventListener('click', () => load());

  function render(){
    if (!items.length){
      list.innerHTML = emptyBlock(status === 'pending' ? '没有待审批请求' : '没有记录', status === 'pending' ? '任务遇到高风险工具时会在这里等待你的决定。' : '');
      return;
    }
    list.innerHTML = `<div class="approval-list">${items.map(approvalCard).join('')}</div>`;
    $$('[data-approve]', list).forEach(button => button.addEventListener('click', () => decide(button.dataset.approve, 'approve')));
    $$('[data-deny]', list).forEach(button => button.addEventListener('click', () => decide(button.dataset.deny, 'deny')));
  }

  async function load(){
    if (loading) return;
    loading = true;
    const seq = Date.now();
    try {
      const data = await api.get(`/approvals?status=${encodeURIComponent(status)}&limit=50`, { signal });
      if (signal.aborted) return;
      items = data.approvals || [];
      if (status === 'pending') $('#badge-approvals').textContent = data.count ? String(data.count) : '';
      render();
    } catch (error){
      if (signal.aborted) return;
      list.innerHTML = errorBlock(error);
      bindRetry(list, load);
    } finally {
      loading = false;
      void seq;
    }
  }

  function decide(id, decision){
    const item = items.find(entry => entry.id === id);
    if (!item) return;
    const { el, close } = openDialog(`<div class="dialog-header"><h3 class="dialog-title">${decision === 'approve' ? '批准' : '拒绝'}审批</h3><button class="icon-btn" data-dialog-close>✕</button></div>
      <form class="dialog-body" data-decision-form>
        <p class="muted">工具：${esc(item.tool_name || item.kind)} · 风险 ${esc(item.risk_level || 'low')}</p>
        <label class="field"><span class="field-label">备注（可选）</span><textarea class="textarea" name="comment" rows="3" maxlength="500"></textarea></label>
        <p class="form-error" data-decision-error role="alert" hidden></p>
        <div class="dialog-footer"><button type="button" class="btn" data-dialog-close>取消</button><button class="btn ${decision === 'approve' ? 'primary' : 'danger'}" type="submit">${decision === 'approve' ? '确认批准' : '确认拒绝'}</button></div>
      </form>`);
    $('[data-decision-form]', el).addEventListener('submit', async event => {
      event.preventDefault();
      const errorBox = $('[data-decision-error]', el);
      errorBox.hidden = true;
      try {
        await api.post(`/approvals/${id}/decision`, {
          decision,
          args_hash: item.args_hash,
          comment: String(event.target.elements.comment.value || '').slice(0, 500),
        });
        close();
        toast(decision === 'approve' ? '已批准' : '已拒绝');
        await load();
      } catch (error){
        errorBox.textContent = describeApiError(error);
        errorBox.hidden = false;
        await load();
      }
    });
  }

  signal.addEventListener('abort', () => clearInterval(timer), { once: true });
  await load();
  timer = setInterval(() => {
    if (document.visibilityState === 'visible') load();
  }, 30000);
}
