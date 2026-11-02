// 知识库 ACL：所有可见性判断的唯一入口。
// 规则与旧实现一致：KB 所有者，或 KB 所属组织的任意成员。
import { db } from '../db.js';
import { KnowledgeForbiddenError } from './errors.js';

export function kbAccess(user, kb){
  if (!kb) return { visible: false, role: null };
  if (kb.owner_id === user.id) return { visible: true, role: 'owner' };
  if (kb.org_id){
    const m = db.prepare('SELECT role FROM org_members WHERE org_id = ? AND user_id = ?').get(kb.org_id, user.id);
    if (m) return { visible: true, role: m.role };
  }
  return { visible: false, role: null };
}

export const canWrite = role => ['owner', 'admin', 'contributor'].includes(role);

/** 可见知识库（SQL 层过滤，不把全表读入内存再筛）。 */
export function visibleKbs(userId){
  return db.prepare(`
    SELECT k.* FROM knowledge_bases k
    WHERE k.owner_id = ?
       OR (k.org_id IS NOT NULL AND k.org_id IN (
         SELECT org_id FROM org_members WHERE user_id = ?
       ))
    ORDER BY k.updated_at DESC, k.id
  `).all(userId, userId);
}

export function visibleKbIds(userId){
  return visibleKbs(userId).map(k => k.id);
}

export function intersectVisibleKbIds(userId, ids){
  const requested = [...new Set((ids || []).map(String).filter(Boolean))];
  const visible = new Set(visibleKbIds(userId));
  return {
    effective: requested.filter(id => visible.has(id)),
    denied: requested.filter(id => !visible.has(id)),
  };
}

export function assertKbIdsVisible(userId, ids){
  const { denied } = intersectVisibleKbIds(userId, ids);
  if (denied.length) throw new KnowledgeForbiddenError('无权访问知识库');
}

export function kbTenantKey(kb){
  return kb?.org_id ? `org:${kb.org_id}` : `user:${kb?.owner_id || ''}`;
}
