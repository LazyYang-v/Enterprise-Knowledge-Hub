// Skill manifest 校验与内容哈希。
// 使用 skill.json（不引入 YAML 依赖），字段语义与设计文档 §6.3 对齐。
import fs from 'node:fs';
import path from 'node:path';
import { hashText } from '../knowledge/versioning.js';
import { safeResolve } from './paths.js';
import { assertNoSecrets } from './secret-scan.js';

export const SKILL_NAME_RE = /^[a-z][a-z0-9-]{1,63}$/;
export const SKILL_VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
export const SKILL_RISKS = Object.freeze(['low', 'medium', 'high']);
export const SKILL_STATUSES = Object.freeze(['draft', 'active', 'deprecated']);
export const MAX_REFERENCES = 20;
export const MAX_INSTRUCTIONS_META = 200000;

export class SkillManifestError extends Error {
  constructor(message, code = 'skill_manifest_invalid'){
    super(message);
    this.name = 'SkillManifestError';
    this.code = code;
  }
}

function requireString(obj, key, { max = 5000, min = 1 } = {}){
  const v = obj[key];
  if (typeof v !== 'string') throw new SkillManifestError(`${key} 必须是字符串`);
  const s = v.trim();
  if (s.length < min) throw new SkillManifestError(`${key} 不能为空`);
  if (s.length > max) throw new SkillManifestError(`${key} 超过 ${max} 字符`);
  return s;
}

function stringArray(obj, key, { maxItems = 50 } = {}){
  const v = obj[key];
  if (v == null) return [];
  if (!Array.isArray(v) || v.length > maxItems || v.some(x => typeof x !== 'string')){
    throw new SkillManifestError(`${key} 必须是最多 ${maxItems} 项的字符串数组`);
  }
  return v.map(x => x.trim()).filter(Boolean);
}

function validateEvals(text, relPath){
  let cases;
  try { cases = JSON.parse(text); } catch { throw new SkillManifestError(`评测文件不是合法 JSON: ${relPath}`); }
  if (!Array.isArray(cases) || cases.length < 3){
    throw new SkillManifestError('evals/cases.json 至少需要 3 个用例');
  }
  const kinds = new Set();
  for (const [i, c] of cases.entries()){
    if (!c || typeof c !== 'object') throw new SkillManifestError(`评测用例 ${i} 必须是对象`);
    if (!c.id || typeof c.id !== 'string') throw new SkillManifestError(`评测用例 ${i} 缺少 id`);
    if (!['normal', 'boundary', 'failure'].includes(c.kind)) throw new SkillManifestError(`评测用例 ${i} kind 不合法`);
    kinds.add(c.kind);
  }
  for (const kind of ['normal', 'boundary', 'failure']){
    if (!kinds.has(kind)) throw new SkillManifestError(`评测用例缺少 ${kind} 场景`);
  }
  return cases;
}

/**
 * 读取并校验一个 Skill 目录。
 * 返回 { name, version, ..., instructions, references: {path: hash}, contentHash, sourcePath, evals }
 */
export function loadSkillManifest(skillDir, { instructionMaxChars = 8000 } = {}){
  const dir = path.resolve(skillDir);
  const manifestPath = safeResolve(dir, 'skill.json');
  const rawManifest = fs.readFileSync(manifestPath, 'utf8');
  let manifest;
  try { manifest = JSON.parse(rawManifest); } catch { throw new SkillManifestError('skill.json 不是合法 JSON'); }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) throw new SkillManifestError('skill.json 必须是对象');

  const name = requireString(manifest, 'name', { max: 64 });
  if (!SKILL_NAME_RE.test(name)) throw new SkillManifestError('name 只能包含小写字母、数字与连字符');
  const version = requireString(manifest, 'version', { max: 40 });
  if (!SKILL_VERSION_RE.test(version)) throw new SkillManifestError('version 必须是 semver');
  const description = requireString(manifest, 'description', { max: 1000 });
  const riskLevel = manifest.risk_level ?? 'low';
  if (!SKILL_RISKS.includes(riskLevel)) throw new SkillManifestError('risk_level 不合法');
  const status = manifest.status ?? 'draft';
  if (!SKILL_STATUSES.includes(status)) throw new SkillManifestError('status 不合法');

  const allowedTools = stringArray(manifest, 'allowed_tools');
  const requiredTools = stringArray(manifest, 'required_tools');
  for (const t of requiredTools){
    if (!allowedTools.includes(t)) throw new SkillManifestError(`required_tools 必须包含在 allowed_tools 内: ${t}`);
  }

  const instructionsRel = manifest.instructions == null ? 'SKILL.md' : requireString(manifest, 'instructions', { max: 200 });
  const instructionsPath = safeResolve(dir, instructionsRel);
  const instructions = fs.readFileSync(instructionsPath, 'utf8');
  if (!instructions.trim()) throw new SkillManifestError('instructions 不能为空');
  if (instructions.length > instructionMaxChars){
    throw new SkillManifestError(`instructions 超过 ${instructionMaxChars} 字符上限`);
  }

  const refRels = stringArray(manifest, 'references', { maxItems: MAX_REFERENCES });
  const references = {};
  const entries = [
    { label: 'skill.json', text: rawManifest },
    { label: instructionsRel, text: instructions },
  ];
  for (const rel of refRels){
    const full = safeResolve(dir, rel);
    const text = fs.readFileSync(full, 'utf8');
    references[rel.replace(/\\/g, '/')] = hashText(text);
    entries.push({ label: rel, text });
  }

  const evalsRel = manifest.evals == null ? 'evals/cases.json' : requireString(manifest, 'evals', { max: 200 });
  let evals = null;
  try {
    const evalPath = safeResolve(dir, evalsRel);
    evals = validateEvals(fs.readFileSync(evalPath, 'utf8'), evalsRel);
  } catch (e){
    // 评测文件缺失是硬错误；JSON 错误同样硬错误。
    if (e instanceof SkillManifestError) throw e;
    throw new SkillManifestError(`评测文件读取失败: ${evalsRel}`);
  }

  assertNoSecrets(entries);

  const hashBase = [
    name, version, riskLevel, status,
    allowedTools.slice().sort().join(','), requiredTools.slice().sort().join(','),
    ...entries.sort((a, b) => a.label.localeCompare(b.label)).map(e => `${e.label}\n${e.text}`),
  ].join('\n---\n');

  return {
    name, version, description, riskLevel, status,
    allowedTools, requiredTools,
    instructions, references,
    instructionsPath: instructionsRel,
    evals,
    sourcePath: dir,
    contentHash: hashText(hashBase),
  };
}

export function discoverSkillDirs(skillsDir){
  let entries;
  try { entries = fs.readdirSync(skillsDir, { withFileTypes: true }); } catch { return []; }
  return entries
    .filter(e => e.isDirectory() && !e.name.startsWith('.'))
    .map(e => path.join(skillsDir, e.name))
    .filter(dir => fs.existsSync(path.join(dir, 'skill.json')));
}
