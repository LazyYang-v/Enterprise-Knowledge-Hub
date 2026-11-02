// 控制面租户解析：现有组织映射为租户；无组织的用户使用个人租户。
// 知识面 ID 只作为不透明 source_org_id 保存，不跨库建外键。
import { db } from '../db.js';
import { getPool } from './pg.js';

const cache = new Map();

export function userOrg(userId){
  return db.prepare(
    `SELECT o.id, o.name FROM org_members m JOIN orgs o ON o.id = m.org_id
      WHERE m.user_id = ? ORDER BY m.joined_at ASC LIMIT 1`,
  ).get(userId) || null;
}

export async function resolveTenantId(userId){
  if (cache.has(userId)) return cache.get(userId);
  const org = userOrg(userId);
  const source = org ? `org:${org.id}` : `user:${userId}`;
  const name = org ? org.name : `个人空间 ${userId.slice(0, 8)}`;
  const r = await getPool().query(
    `INSERT INTO tenants (name, source_org_id) VALUES ($1, $2)
     ON CONFLICT (source_org_id) DO UPDATE SET name = EXCLUDED.name
     RETURNING id`,
    [name, source],
  );
  const id = r.rows[0].id;
  cache.set(userId, id);
  return id;
}

export function clearTenantCache(){
  cache.clear();
}
