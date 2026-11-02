// 凭证引用解析：只允许 env:NAME / file:<secret_dir 下相对路径>。
// 返回值只交给调用方拼装请求头，禁止写入事件、审计、日志或 API 响应。
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';

export class CredentialError extends Error {
  constructor(code, message){
    super(message);
    this.name = 'CredentialError';
    this.code = code;
    this.retryable = false;
  }
}

export function resolveCredentialRef(ref){
  const value = String(ref || '').trim();
  if (!value) return '';
  if (value.startsWith('env:')){
    const name = value.slice(4);
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(name)){
      throw new CredentialError('credential_invalid', 'credential_ref env 名称不合法');
    }
    const secret = process.env[name];
    if (!secret) throw new CredentialError('credential_unavailable', `环境变量 ${name} 未配置`);
    return String(secret);
  }
  if (value.startsWith('file:')){
    const root = config.models.secretDir;
    if (!root) throw new CredentialError('credential_unavailable', 'EKH_MODEL_SECRET_DIR 未配置');
    const rel = value.slice(5);
    if (!rel || path.isAbsolute(rel) || rel.includes('\0')){
      throw new CredentialError('credential_invalid', 'credential_ref 文件路径不合法');
    }
    const base = path.resolve(root);
    const target = path.resolve(base, rel);
    if (target !== base && !target.startsWith(base + path.sep)){
      throw new CredentialError('credential_invalid', 'credential_ref 必须位于密钥目录内');
    }
    try {
      const secret = fs.readFileSync(target, 'utf8').trim();
      if (!secret) throw new CredentialError('credential_unavailable', '凭证文件为空');
      return secret;
    } catch (e){
      if (e instanceof CredentialError) throw e;
      throw new CredentialError('credential_unavailable', '凭证文件不可读取');
    }
  }
  throw new CredentialError('credential_invalid', 'credential_ref 只支持 env:NAME 或 file:相对路径');
}

/** API 响应只返回是否已配置，永不回显引用背后的值。 */
export function credentialConfigured(ref){
  try { return !!resolveCredentialRef(ref); }
  catch { return false; }
}
