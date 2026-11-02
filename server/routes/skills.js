// Skill API（Agent 平台）。列表对登录用户开放；reload 仅平台管理员。
import { Router } from 'express';
import { authRequired } from '../auth.js';
import { err } from '../util.js';
import { config } from '../config.js';
import { getSkillRegistry } from '../skills/index.js';

const router = Router();

function requireBearer(req, res, next){
  if (!config.agentPlatformEnabled) return err(res, 404, '接口不存在');
  const h = req.headers.authorization || '';
  if (!h.startsWith('Bearer ')) return err(res, 401, '需要 Bearer 令牌');
  next();
}

function isPlatformAdmin(user){
  return !!user?.email && config.platformAdminEmails.includes(String(user.email).toLowerCase());
}

router.use(requireBearer);
router.use(authRequired);

router.get('/skills', async (req, res) => {
  try {
    res.json({ skills: await getSkillRegistry().list() });
  } catch (e){
    console.error('[skills]', e);
    err(res, 500, 'Skill 列表读取失败');
  }
});

router.get('/skills/:id', async (req, res) => {
  try {
    const skill = await getSkillRegistry().get(req.params.id);
    if (!skill) return err(res, 404, 'Skill 不存在');
    res.json({ skill });
  } catch (e){
    console.error('[skills]', e);
    err(res, 500, 'Skill 读取失败');
  }
});

router.post('/skills/reload', async (req, res) => {
  if (!isPlatformAdmin(req.user)) return err(res, 403, '需要平台管理员权限');
  try {
    const result = await getSkillRegistry().reload();
    res.json(result);
  } catch (e){
    console.error('[skills]', e);
    err(res, 500, 'Skill 重新加载失败');
  }
});

export default router;
