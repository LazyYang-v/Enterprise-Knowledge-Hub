// 任务知识范围：创建时解析并快照，执行器只读快照。
// 这个模块属于知识面，TaskService 通过注入使用（不静态依赖 SQLite）。
import { KnowledgeError } from './errors.js';
import { getKnowledgeService } from './index.js';
import { createSqliteKnowledgeStore } from './store-sqlite.js';

function dedupe(values){
  return [...new Set((values || []).map(String).filter(Boolean))];
}

export function createTaskKnowledgeResolver({
  service = getKnowledgeService(), store = createSqliteKnowledgeStore(),
} = {}){
  function assertInputDocs({ userId, inputIds = [] }){
    const ids = dedupe(inputIds);
    if (ids.length > 20) throw new KnowledgeError('input_ids 最多 20 项', { code: 'validation_error', status: 400 });
    const docs = [];
    for (const id of ids){
      const doc = store.getDocument(id);
      if (!doc || doc.deleted_at || doc.owner_id !== userId){
        throw new KnowledgeError(`无权使用输入文档: ${id}`, { code: 'forbidden', status: 403 });
      }
      if (doc.status !== 'ready'){
        throw new KnowledgeError(`输入文档尚未就绪: ${id}`, { code: 'conflict', status: 409 });
      }
      docs.push(id);
    }
    return docs;
  }

  async function resolveTaskKnowledge({ tenantId, ownerId, preset = null, kbScope = null, inputDocIds = [] }){
    const presetKbIds = Array.isArray(preset?.default_kb_ids) ? preset.default_kb_ids.map(String) : null;
    const mode = kbScope?.mode || (presetKbIds != null ? 'preset' : 'visible');
    const versionPolicy = kbScope?.version_policy === 'latest' ? 'latest' : 'pin_on_first_use';
    const scope = await service.resolveScope({
      actor: { userId: ownerId, tenantId, principalType: 'user' },
      mode,
      kbIds: kbScope?.kb_ids ?? null,
      presetKbIds,
      inputDocIds,
      versionPolicy,
      onExplicitDenied: 'throw',
    });
    return {
      mode: scope.mode,
      requested_kb_ids: dedupe(kbScope?.kb_ids),
      effective_kb_ids: scope.kbIds,
      input_doc_ids: scope.documentIds,
      version_policy: scope.versionPolicy,
      reduced_count: scope.reducedCount,
      scope_hash: scope.scopeHash,
    };
  }

  return { assertInputDocs, resolveTaskKnowledge };
}

export const taskKnowledge = createTaskKnowledgeResolver();
