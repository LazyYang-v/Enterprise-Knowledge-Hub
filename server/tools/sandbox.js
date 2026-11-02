// 自定义工具子进程沙箱：父进程负责超时、内存、输出上限与进程组回收。
// 子进程入口不使用宿主 fetch/require；权限模型再阻断文件读取（按 Node 版本能力）。
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import { config } from '../config.js';
import { ToolRunError } from './result.js';

const WORKER_PATH = fileURLToPath(new URL('./sandbox-worker.js', import.meta.url));
const MAX_STDOUT = 512 * 1024;
const INPUT_LIMIT = 512 * 1024;

function permissionSupported(){
  return process.allowedNodeEnvironmentFlags?.has('--permission')
    && process.allowedNodeEnvironmentFlags?.has('--allow-fs-read');
}

function killTree(child){
  if (!child.pid) return;
  try {
    if (process.platform === 'win32') child.kill('SIGKILL');
    else process.kill(-child.pid, 'SIGKILL');
  } catch {
    try { child.kill('SIGKILL'); } catch {}
  }
}

/**
 * 在独立 Node 子进程中求值/执行自定义工具。
 * @returns {Promise<{meta?:object,result?:string,truncated?:boolean}>}
 */
export function runSandbox({ mode, code, args = {}, timeoutMs = config.tools.timeoutMs } = {}){
  if (!['define', 'execute'].includes(mode)) return Promise.reject(new ToolRunError('sandbox_invalid', '沙箱模式不合法'));
  const modeConfig = config.tools.sandboxMode;
  if (modeConfig === 'required' && !permissionSupported()){
    return Promise.reject(new ToolRunError('sandbox_unavailable', '当前 Node 不支持权限沙箱', { retryable: false }));
  }
  const payload = JSON.stringify({ mode, code: String(code ?? ''), args });
  if (Buffer.byteLength(payload, 'utf8') > INPUT_LIMIT){
    return Promise.reject(new ToolRunError('tool_too_large', '工具代码或参数过大'));
  }

  const nodeArgs = [`--max-old-space-size=${config.tools.sandboxMemoryMb}`];
  if (modeConfig !== 'off' && permissionSupported()){
    nodeArgs.push('--permission', `--allow-fs-read=${WORKER_PATH}`);
  }
  nodeArgs.push(WORKER_PATH);

  return new Promise((resolve, reject) => {
    let settled = false;
    let stdout = '';
    let stderr = '';
    const child = spawn(process.execPath, nodeArgs, {
      cwd: os.tmpdir(),
      env: { PATH: process.env.PATH || '', NODE_ENV: 'production' },
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });

    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };
    const timer = setTimeout(() => {
      killTree(child);
      finish(reject, new ToolRunError('tool_timeout', `工具执行超时（${Math.round(timeoutMs / 1000)}s）`));
    }, Math.max(Number(timeoutMs) || config.tools.timeoutMs, 1000));
    timer.unref?.();

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      stdout += chunk;
      if (stdout.length > MAX_STDOUT){
        killTree(child);
        finish(reject, new ToolRunError('tool_output_limit', '工具输出超过沙箱上限'));
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => {
      if (stderr.length < 4000) stderr += chunk;
    });
    child.on('error', e => {
      finish(reject, new ToolRunError('sandbox_unavailable', `沙箱启动失败：${e.message}`));
    });
    child.on('close', (code, signal) => {
      if (settled) return;
      let parsed = null;
      try { parsed = JSON.parse(stdout.trim() || '{}'); } catch {}
      if (!parsed || typeof parsed !== 'object'){
        const unavailable = /bad option|permission|ERR_ACCESS_DENIED|EACCES/i.test(stderr);
        const msg = unavailable ? '沙箱不可用或被系统拒绝' : `沙箱异常退出（code=${code ?? 'null'} signal=${signal || 'none'}）`;
        finish(reject, new ToolRunError(unavailable ? 'sandbox_unavailable' : 'tool_execution_failed', msg));
        return;
      }
      if (!parsed.ok){
        const err = parsed.error || {};
        finish(reject, new ToolRunError(
          String(err.code || 'tool_execution_failed'),
          String(err.message || '工具执行失败').slice(0, 500),
        ));
        return;
      }
      finish(resolve, parsed);
    });

    try {
      child.stdin.end(payload);
    } catch (e){
      killTree(child);
      finish(reject, new ToolRunError('sandbox_unavailable', `沙箱写入失败：${e.message}`));
    }
  });
}

export function sandboxAvailable(){
  return permissionSupported() || config.tools.sandboxMode !== 'required';
}
