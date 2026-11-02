// 自定义工具仓储：不可变版本 + 归属校验。
// custom_tools 保存当前指针；custom_tool_versions 保存每次代码/参数变更的快照。
import crypto from 'node:crypto';
import { db } from '../db.js';
import { $uuid, now } from '../util.js';

export class CustomToolForbiddenError extends Error {
  constructor(message = '无权访问该工具'){
    super(message);
    this.name = 'CustomToolForbiddenError';
    this.code = 'tool_forbidden';
    this.status = 403;
  }
}

export function codeHashOf(code){
  return crypto.createHash('sha256').update(String(code ?? '')).digest('hex');
}

function parseParameters(value){
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value || '{}') : value;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch { return {}; }
}

export function toCustomTool(row){
  if (!row) return null;
  return {
    ...row,
    enabled: !!row.enabled,
    current_version: Number(row.current_version) || 1,
    deleted_at: row.deleted_at ?? null,
    parameters: parseParameters(row.parameters),
  };
}

export function getCustomTool(id, { ownerId = null, includeDeleted = false } = {}){
  const row = db.prepare('SELECT * FROM custom_tools WHERE id = ?').get(String(id));
  if (!row) return null;
  if (!includeDeleted && row.deleted_at) return null;
  if (ownerId != null && String(row.owner_id) !== String(ownerId)) return null;
  return toCustomTool(row);
}

export function requireOwnedTool(id, userId, isAdmin = false){
  const row = getCustomTool(id, { includeDeleted: false });
  if (!row) return null;
  if (!isAdmin && String(row.owner_id) !== String(userId)) throw new CustomToolForbiddenError();
  return row;
}

export function listCustomTools({ ownerId = null, includeAll = false, includeDeleted = false } = {}){
  const params = [];
  const where = [];
  if (!includeAll){
    where.push('owner_id = ?');
    params.push(String(ownerId));
  }
  if (!includeDeleted) where.push('deleted_at IS NULL');
  const sql = `SELECT * FROM custom_tools ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
               ORDER BY created_at, id`;
  return db.prepare(sql).all(...params).map(toCustomTool);
}

export function listCustomToolVersions(toolId){
  return db.prepare(
    'SELECT * FROM custom_tool_versions WHERE tool_id = ? ORDER BY version DESC',
  ).all(String(toolId));
}

export function getCustomToolVersion(toolId, version){
  const row = db.prepare(
    'SELECT * FROM custom_tool_versions WHERE tool_id = ? AND version = ?',
  ).get(String(toolId), Number(version));
  if (!row) return null;
  return { ...row, version: Number(row.version), parameters: parseParameters(row.parameters) };
}

