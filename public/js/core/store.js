// 新控制台共享状态。旧视图仍使用 app.js 内的 state，两者互不污染。
const listeners = new Map();

export const store = {
  user: null,
  platform: {
    agent_platform_enabled: true,
    sandbox_mode: 'process',
    artifact_limits: {},
  },
  permissions: {
    is_admin: false,
    is_platform_admin: false,
  },
  setUser(user){
    this.user = user || null;
    this.platform = { ...this.platform, ...(user?.platform || {}) };
    this.permissions = {
      is_admin: !!user?.is_admin,
      is_platform_admin: !!user?.is_platform_admin,
    };
    emit('user', user);
  },
  get platformEnabled(){
    return this.platform.agent_platform_enabled !== false;
  },
  on(event, handler){
    if (!listeners.has(event)) listeners.set(event, new Set());
    listeners.get(event).add(handler);
    return () => listeners.get(event)?.delete(handler);
  },
  emit,
};

export function emit(event, detail){
  for (const handler of listeners.get(event) || []) {
    try { handler(detail); } catch (error){ console.error('[store]', error); }
  }
}
