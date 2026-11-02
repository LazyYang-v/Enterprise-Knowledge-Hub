import { Router } from 'express';
import { db } from '../db.js';
import { err } from '../util.js';
import { authRequired } from '../auth.js';
import { retrieveScoped } from '../search.js';
import { visibleKbIds, intersectVisibleKbIds } from '../knowledge/acl.js';
import { bearerToken, authenticateServiceToken } from '../service-auth.js';
import { config } from '../config.js';

const router = Router();

// 服务主体或用户 Bearer 令牌均可访问；用户令牌按可见知识库过滤。
router.use(async (req, res, next) => {
  try {
    const principal = await authenticateServiceToken(bearerToken(req));
    if (principal) { req.servicePrincipal = principal; return next(); }
    authRequired(req, res, next);
  } catch (e){
    console.error('[retrieve] service auth failed:', e?.message || e);
    return err(res, 503, '服务身份校验暂不可用');
  }
});

router.post('/retrieve', async (req, res) => {
  const { query } = req.body || {};
  const topKMax = config.knowledge.topKMax;
  const topK = Math.min(Math.max(Number(req.body?.top_k ?? req.body?.topK) || 6, 1), topKMax);
  const text = String(query || '').trim();
  if (!text) return err(res, 400, 'query 不能为空');

  let kbIds = req.body?.kb_ids ?? req.body?.kbIds ?? null;
  if (kbIds !== null && !Array.isArray(kbIds)) return err(res, 400, 'kb_ids 必须是数组');
  kbIds = kbIds ? [...new Set(kbIds.map(String))] : null;

  if (req.servicePrincipal) {
    const all = db.prepare('SELECT id FROM knowledge_bases').all().map(r => r.id);
    const scopes = req.servicePrincipal.scopes || {};
    const allowed = scopes.all_kbs
      ? all
      : [...new Set((scopes.kb_ids || []).map(String))].filter(id => all.includes(id));
    if (kbIds) {
      const unknown = kbIds.filter(id => !all.includes(id));
      if (unknown.length) return err(res, 404, `知识库不存在: ${unknown.join(', ')}`);
      const denied = kbIds.filter(id => !allowed.includes(id));
      if (denied.length) return err(res, 403, `服务身份无权访问知识库: ${denied.join(', ')}`);
    } else {
      kbIds = allowed;
    }
  } else {
    if (kbIds) {
      const { denied } = intersectVisibleKbIds(req.user.id, kbIds);
      if (denied.length) return err(res, 403, `无权访问知识库: ${denied.join(', ')}`);
    } else {
      kbIds = visibleKbIds(req.user.id);
    }
  }

  if (!kbIds.length) return res.json({ query: text, kb_ids: [], refs: [] });
  const { refs } = await retrieveScoped({ kbIds, query: text, topK });
  res.json({ query: text, kb_ids: kbIds, refs });
});

export default router;
