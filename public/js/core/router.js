// Hash 路由：视图注册、生命周期、守卫、导航高亮与焦点管理。
import { $, $$, announce } from './dom.js';
import { matchRoute } from './route-match.js';
import { parseHash, navigate, DEFAULT_ROUTE } from './navigation.js';
import { stateBlock } from './ui.js';

export function createRouter({ routes, legacy = null, fallback = DEFAULT_ROUTE, appName = '企业知识库' }){
  let current = null;
  let controller = null;
  let lastRaw = null;
  let started = false;

  function updateNav(path, route){
    for (const el of $$('[data-route]')){
      const target = el.getAttribute('data-route');
      const active = target === path || (target !== '/' && path.startsWith(`${target}/`));
      el.classList.toggle('active', active);
      if (active) el.setAttribute('aria-current', 'page');
      else el.removeAttribute('aria-current');
    }
    for (const el of $$('[data-nav-key]')){
      const active = el.getAttribute('data-nav-key') === route?.nav;
      el.classList.toggle('active', active);
      if (active) el.setAttribute('aria-current', 'page');
      else el.removeAttribute('aria-current');
    }
  }

  function focusView(section){
    const heading = section?.querySelector('h1, h2, .page-title');
    if (heading){
      if (!heading.hasAttribute('tabindex')) heading.setAttribute('tabindex', '-1');
      heading.focus({ preventScroll: true });
    }
  }

  async function handle(force = false){
    const { path, query, raw } = parseHash();
    if (!force && raw === lastRaw) return;
    lastRaw = raw;

    controller?.abort();
    controller = new AbortController();
    const signal = controller.signal;

    try { current?.route?.unmount?.(); } catch (error){ console.error('[router] unmount', error); }
    if (current?.route?.legacy) {
      try { legacy?.deactivate?.(); } catch (error){ console.error('[router] legacy deactivate', error); }
    }
    current = null;

    $$('.view').forEach(view => view.classList.remove('active'));
    $$('[data-route], [data-nav-key]').forEach(el => {
      el.classList.remove('active');
      el.removeAttribute('aria-current');
    });

    const matched = matchRoute(routes, path);
    if (!matched){
      if (path !== fallback){
        navigate(fallback, { replace: true });
        return;
      }
      return;
    }

    const { route, params } = matched;
    const ctx = { path, params, query, route, signal };
    const section = document.getElementById(`view-${route.viewId}`);
    if (!section){
      console.error('[router] 缺少视图容器', route.viewId);
      return;
    }
    section.classList.add('active');
    current = { route, params, query, ctx };
    updateNav(path, route);

    const title = (typeof route.title === 'function' ? route.title(ctx) : route.title) || route.label || '';
    document.title = title ? `${title} · ${appName}` : appName;

    const guard = route.guard?.(ctx);
    if (guard && guard.ok === false){
      section.innerHTML = stateBlock({
        title: guard.title || '无法访问',
        desc: guard.desc || '',
        tone: guard.tone || 'disabled',
        actions: guard.actions || '',
      });
      announce(guard.title || title);
      focusView(section);
      return;
    }

    try {
      if (route.legacy) await legacy?.activate?.(route.legacy, ctx);
      else await route.mount?.(ctx, signal);
    } catch (error){
      if (signal.aborted) return;
      console.error('[router] mount', error);
      section.innerHTML = stateBlock({
        title: '页面加载失败',
        desc: String(error?.message || error),
        tone: 'error',
        actions: '<button class="btn" data-route-retry>重试</button>',
      });
      section.querySelector('[data-route-retry]')?.addEventListener('click', () => handle(true));
    }

    if (signal.aborted) return;
    focusView(section);
    announce(title);
  }

  function start(){
    if (started) return;
    started = true;
    if (!window.location.hash) window.history.replaceState(null, '', `#${fallback}`);
    window.addEventListener('hashchange', () => { handle(false); });
    handle(true);
  }

  function go(path, options){ navigate(path, options); }
  function refresh(){ handle(true); }

  return { start, go, refresh, handle, get current(){ return current; } };
}
