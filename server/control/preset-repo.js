// Agent 预设读取（P0-3 只读；编辑留后续版本）。
import { getPool } from './pg.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function getPreset({ tenantId, presetId }){
  if (!UUID_RE.test(String(presetId || ''))) return null;
  const r = await getPool().query(
    'SELECT * FROM agent_presets WHERE tenant_id = $1 AND id = $2',
    [tenantId, presetId],
  );
  return r.rows[0] || null;
}

export async function listPresetSkills({ presetId, enabledOnly = true }){
  if (!UUID_RE.test(String(presetId || ''))) return [];
  const r = await getPool().query(
    `SELECT s.*, ps.enabled, ps.config_json
       FROM agent_preset_skills ps
       JOIN skills s ON s.id = ps.skill_id
      WHERE ps.preset_id = $1 ${enabledOnly ? 'AND ps.enabled = true' : ''}
      ORDER BY s.name, s.version DESC`,
    [presetId],
  );
  return r.rows;
}
