import { store } from './store.js';

export function isAdmin(user = store.user){
  return !!user?.is_admin;
}

export function isPlatformAdmin(user = store.user){
  return !!user?.is_platform_admin;
}

export function canSeeAdmin(user = store.user){
  return isAdmin(user) || isPlatformAdmin(user);
}

export function canDecideApproval(approval, user = store.user){
  if (!approval || approval.status !== 'pending') return false;
  if (approval.requested_by && approval.requested_by === user?.id) return false;
  if (approval.expires_at && new Date(approval.expires_at).getTime() <= Date.now()) return false;
  return approval.can_decide ?? (approval.task_owner_id === user?.id || isAdmin(user));
}
