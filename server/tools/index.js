// 工具运行时单例入口；测试可 reset 以隔离模块状态。
import * as registry from './registry.js';

let singleton = null;

export function getToolRegistry(){
  if (!singleton) singleton = registry;
  return singleton;
}

export function resetToolRegistry(){
  singleton = null;
}

export {
  resolveTools,
  resolvePinned,
  listForUser,
  defaultToolRefs,
} from './registry.js';
