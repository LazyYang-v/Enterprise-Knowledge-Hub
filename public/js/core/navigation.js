// Hash 导航：只读写 location.hash，不依赖视图模块。
export const DEFAULT_ROUTE = '/kbs';

export function parseHash(hash = window.location.hash){
  const raw = String(hash || '').replace(/^#/, '');
  const clean = raw || DEFAULT_ROUTE;
  const [pathPart, queryPart = ''] = clean.split('?');
  const path = pathPart.startsWith('/') ? pathPart : `/${pathPart}`;
  const query = {};
  for (const [key, value] of new URLSearchParams(queryPart)) query[key] = value;
  return { path, query, raw: clean };
}

export function buildPath(path, query = null){
  const target = path.startsWith('/') ? path : `/${path}`;
  if (!query) return target;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)){
    if (value == null || value === '') continue;
    params.set(key, String(value));
  }
  const qs = params.toString();
  return qs ? `${target}?${qs}` : target;
}

export function navigate(path, { replace = false, query = null } = {}){
  const target = `#${buildPath(path, query)}`;
  if (window.location.hash === target){
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    return;
  }
  if (replace){
    window.history.replaceState(null, '', target);
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    return;
  }
  window.location.hash = target.slice(1);
}

export function replaceQuery(patch = {}){
  const { path, query } = parseHash();
  navigate(path, { query: { ...query, ...patch }, replace: true });
}

/** 只更新地址栏，不触发路由重挂载（用于筛选/搜索等本地状态）。 */
export function replaceUrl(path, query = null){
  window.history.replaceState(null, '', `#${buildPath(path, query)}`);
}

export function link(path, query = null){
  return `#${buildPath(path, query)}`;
}

export function routeForLegacyView(name, context = {}){
  const routes = {
    'kb-list': '/kbs',
    'kb-detail': context.kbId ? `/kbs/${context.kbId}` : '/kbs',
    'chat-new': '/chat/new',
    'chat-session': context.sessionId ? `/chat/${context.sessionId}` : '/chat/new',
    agents: '/agents',
    tasks: '/tasks',
    'task-detail': context.taskId ? `/tasks/${context.taskId}` : '/tasks',
    artifacts: '/artifacts',
    toolbox: '/toolbox',
    organizations: '/organizations',
  };
  return routes[name] || DEFAULT_ROUTE;
}