function insertVersion(client, { toolId, version, code, hash, name, description, parameters, createdBy, createdAt }){
  client.prepare(`
    INSERT INTO custom_tool_versions
      (id, tool_id, version, code, code_hash, name, description, parameters, created_by, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(`${toolId}:${version}`, toolId, version, code, hash,
    name, description, JSON.stringify(parameters || {}), createdBy || '', createdAt || now());
}

export function createCustomTool({ ownerId, name, description = '', parameters = {}, code, createdBy = null }){
  const id = $uuid();
  const ts = now();
  const hash = codeHashOf(code);
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare(`
      INSERT INTO custom_tools
        (id, owner_id, name, description, parameters, code, enabled, current_version, code_hash, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 1, 1, ?, ?, ?)
    `).run(id, String(ownerId), String(name).slice(0, 60), String(description).slice(0, 500),
      JSON.stringify(parameters || {}), String(code), hash, ts, ts);
    insertVersion(db, {
      toolId: id, version: 1, code: String(code), hash,
      name: String(name).slice(0, 60), description: String(description).slice(0, 500),
      parameters, createdBy: createdBy || ownerId, createdAt: ts,
    });
    db.exec('COMMIT');
  } catch (e){
    db.exec('ROLLBACK');
    throw e;
  }
  return getCustomTool(id);
}

/**
 * 更新工具。代码/名称/描述/参数变化生成新版本；仅 enabled 变化不生成新版本。
 * 返回 { tool, versionCreated }。
 */
export function updateCustomTool(id, patch = {}, { ownerId = null, isAdmin = false, updatedBy = null } = {}){
  return transaction(() => {
    const row = db.prepare('SELECT * FROM custom_tools WHERE id = ? AND deleted_at IS NULL').get(String(id));
    if (!row) return null;
    if (!isAdmin && ownerId != null && String(row.owner_id) !== String(ownerId)) throw new CustomToolForbiddenError();

    const nextCode = patch.code != null ? String(patch.code) : row.code;
    const nextName = patch.name != null ? String(patch.name).slice(0, 60) : row.name;
    const nextDescription = patch.description != null ? String(patch.description).slice(0, 500) : row.description;
    const nextParameters = patch.parameters != null ? patch.parameters : parseParameters(row.parameters);
    const contentChanged = nextCode !== row.code
      || nextName !== row.name
      || nextDescription !== row.description
      || JSON.stringify(nextParameters) !== JSON.stringify(parseParameters(row.parameters));
    const enabled = patch.enabled != null ? (patch.enabled ? 1 : 0) : row.enabled;
    const ts = now();
    let version = Number(row.current_version) || 1;
    let hash = row.code_hash || codeHashOf(row.code);

    if (contentChanged){
      version += 1;
      hash = codeHashOf(nextCode);
      insertVersion(db, {
        toolId: row.id, version, code: nextCode, hash,
        name: nextName, description: nextDescription, parameters: nextParameters,
        createdBy: updatedBy || row.owner_id, createdAt: ts,
      });
    }

    db.prepare(`
      UPDATE custom_tools
         SET name = ?, description = ?, parameters = ?, code = ?, enabled = ?,
             current_version = ?, code_hash = ?, updated_at = ?
       WHERE id = ?
    `).run(nextName, nextDescription, JSON.stringify(nextParameters || {}), nextCode,
      enabled, version, hash, ts, row.id);
    return { tool: getCustomTool(row.id), versionCreated: contentChanged };
  });
}

export function setCustomToolEnabled(id, enabled, { ownerId = null, isAdmin = false } = {}){
  const result = updateCustomTool(id, { enabled: !!enabled }, { ownerId, isAdmin });
  return result?.tool || null;
}

export function deleteCustomTool(id, { ownerId = null, isAdmin = false } = {}){
  return transaction(() => {
    const row = db.prepare('SELECT * FROM custom_tools WHERE id = ? AND deleted_at IS NULL').get(String(id));
    if (!row) return null;
    if (!isAdmin && ownerId != null && String(row.owner_id) !== String(ownerId)) throw new CustomToolForbiddenError();
    const ts = now();
    db.prepare('UPDATE custom_tools SET deleted_at = ?, enabled = 0, updated_at = ? WHERE id = ?')
      .run(ts, ts, row.id);
    return row;
  });
}

export function resolveAgentCustomTools(keys, { ownerId = null, isAdmin = false } = {}){
  const ids = (keys || [])
    .filter(k => typeof k === 'string' && (k.startsWith('custom:') || k.startsWith('custom.')))
    .map(k => k.slice(k.startsWith('custom:') ? 7 : 7));
  if (!ids.length) return [];
  const placeholders = ids.map(() => '?').join(',');
  const rows = db.prepare(
    `SELECT * FROM custom_tools
      WHERE enabled = 1 AND deleted_at IS NULL AND id IN (${placeholders})`,
  ).all(...ids);
  return rows
    .filter(row => isAdmin || ownerId == null || String(row.owner_id) === String(ownerId))
    .map(toCustomTool);
}

/** 原子打开工具，避免多个异步请求在 BEGIN 之间交错。 */
function transaction(fn){
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (e){
    db.exec('ROLLBACK');
    throw e;
  }
}
