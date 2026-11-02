// KnowledgeService：ACL 是唯一入口；所有检索都重新校验可见范围。
import crypto from 'node:crypto';
import { KnowledgeError, KnowledgeForbiddenError, KnowledgeNotFoundError, KnowledgeUnavailableError } from './errors.js';
import { buildCitation, truncateExcerpt, DEFAULT_EXCERPT_CHARS } from './citations.js';
import { RETRIEVAL_DEFAULTS, retrieveScoped as defaultRetrieve } from './retrieval.js';
import { chunkContentHash } from './versioning.js';

function dedupe(values){
  return [...new Set((values || []).map(String).filter(Boolean))];
}

function scopeHash(actor, scope){
  return crypto.createHash('sha256').update(JSON.stringify({
    userId: actor.userId || null,
    tenantId: actor.tenantId || null,
    kbIds: [...scope.kbIds].sort(),
    documentIds: [...scope.documentIds].sort(),
    sessionId: scope.sessionId || null,
    versionPolicy: scope.versionPolicy || 'pin_on_first_use',
  })).digest('hex');
}

function iso(value){
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : String(value);
}

function safeDoc(doc){
  return {
    id: doc.id, kb_id: doc.kb_id || null, session_id: doc.session_id || null,
    owner_id: doc.owner_id, kind: doc.kind, name: doc.name, mime: doc.mime || '',
    ext: doc.ext || '', size: doc.size || 0, status: doc.status,
    current_version: Number(doc.current_version) || 1,
    content_hash: doc.content_hash || '', chunk_count: doc.chunk_count || 0,
    created_at: doc.created_at, updated_at: doc.updated_at, deleted_at: doc.deleted_at || null,
  };
}

