// 应用路由表：新控制台模块 + 旧视图适配器。
import { store } from './core/store.js';
import { mountTaskList } from './views/tasks/list.js';
import { mountTaskDetail } from './views/tasks/detail.js';
import { mountApprovals } from './views/approvals.js';
import { mountArtifacts } from './views/artifacts.js';
import { adminRoute, adminIndexRoute } from './views/admin/index.js';

const platformGuard = () => (store.platformEnabled
  ? { ok: true }
  : {
    ok: false,
    title: 'Agent 平台未启用',
    desc: '需要服务端设置 AGENT_PLATFORM_ENABLED=1 并完成数据库迁移与 Worker 启动。',
    tone: 'disabled',
  });

function legacyRoute(path, viewId, legacy, label, title){
  return {
    path,
    viewId,
    legacy,
    label,
    title: typeof title === 'function' ? title : () => (title || label),
  };
}

export function buildRoutes(legacy){
  return [
    legacyRoute('/kbs', 'kb-list', 'kb-list', '知识库'),
    legacyRoute('/kbs/:id', 'kb-detail', 'kb-detail', '知识库', '知识库'),
    legacyRoute('/chat/new', 'chat-new', 'chat-new', '新对话'),
    legacyRoute('/chat/:id', 'chat-session', 'chat-session', '对话'),
    legacyRoute('/agents', 'agents', 'agents', '智能体'),
    legacyRoute('/toolbox', 'toolbox', 'toolbox', '工具箱'),
    legacyRoute('/organizations', 'organizations', 'organizations', '共享空间'),

    {
      path: '/tasks',
      viewId: 'tasks',
      nav: 'tasks',
      label: '任务',
      title: '任务',
      guard: platformGuard,
      mount: mountTaskList,
    },
    {
      path: '/tasks/:id/:tab?',
      viewId: 'task-detail',
      nav: 'tasks',
      label: '任务详情',
      title: ctx => `任务 ${String(ctx.params.id).slice(0, 8)}`,
      guard: platformGuard,
      mount: mountTaskDetail,
    },
    {
      path: '/approvals',
      viewId: 'approvals',
      nav: 'approvals',
      label: '审批',
      title: '审批',
      guard: platformGuard,
      mount: mountApprovals,
    },
    {
      path: '/artifacts',
      viewId: 'artifacts',
      nav: 'artifacts',
      label: '产物',
      title: '产物',
      guard: platformGuard,
      mount: mountArtifacts,
    },
    adminRoute('tools'),
    adminRoute('mcp'),
    adminRoute('models'),
    adminRoute('principals'),
    adminRoute('skills'),
    adminIndexRoute(),
  ];
}

export default buildRoutes;
