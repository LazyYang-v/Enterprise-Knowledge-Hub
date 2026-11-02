// 纯函数路由匹配，便于 Node 单测。
function splitPath(path){
  return String(path || '/').split('/').filter(Boolean);
}

export function matchPattern(pattern, path){
  const target = splitPath(path);
  const source = splitPath(pattern);
  const params = {};
  for (let i = 0; i < source.length; i += 1){
    const part = source[i];
    if (part.startsWith(':')){
      const optional = part.endsWith('?');
      const name = part.slice(1, optional ? -1 : undefined);
      if (target[i] == null){
        if (optional && i === source.length - 1) return params;
        return null;
      }
      params[name] = decodeURIComponent(target[i]);
      continue;
    }
    if (target[i] !== part) return null;
  }
  return target.length === source.length ? params : null;
}

export function matchRoute(routes, path){
  for (const route of routes){
    const params = matchPattern(route.path, path);
    if (params) return { route, params };
  }
  return null;
}
