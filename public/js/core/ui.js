// 通用 UI 原语：toast、对话框、抽屉、状态块、标签页键盘支持。
import { $, $$, esc, trapFocus, announce } from './dom.js';
import { ApiError, describeApiError } from './api-error.js';

let dialogCleanup = null;

export function toast(message, ok = true){
  const box = $('#toasts');
  if (!box) return;
  const el = document.createElement('div');
  el.className = `toast${ok ? '' : ' toast-error'}`;
  el.setAttribute('role', ok ? 'status' : 'alert');
  el.innerHTML = `<span class="toast-dot" aria-hidden="true"></span><span class="toast-text"></span>`;
  el.querySelector('.toast-text').textContent = String(message);
  box.appendChild(el);
  setTimeout(() => {
    el.classList.add('out');
    setTimeout(() => el.remove(), 260);
  }, 3200);
}

export function closeDialog(){
  if (dialogCleanup){ dialogCleanup(); dialogCleanup = null; }
  const overlay = $('#dialog-overlay');
  if (overlay) overlay.classList.remove('show');
  const slot = $('#dialog-slot');
  if (slot) slot.innerHTML = '';
}

export function openDialog(html, { lg = false, onClose = null, labelledBy = null } = {}){
  closeDialog();
  const overlay = $('#dialog-overlay');
  const slot = $('#dialog-slot');
  slot.innerHTML = `<div class="dialog${lg ? ' dialog-lg' : ''}" role="dialog" aria-modal="true"${labelledBy ? ` aria-labelledby="${esc(labelledBy)}"` : ''}>${html}</div>`;
  overlay.classList.add('show');
  const dialog = slot.firstElementChild;
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    closeDialog();
    onClose?.();
  };
  $$('[data-dialog-close]', dialog).forEach(btn => btn.addEventListener('click', close));
  const onOverlay = event => {
    if (event.target === overlay) close();
  };
  overlay.addEventListener('click', onOverlay);
  const restore = trapFocus(dialog, { onEscape: close });
  dialogCleanup = () => {
    overlay.removeEventListener('click', onOverlay);
    restore();
    closed = true;
  };
  return { el: dialog, close };
}

export function confirmDialog({
  title = '确认操作', message = '', confirmText = '确认', cancelText = '取消', danger = false,
} = {}){
  return new Promise(resolve => {
    const { el, close } = openDialog(`
      <div class="dialog-header">
        <h3 class="dialog-title" id="confirm-title">${esc(title)}</h3>
        <button class="icon-btn" data-dialog-close aria-label="关闭">✕</button>
      </div>
      <div class="dialog-body"><p class="dialog-message">${esc(message)}</p></div>
      <div class="dialog-footer">
        <button class="btn" data-dialog-close>${esc(cancelText)}</button>
        <button class="btn ${danger ? 'danger' : 'primary'}" data-confirm>${esc(confirmText)}</button>
      </div>
    `, { labelledBy: 'confirm-title', onClose: () => resolve(false) });
    el.querySelector('[data-confirm]').addEventListener('click', () => {
      resolve(true);
      close();
    });
  });
}

let drawerCleanup = null;

export function closeDrawer(){
  if (drawerCleanup){ drawerCleanup(); drawerCleanup = null; }
  $('#drawer-overlay')?.classList.remove('show');
  const slot = $('#drawer-slot');
  if (slot) slot.innerHTML = '';
}

export function openDrawer({ title = '', body = '', footer = '', wide = false, onClose = null } = {}){
  closeDrawer();
  const overlay = $('#drawer-overlay');
  const slot = $('#drawer-slot');
  slot.innerHTML = `
    <aside class="drawer${wide ? ' drawer-wide' : ''}" role="dialog" aria-modal="true" aria-labelledby="drawer-title">
      <div class="drawer-header">
        <h3 id="drawer-title">${esc(title)}</h3>
        <button class="icon-btn" data-drawer-close aria-label="关闭">✕</button>
      </div>
      <div class="drawer-body">${body}</div>
      ${footer ? `<div class="drawer-footer">${footer}</div>` : ''}
    </aside>`;
  overlay.classList.add('show');
  const drawer = slot.firstElementChild;
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    closeDrawer();
    onClose?.();
  };
  $$('[data-drawer-close]', drawer).forEach(btn => btn.addEventListener('click', close));
  const onOverlay = event => {
    if (event.target === overlay) close();
  };
  overlay.addEventListener('click', onOverlay);
  const restore = trapFocus(drawer, { onEscape: close });
  drawerCleanup = () => {
    overlay.removeEventListener('click', onOverlay);
    restore();
    closed = true;
  };
  return { el: drawer, close };
}

