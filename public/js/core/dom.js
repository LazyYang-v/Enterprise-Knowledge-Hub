// 轻量 DOM 工具：统一选择器、转义与焦点管理。
export const $ = (selector, root) => (root || document).querySelector(selector);
export const $$ = (selector, root) => Array.from((root || document).querySelectorAll(selector));

export const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[ch]));

export function createEl(tag, { className, text, attrs, dataset } = {}){
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text != null) el.textContent = String(text);
  if (attrs) for (const [key, value] of Object.entries(attrs)){
    if (value == null || value === false) continue;
    el.setAttribute(key, value === true ? '' : String(value));
  }
  if (dataset) for (const [key, value] of Object.entries(dataset)){
    if (value != null) el.dataset[key] = String(value);
  }
  return el;
}

export function focusables(root){
  return $$(
    'a[href],button:not([disabled]),textarea:not([disabled]),input:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])',
    root,
  ).filter(el => el.offsetParent !== null || el === document.activeElement);
}

/** 把焦点限制在容器内；Esc 触发 onEscape。返回恢复函数。 */
export function trapFocus(container, { onEscape } = {}){
  const previous = document.activeElement;
  const onKey = event => {
    if (event.key === 'Escape' && onEscape){
      event.preventDefault();
      onEscape();
      return;
    }
    if (event.key !== 'Tab') return;
    const list = focusables(container);
    if (!list.length) return;
    const first = list[0];
    const last = list[list.length - 1];
    if (event.shiftKey && document.activeElement === first){
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last){
      event.preventDefault();
      first.focus();
    }
  };
  container.addEventListener('keydown', onKey);
  requestAnimationFrame(() => {
    const list = focusables(container);
    (list[0] || container).focus?.();
  });
  return () => {
    container.removeEventListener('keydown', onKey);
    if (previous && typeof previous.focus === 'function') previous.focus();
  };
}

export function announce(message){
  const region = document.getElementById('live-region');
  if (!region) return;
  region.textContent = '';
  setTimeout(() => { region.textContent = String(message || ''); }, 30);
}

export function on(root, eventName, selector, handler){
  const listener = event => {
    const target = event.target.closest(selector);
    if (target && root.contains(target)) handler(event, target);
  };
  root.addEventListener(eventName, listener);
  return () => root.removeEventListener(eventName, listener);
}
