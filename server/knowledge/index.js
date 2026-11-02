// KnowledgeService 单例装配。只在需要知识面/控制面时加载（Worker 不静态 import）。
import { config } from '../config.js';
import { createKnowledgeService } from './service.js';
import { createSqliteKnowledgeStore } from './store-sqlite.js';
import * as evidenceRepo from '../control/evidence-repo.js';
import * as auditRepo from '../control/audit-repo.js';

let singleton = null;

export function getKnowledgeService(){
  if (!singleton){
    singleton = createKnowledgeService({
      store: createSqliteKnowledgeStore(),
      evidence: evidenceRepo,
      audit: auditRepo,
      config: config.knowledge,
    });
  }
  return singleton;
}

export function resetKnowledgeService(){
  singleton = null;
}

export { createKnowledgeService };