export function skeletonRows(count = 4){
  return Array.from({ length: count }, () => '<div class="skeleton skeleton-row"></div>').join('');
}

export function stateBlock({ title = '', desc = '', tone = '', actions = '' } = {}){
  return `<div class="state ${tone}">
    <div class="state-icon" aria-hidden="true">${tone === 'error' ? '!' : tone === 'disabled' ? '–' : 'i'}</div>
    <h3 class="state-title">${esc(title)}</h3>
    ${desc ? `<p class="state-desc">${esc(desc)}</p>` : ''}
    ${actions ? `<div class="state-actions">${actions}</div>` : ''}
  </div>`;
}

export function errorBlock(error, retryLabel = '重试'){
  const message = error instanceof ApiError ? describeApiError(error) : String(error?.message || error);
  const requestId = error instanceof ApiError && error.requestId ? `<code class="mono">${esc(error.requestId)}</code>` : '';
  return stateBlock({
    title: '加载失败', desc: requestId ? `${message}（请求 ${requestId}）` : message,
    tone: 'error', actions: `<button class="btn" data-retry>${esc(retryLabel)}</button>`,
  });
}

export function emptyBlock(title, desc = '', actions = ''){
  return stateBlock({ title, desc, actions });
}

export function statusBadge(label, tone = 'neutral'){
  return `<span class="status-pill ${esc(tone)}"><span class="dot" aria-hidden="true"></span>${esc(label)}</span>`;
}

export function platformDisabledBlock(){
  return stateBlock({
    title: 'Agent 平台未启用',
    desc: '需要服务端设置 AGENT_PLATFORM_ENABLED=1 并完成数据库迁移与 Worker 启动。',
    tone: 'disabled',
  });
}

/** 标签页：方向键/Home/End 切换，选中项 roving tabindex。 */
export function mountTabs(root, { onChange } = {}){
  const tabs = $$('[role="tab"]', root);
  const activate = tab => {
    tabs.forEach(item => {
      const selected = item === tab;
      item.setAttribute('aria-selected', selected ? 'true' : 'false');
      item.tabIndex = selected ? 0 : -1;
      const panelId = item.getAttribute('aria-controls');
      if (panelId){
        const panel = document.getElementById(panelId);
        if (panel) panel.hidden = !selected;
      }
    });
    if (tab) tab.focus();
    onChange?.(tab?.dataset.tab || tab?.getAttribute('data-tab'));
  };
  tabs.forEach(tab => {
    tab.addEventListener('click', () => activate(tab));
    tab.addEventListener('keydown', event => {
      const index = tabs.indexOf(tab);
      let next = null;
      if (event.key === 'ArrowRight') next = tabs[(index + 1) % tabs.length];
      else if (event.key === 'ArrowLeft') next = tabs[(index - 1 + tabs.length) % tabs.length];
      else if (event.key === 'Home') next = tabs[0];
      else if (event.key === 'End') next = tabs[tabs.length - 1];
      if (next){
        event.preventDefault();
        activate(next);
      }
    });
  });
  return { activate, tabs };
}

export function announceNavigation(title){
  announce(title);
}

/** 标签页方向键导航：ArrowLeft/Right/Home/End。 */
export function bindTabKeys(tabs, activate){
  tabs.forEach((tab, index) => {
    tab.addEventListener('keydown', event => {
      let next = null;
      if (event.key === 'ArrowRight') next = tabs[(index + 1) % tabs.length];
      else if (event.key === 'ArrowLeft') next = tabs[(index - 1 + tabs.length) % tabs.length];
      else if (event.key === 'Home') next = tabs[0];
      else if (event.key === 'End') next = tabs[tabs.length - 1];
      if (!next) return;
      event.preventDefault();
      activate(next);
      next.focus();
    });
  });
}

export function bindRetry(root, handler){
  root.addEventListener('click', event => {
    const button = event.target.closest('[data-retry]');
    if (button) handler();
  });
}
