// Skill 持久化：平台租户下的 skills 行。
// manifest_json 保存 instructions 与 reference 哈希（不存 reference 正文）。
import { getPool } from '../control/pg.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class SkillVersionConflictError extends Error {
  constructor(message = '同一 Skill 版本内容已变化，但未升级版本号'){
    super(message);
    this.name = 'SkillVersionConflictError';
    this.code = 'skill_version_conflict';
  }
}

function manifestJson(record){
  return {
    instructions: record.instructions,
    instructions_path: record.instructionsPath,
    description: record.description,
    risk_level: record.riskLevel,
    status: record.status,
    allowed_tools: record.allowedTools,
    required_tools: record.requiredTools,
    references: record.references,
    source_dir: record.sourcePath,
  };
}

export async function upsertSkill({ platformTenantId, record }){
  const existing = await getPool().query(
    'SELECT * FROM skills WHERE tenant_id = $1 AND name = $2 AND version = $3',
    [platformTenantId, record.name, record.version],
  );
  if (existing.rowCount){
    const row = existing.rows[0];
    if (row.content_hash !== record.contentHash){
      throw new SkillVersionConflictError(`${record.name}@${record.version} 内容哈希已变化，请升级版本号后再 reload`);
    }
    const updated = await getPool().query(
      `UPDATE skills SET manifest_json = $4::jsonb, source_path = $5, risk_level = $6, status = $7
        WHERE id = $1 AND tenant_id = $2 AND version = $3 RETURNING *`,
      [row.id, platformTenantId, record.version, JSON.stringify(manifestJson(record)),
        record.sourcePath, record.riskLevel, record.status],
    );
    return { row: updated.rows[0], inserted: false, updated: true };
  }
  const r = await getPool().query(
    `INSERT INTO skills (tenant_id, name, version, manifest_json, source_path, content_hash, risk_level, status, created_by)
     VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7,$8,'skill-registry')
     RETURNING *`,
    [platformTenantId, record.name, record.version, JSON.stringify(manifestJson(record)),
      record.sourcePath, record.contentHash, record.riskLevel, record.status],
  );
  return { row: r.rows[0], inserted: true, updated: false };
}

export async function listSkills({ platformTenantId }){
  const r = await getPool().query(
    `SELECT DISTINCT ON (name) *
       FROM skills
      WHERE tenant_id = $1
      ORDER BY name, created_at DESC, version DESC`,
    [platformTenantId],
  );
  return r.rows.sort((a, b) => a.name.localeCompare(b.name));
}

export async function getSkill({ platformTenantId, skillId }){
  if (!UUID_RE.test(String(skillId || ''))) return null;
  const r = await getPool().query(
    'SELECT * FROM skills WHERE tenant_id = $1 AND id = $2',
    [platformTenantId, skillId],
  );
  return r.rows[0] || null;
}

export async function getSkillByNameVersion({ platformTenantId, name, version = null }){
  const params = [platformTenantId, name];
  let where = 'tenant_id = $1 AND name = $2';
  if (version){
    params.push(version);
    where += ' AND version = $3';
  }
  const r = await getPool().query(
    `SELECT * FROM skills WHERE ${where} ORDER BY created_at DESC, version DESC LIMIT 1`,
    params,
  );
  return r.rows[0] || null;
}

/** 执行器按 id+version+content_hash 读取冻结的 instructions。 */
export async function getFrozenSkill({ platformTenantId, skillId, version, contentHash }){
  const row = await getSkill({ platformTenantId, skillId });
  if (!row) return null;
  if (String(row.version) !== String(version) || row.content_hash !== contentHash){
    throw new SkillVersionConflictError('运行中的 Skill 版本/内容已变化，拒绝加载');
  }
  return row;
}
