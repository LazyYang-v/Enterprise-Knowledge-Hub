// SkillRegistry：磁盘校验 → 平台租户持久化 → 渐进加载。
import path from 'node:path';
import { config } from '../config.js';
import { ensurePlatformTenantId } from '../control/tenants.js';
import { loadSkillManifest, discoverSkillDirs } from './manifest.js';
import {
  upsertSkill, listSkills, getSkill, getSkillByNameVersion, getFrozenSkill,
} from './repo.js';
import { listPresetSkills } from '../control/preset-repo.js';

// P0-3 暴露给 Skill 的内部能力；P0-4 会由 ToolRegistry 动态提供。
export const P0_3_AVAILABLE_TOOLS = Object.freeze([
  'knowledge.search', 'knowledge.get_document', 'knowledge.get_citation', 'knowledge.list_bases',
]);

export class SkillSelectionError extends Error {
  constructor(message, code = 'skill_unavailable'){
    super(message);
    this.name = 'SkillSelectionError';
    this.code = code;
    this.status = 422;
  }
}

function summary(row){
  return {
    skill_id: row.id, name: row.name, version: row.version,
    content_hash: row.content_hash, risk_level: row.risk_level, status: row.status,
  };
}

function publicRow(row){
  const m = row.manifest_json || {};
  return {
    id: row.id, name: row.name, version: row.version,
    description: m.description || '', risk_level: row.risk_level, status: row.status,
    allowed_tools: m.allowed_tools || [], required_tools: m.required_tools || [],
    references: Object.keys(m.references || {}),
    content_hash: row.content_hash, source_path: row.source_path,
    created_at: row.created_at,
  };
}

function unavailableReason(row, availableTools){
  if (row.status !== 'active') return 'skill_inactive';
  if (row.risk_level === 'high') return 'skill_high_risk';
  const required = row.manifest_json?.required_tools || [];
  const missing = required.filter(t => !availableTools.includes(t));
  if (missing.length) return `missing_tools:${missing.join(',')}`;
  return null;
}

export { unavailableReason as skillAvailability };

function refFrom(raw){
  if (raw == null) return null;
  if (typeof raw === 'string'){
    const s = raw.trim();
    if (!s) return null;
    const at = s.lastIndexOf('@');
    if (at > 0) return { name: s.slice(0, at), version: s.slice(at + 1) };
    return { name: s };
  }
  if (typeof raw === 'object' && !Array.isArray(raw)){
    if (raw.id) return { id: String(raw.id) };
    if (raw.name) return { name: String(raw.name), version: raw.version ? String(raw.version) : null };
  }
  throw new SkillSelectionError('skill 必须是非空字符串或 {id|name,version} 对象');
}

export { refFrom as parseSkillRef };

export function createSkillRegistry({
  skillsDir = config.skills.dir || path.resolve(process.cwd(), 'skills'),
  instructionMaxChars = config.skills.instructionMaxChars,
  availableTools = P0_3_AVAILABLE_TOOLS,
  log = msg => console.log(`[skills] ${msg}`),
} = {}){
  async function resolveRow(platformTenantId, ref){
    if (ref.id) return getSkill({ platformTenantId, skillId: ref.id });
    return getSkillByNameVersion({ platformTenantId, name: ref.name, version: ref.version });
  }

  async function select({ tenantId = null, skillRef = null, presetId = null } = {}){
    const platformTenantId = await ensurePlatformTenantId();
    const ref = refFrom(skillRef);
    if (ref){
      const row = await resolveRow(platformTenantId, ref);
      if (!row) throw new SkillSelectionError('Skill 不存在或版本不可用');
      if (tenantId && row.tenant_id !== platformTenantId){
        throw new SkillSelectionError('Skill 不可见');
      }
      const reason = unavailableReason(row, availableTools);
      if (reason) throw new SkillSelectionError(`Skill 不可用：${reason}`);
      return summary(row);
    }
    if (presetId){
      const rows = await listPresetSkills({ presetId });
      if (rows.length === 0) return null;
      if (rows.length > 1) return null; // 多个技能且任务未显式指定：不自动选
      const row = rows[0];
      const reason = unavailableReason(row, availableTools);
      if (reason) throw new SkillSelectionError(`预设技能不可用：${reason}`);
      return summary(row);
    }
    return null;
  }

  async function list(){
    const platformTenantId = await ensurePlatformTenantId();
    const rows = await listSkills({ platformTenantId });
    return rows.map(row => {
      const reason = unavailableReason(row, availableTools);
      return {
        ...publicRow(row),
        selectable: !reason,
        unavailable_reason: reason || null,
      };
    });
  }

  async function get(skillId){
    const platformTenantId = await ensurePlatformTenantId();
    const row = await getSkill({ platformTenantId, skillId });
    if (!row) return null;
    const reason = unavailableReason(row, availableTools);
    return {
      ...publicRow(row),
      instructions: row.manifest_json?.instructions || '',
      selectable: !reason,
      unavailable_reason: reason || null,
    };
  }

  async function reload(){
    const platformTenantId = await ensurePlatformTenantId();
    const dirs = discoverSkillDirs(skillsDir);
    const result = { skills_dir: skillsDir, discovered: dirs.length, loaded: 0, inserted: 0, updated: 0, errors: [] };
    for (const dir of dirs){
      try {
        const record = loadSkillManifest(dir, { instructionMaxChars });
        const saved = await upsertSkill({ platformTenantId, record });
        result.loaded += 1;
        if (saved.inserted) result.inserted += 1;
        else if (saved.updated) result.updated += 1;
      } catch (e){
        result.errors.push({ dir: path.basename(dir), code: e.code || 'skill_load_error', message: e.message });
      }
    }
    if (result.errors.length) log(`reload completed with ${result.errors.length} error(s)`);
    return result;
  }

  async function loadInstructions({ skillId, version, contentHash }){
    const platformTenantId = await ensurePlatformTenantId();
    const row = await getFrozenSkill({ platformTenantId, skillId, version, contentHash });
    if (!row){
      const err = new Error('Skill 不存在');
      err.code = 'skill_unavailable';
      throw err;
    }
    return {
      ...summary(row),
      instructions: String(row.manifest_json?.instructions || '').slice(0, instructionMaxChars),
    };
  }

  return { select, list, get, reload, loadInstructions, skillsDir };
}
