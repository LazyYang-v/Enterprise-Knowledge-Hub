import { Router } from 'express';
import { db } from '../db.js';
import { err } from '../util.js';
import { authRequired } from '../auth.js';
import { retrieveScoped } from '../search.js';
import { visibleKbIds, intersectVisibleKbIds } from '../knowledge/acl.js';
import { isServiceToken, bearerToken } from '../service-auth.js';
import { config } from '../config.js';

const router = Router();

// 服务令牌或用户 Bearer 令牌均可访问；用户令牌按可见知识库过滤。
router.use((req, res, next) => {
  if (isServiceToken(bearerToken(req))) { req.serviceCall = true; return next(); }
  authRequired(req, res, next);
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

  if (req.serviceCall) {
    const all = db.prepare('SELECT id FROM knowledge_bases').all().map(r => r.id);
    // EKH_SERVICE_KB_SCOPE 可把服务令牌限制在指定 KB；未配置时保持旧行为（全部）。
    const configured = config.knowledge.serviceKbScope;
    const allowed = configured.length ? configured.filter(id => all.includes(id)) : all;
    if (kbIds) {
      const unknown = kbIds.filter(id => !all.includes(id));
      if (unknown.length) return err(res, 404, `知识库不存在: ${unknown.join(', ')}`);
      const denied = kbIds.filter(id => !allowed.includes(id));
      if (denied.length) return err(res, 403, `服务令牌无权访问知识库: ${denied.join(', ')}`);
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