export function createKnowledgeService({
  store, retrieve = defaultRetrieve, evidence = null, audit = null,
  config = {}, now = () => new Date(),
} = {}){
  if (!store) throw new Error('KnowledgeService 需要 store');

  const candidateCap = Number(config.candidateLimit) || RETRIEVAL_DEFAULTS.candidateCap;
  const ftsLimit = Number(config.ftsLimit) || RETRIEVAL_DEFAULTS.ftsLimit;
  const topKMax = Number(config.topKMax) || RETRIEVAL_DEFAULTS.topKMax;
  const excerptChars = Number(config.excerptChars) || DEFAULT_EXCERPT_CHARS;

  function canReadDocument(actor, doc){
    if (!doc) return false;
    if (doc.owner_id === actor.userId) return true;
    if (doc.kb_id && store.listVisibleKbIds(actor.userId).includes(doc.kb_id)) return true;
    if (doc.session_id){
      const session = store.getSession(doc.session_id);
      if (session && session.user_id === actor.userId) return true;
    }
    return false;
  }

  function requireDocument(actor, doc){
    if (!doc || doc.deleted_at) throw new KnowledgeNotFoundError('文档不存在');
    if (!canReadDocument(actor, doc)) throw new KnowledgeForbiddenError('无权访问该文档');
    return doc;
  }

  return {
    async listBases(actor){
      return store.listVisibleKbs(actor.userId).map(kb => ({
        id: kb.id, name: kb.name, description: kb.description || '',
        owner_id: kb.owner_id, org_id: kb.org_id || null, updated_at: kb.updated_at,
      }));
    },

    async resolveScope({
      actor, mode = null, kbIds = null, presetKbIds = null, inputDocIds = [],
      sessionId = null, versionPolicy = 'pin_on_first_use', onExplicitDenied = 'throw',
    } = {}){
      const requested = dedupe(kbIds);
      const visible = new Set(store.listVisibleKbIds(actor.userId));
      const resolvedMode = mode || (presetKbIds != null ? 'preset' : 'visible');
      let effective = [];
      let reducedCount = 0;

      if (resolvedMode === 'none'){
        effective = [];
      } else if (resolvedMode === 'explicit'){
        if (!requested.length) throw new KnowledgeError('kb_ids 不能为空', { code: 'validation_error', status: 400 });
        const denied = requested.filter(id => !visible.has(id));
        if (denied.length && onExplicitDenied === 'throw') throw new KnowledgeForbiddenError('无权访问知识库');
        effective = requested.filter(id => visible.has(id));
        reducedCount += denied.length;
        if (presetKbIds != null){
          const allowed = new Set(dedupe(presetKbIds));
          const outside = effective.filter(id => !allowed.has(id));
          reducedCount += outside.length;
          effective = effective.filter(id => allowed.has(id));
        }
      } else if (resolvedMode === 'preset'){
        const allowed = dedupe(presetKbIds);
        effective = allowed.filter(id => visible.has(id));
        reducedCount += allowed.length - effective.length;
      } else {
        effective = [...visible];
      }

      const documentIds = [];
      for (const id of dedupe(inputDocIds)){
        const doc = store.getDocument(id);
        if (!doc || doc.deleted_at || doc.owner_id !== actor.userId){
          reducedCount += 1;
          continue;
        }
        documentIds.push(id);
      }

      let session = null;
      if (sessionId){
        const row = store.getSession(sessionId);
        if (row && row.user_id === actor.userId) session = row.id;
        else reducedCount += 1;
      }

      const scope = {
        mode: resolvedMode,
        kbIds: effective.sort(),
        documentIds,
        sessionId: session,
        versionPolicy: versionPolicy === 'latest' ? 'latest' : 'pin_on_first_use',
        reducedCount,
      };
      scope.scopeHash = scopeHash(actor, scope);
      return scope;
    },

    async search({ actor, scope, query, topK = 6, taskId = null, stepId = null, toolCallId = null } = {}){
      const started = Date.now();
      if (!scope) throw new KnowledgeError('缺少检索范围', { code: 'validation_error', status: 400 });

      // 每次检索重新校验 ACL；权限撤销后立即收缩，不泄露被撤销的 KB。
      const visible = new Set(store.listVisibleKbIds(actor.userId));
      const kbIds = dedupe(scope.kbIds).filter(id => visible.has(id));
      let reducedCount = Number(scope.reducedCount) || 0;
      reducedCount += dedupe(scope.kbIds).length - kbIds.length;

      const documentIds = [];
      for (const id of dedupe(scope.documentIds)){
        const doc = store.getDocument(id);
        if (doc && !doc.deleted_at && doc.owner_id === actor.userId) documentIds.push(id);
        else reducedCount += 1;
      }
      let sessionId = null;
      if (scope.sessionId){
        const row = store.getSession(scope.sessionId);
        if (row && row.user_id === actor.userId) sessionId = row.id;
        else reducedCount += 1;
      }

      const effectiveScope = { ...scope, kbIds, documentIds, sessionId, reducedCount };
      const text = String(query || '').trim();
      if (!text) throw new KnowledgeError('query 不能为空', { code: 'validation_error', status: 400 });
      if (!kbIds.length && !documentIds.length && !sessionId){
        return {
          evidence: [], citations: [], effectiveKbIds: [], reducedCount,
          degraded: false, candidateCount: 0, candidateCapped: false,
          newEvidence: [], versionChanges: [],
        };
      }

      const versionPolicy = scope.versionPolicy === 'latest' ? 'latest' : 'pin_on_first_use';
      let pinnedVersions = {};
      if (taskId && evidence && versionPolicy === 'pin_on_first_use'){
        pinnedVersions = await evidence.getPinnedVersions({ tenantId: actor.tenantId, taskId });
      }

      const result = await retrieve({
        kbIds, documentIds, sessionId, pinnedVersions, query: text, topK,
        candidateCap, ftsLimit, topKMax,
      });

      const retrievedAt = now();
      let items = result.refs.map(ref => ({
        ...ref,
        title: ref.doc_name || '',
        kbName: ref.kb_name || '',
        locator: ref.locator_json,
        excerpt: truncateExcerpt(ref.content, excerptChars),
        retrievedAt,
      }));

      let rows = [];
      if (taskId && evidence && items.length){
        try {
          rows = await evidence.insertEvidenceSnapshots({
            tenantId: actor.tenantId, taskId, stepId, toolCallId, items,
          });
        } catch (e){
          throw new KnowledgeUnavailableError('证据快照写入失败');
        }
      }

      const versionChanges = [];
      if (versionPolicy === 'latest'){
        const seen = new Map();
        for (const item of items){
          const prior = seen.get(item.document_id);
          if (prior != null && prior !== item.document_version){
            versionChanges.push({ document_id: item.document_id, from: prior, to: item.document_version });
          } else if (prior == null){
            seen.set(item.document_id, item.document_version);
          }
        }
      }

      const evidenceOut = [];
      const citations = [];
      for (let i = 0; i < items.length; i++){
        const item = items[i];
        const row = rows[i]?.row || null;
        const id = row?.id || null;
        const citation = buildCitation({ ...item, evidence_id: id }, { excerptChars, retrievedAt: iso(retrievedAt) });
        evidenceOut.push({
          ...citation,
          label: `E${i + 1}`,
          content: item.content,
          untrusted: true,
        });
        citations.push(citation);
      }

      if (audit){
        try {
          await audit.write({
            tenantId: actor.tenantId, actorType: actor.principalType || 'user', actorId: actor.userId,
            action: 'knowledge.search', resourceType: 'knowledge', resourceId: taskId || '',
            decision: 'allowed',
            detail: {
              query: text.slice(0, 200), task_id: taskId || null,
              kb_count: kbIds.length, doc_count: documentIds.length,
              result_count: items.length, latency_ms: Date.now() - started,
              degraded: !!result.degraded, capped: !!result.candidateCapped,
            },
          });
        } catch {}
      }

      return {
        evidence: evidenceOut,
        citations,
        effectiveKbIds: kbIds,
        reducedCount,
        degraded: !!result.degraded,
        candidateCount: result.candidateCount,
        candidateCapped: !!result.candidateCapped,
        newEvidence: rows.filter(r => r.inserted).map(r => r.row),
        versionChanges,
      };
    },

    async getDocument(actor, documentId, { version = null, range = null } = {}){
      const doc = requireDocument(actor, store.getDocument(documentId));
      const requested = Number(version);
      const ver = Number.isInteger(requested) && requested > 0 ? requested : (Number(doc.current_version) || 1);
      const chunks = store.listChunks(doc.id, ver);
      if (!chunks.length && ver !== (Number(doc.current_version) || 1)){
        throw new KnowledgeNotFoundError('文档版本不存在');
      }
      const offset = Math.max(0, Number(range?.offset) || 0);
      const limit = Math.min(Math.max(Number(range?.limit) || 50000, 1), 100000);
      const full = chunks.map(c => c.content).join('\n\n');
      const text = full.slice(offset, offset + limit);
      return {
        document: safeDoc(doc),
        version: ver,
        versions: store.listDocumentVersions(doc.id).map(v => ({
          version: Number(v.version), content_hash: v.content_hash || '',
          status: v.status, created_at: v.created_at, ready_at: v.ready_at,
        })),
        chunks: chunks.map(c => ({ id: c.id, idx: c.idx, content_hash: c.content_hash || chunkContentHash(c.content) })),
        text,
        truncated: offset + limit < full.length,
      };
    },

    async getChunk(actor, chunkId){
      const chunk = store.getChunk(chunkId);
      if (!chunk) throw new KnowledgeNotFoundError('分块不存在');
      requireDocument(actor, store.getDocument(chunk.document_id));
      return {
        chunk_id: chunk.id, document_id: chunk.document_id, kb_id: chunk.kb_id || null,
        document_version: Number(chunk.document_version) || 1,
        content_hash: chunk.content_hash || chunkContentHash(chunk.content),
        locator: chunk.locator_json || {}, content: chunk.content,
        doc_name: chunk.doc_name || '', kb_name: chunk.kb_name || '',
      };
    },

    async getCitation(actor, evidenceId){
      if (!evidence || !actor.tenantId) throw new KnowledgeNotFoundError('引用不存在');
      const row = await evidence.getEvidenceForUser({
        tenantId: actor.tenantId, evidenceId, userId: actor.userId,
      });
      if (!row) throw new KnowledgeNotFoundError('引用不存在');
      const doc = store.getDocument(row.document_id);
      const citation = buildCitation({
        evidence_id: row.id, document_id: row.document_id, document_version: row.document_version,
        chunk_id: row.chunk_id, content_hash: row.content_hash,
        doc_name: row.title || doc?.name || '', kb_id: row.kb_id, kb_name: row.kb_name,
        locator_json: row.locator_json, excerpt: row.excerpt, score: row.score,
        retrieved_at: iso(row.retrieved_at),
      }, { excerptChars });
      return {
        citation,
        live: !!doc && !doc.deleted_at,
        current_version: doc ? (Number(doc.current_version) || 1) : null,
        superseded: !!doc && Number(doc.current_version) !== Number(row.document_version),
        document_deleted: !doc || !!doc.deleted_at,
      };
    },

    async getVersion(actor, documentId){
      const doc = requireDocument(actor, store.getDocument(documentId));
      return {
        document_id: doc.id,
        current_version: Number(doc.current_version) || 1,
        versions: store.listDocumentVersions(doc.id).map(v => ({
          version: Number(v.version), content_hash: v.content_hash || '',
          status: v.status, error: v.error || '', note: v.note || '',
          created_at: v.created_at, ready_at: v.ready_at,
        })),
      };
    },

    async health(){
      store.health();
      return { ok: true };
    },
  };
}
