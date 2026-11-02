// Skill 文件路径安全：拒绝绝对路径、遍历、控制字符与 symlink 逃逸。
import path from 'node:path';
import fs from 'node:fs';

export class SkillPathError extends Error {
  constructor(message){
    super(message);
    this.name = 'SkillPathError';
    this.code = 'skill_path_invalid';
  }
}

export function safeResolve(base, rel){
  if (typeof rel !== 'string' || !rel.trim()) throw new SkillPathError('路径不能为空');
  if (rel.includes('\0') || /[\u0000-\u001f]/.test(rel)) throw new SkillPathError('路径包含控制字符');
  const normalized = rel.replace(/\\/g, '/');
  if (path.isAbsolute(normalized) || /^[a-zA-Z]:\//.test(normalized)) throw new SkillPathError('不允许绝对路径');
  if (normalized.split('/').includes('..')) throw new SkillPathError('不允许路径遍历');

  const baseReal = fs.realpathSync(base);
  let real;
  try {
    real = fs.realpathSync(path.resolve(baseReal, normalized));
  } catch {
    throw new SkillPathError(`文件不存在: ${rel}`);
  }
  if (real !== baseReal && !real.startsWith(baseReal + path.sep)) throw new SkillPathError('路径越界');
  return real;
}
