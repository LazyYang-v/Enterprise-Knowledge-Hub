// 管理权限：平台管理员（PLATFORM_ADMIN_EMAILS）与组织 owner/admin。
import { config } from '../config.js';
import { db } from '../db.js';
import { err } from '../util.js';

export function isPlatformAdmin(user){
  return !!user?.email && config.platformAdminEmails.includes(String(user.email).toLowerCase());
}

export function orgRoles(userId){
  if (!userId) return [];
  return db.prepare(
    `SELECT DISTINCT role FROM org_members WHERE user_id = ?`,
  ).all(String(userId)).map(r => r.role);
}

export function isOrgAdmin(userId){
  return orgRoles(userId).some(role => role === 'owner' || role === 'admin');
}

export function isAdminUser(user){
  return isPlatformAdmin(user) || isOrgAdmin(user?.id);
}

export function requirePlatformAdmin(req, res, next){
  if (!isPlatformAdmin(req.user)) return err(res, 403, '需要平台管理员权限');
  next();
}

export function requireOrgAdmin(req, res, next){
  if (!isAdminUser(req.user)) return err(res, 403, '需要管理员权限');
  next();
}
