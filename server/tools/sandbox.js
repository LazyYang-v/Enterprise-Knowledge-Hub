// 自定义工具沙箱：process（Node 子进程 + vm）或 container（Docker，网络关闭）。
// 父进程负责超时、内存/输出上限、进程组/容器回收与 abort。
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import os from 'node:os';
import { config } from '../config.js';
import { ToolRunError } from './result.js';
import {
  resolveSandboxRuntime, assertSandboxProfileSupported, buildDockerArgs,
  permissionSupported, workerPath,
} from './sandbox-runtime.js';
import { registerSandboxProcess, unregisterSandboxProcess, killAllSandboxProcesses } from './sandbox-registry.js';
import { injectFault } from '../testing/fault-injection.js';

const MAX_STDOUT = 512 * 1024;
const INPUT_LIMIT = 512 * 1024;

function killTree(child){
  if (!child?.pid) return;
  try {
    if (process.platform === 'win32') child.kill('SIGKILL');
    else process.kill(-child.pid, 'SIGKILL');
  } catch {
    try { child.kill('SIGKILL'); } catch {}
  }
}

function dockerKill(name, bin = config.tools.sandboxDockerBin){
  if (!name) return;
  try { spawnSync(bin, ['kill', name], { timeout: 3000, stdio: 'ignore' }); } catch {}
  try { spawnSync(bin, ['rm', '-f', name], { timeout: 3000, stdio: 'ignore' }); } catch {}
}

/**
 * 在独立沙箱中求值/执行自定义工具。
 * @returns {Promise<{meta?:object,result?:string,truncated?:boolean}>}
 */
export async function runSandbox({
  mode, code, args = {}, timeoutMs = config.tools.timeoutMs,
  sandboxProfile = 'code_exec', signal = null, toolCallId = null, workerId = null, task = null,
} = {}){
  if (!['define', 'execute'].includes(mode)) throw new ToolRunError('sandbox_invalid', '沙箱模式不合法');
  const pre = await injectFault('sandbox.before_spawn', {
    task, signal, tool_call_id: toolCallId, worker_id: workerId,
  });
  if (pre?.result?.kind === 'http_status'){
    throw new ToolRunError('sandbox_unavailable', `注入沙箱 HTTP ${pre.result.status}`);
  }
  const profile = assertSandboxProfileSupported(sandboxProfile);
  const backend = resolveSandboxRuntime();
  const payload = JSON.stringify({
    mode,
    code: String(code ?? ''),
    args,
    profile,
    context: { tool_call_id: toolCallId, worker_id: workerId },
  });
  if (Buffer.byteLength(payload, 'utf8') > INPUT_LIMIT){
    throw new ToolRunError('tool_too_large', '工具代码或参数过大');
  }

  const sandboxId = `${workerId || 'local'}:${toolCallId || crypto.randomUUID()}`;
  const containerName = backend === 'container'
    ? `ekh-sbx-${crypto.createHash('sha256').update(sandboxId).digest('hex').slice(0, 20)}`
    : null;
  const effectiveTimeout = Math.max(Number(timeoutMs) || config.tools.timeoutMs, 1000);

  return new Promise((resolve, reject) => {
    let settled = false;
    let stdout = '';
    let stderr = '';
    let child = null;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', onAbort);
      unregisterSandboxProcess(sandboxId);
      fn(value);
    };
    const kill = async () => {
      if (backend === 'container'){
        dockerKill(containerName);
        try { child?.kill('SIGKILL'); } catch {}
      } else {
        killTree(child);
      }
    };
    const onAbort = () => {
      kill();
      finish(reject, new ToolRunError('sandbox_aborted', '沙箱执行已取消', { retryable: false }));
    };
    const timer = setTimeout(() => {
      kill();
      finish(reject, new ToolRunError('tool_timeout', `工具执行超时（${Math.round(effectiveTimeout / 1000)}s）`));
    }, effectiveTimeout);
    timer.unref?.();

    if (signal?.aborted){
      finish(reject, new ToolRunError('sandbox_aborted', '沙箱执行已取消', { retryable: false }));
      return;
    }
    signal?.addEventListener?.('abort', onAbort, { once: true });
    registerSandboxProcess(sandboxId, { kill });

    try {
      if (backend === 'container'){
        child = spawn(config.tools.sandboxDockerBin, buildDockerArgs({
          name: containerName, profile, timeoutMs: effectiveTimeout,
        }), {
          cwd: os.tmpdir(),
          env: { PATH: process.env.PATH || '', NODE_ENV: 'production' },
          stdio: ['pipe', 'pipe', 'pipe'],
          detached: false,
        });
      } else {
        const nodeArgs = [`--max-old-space-size=${config.tools.sandboxMemoryMb}`];
        if (config.tools.sandboxMode !== 'off' && permissionSupported()){
          nodeArgs.push('--permission', `--allow-fs-read=${workerPath()}`);
        }
        nodeArgs.push(workerPath());
        child = spawn(process.execPath, nodeArgs, {
          cwd: os.tmpdir(),
          env: { PATH: process.env.PATH || '', NODE_ENV: 'production' },
          stdio: ['pipe', 'pipe', 'pipe'],
          detached: process.platform !== 'win32',
        });
      }
    } catch (e){
      dockerKill(containerName);
      finish(reject, new ToolRunError('sandbox_unavailable', `沙箱启动失败：${e.message}`));
      return;
    }

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      stdout += chunk;
      if (stdout.length > MAX_STDOUT){
        kill();
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
    child.on('close', (code, signalName) => {
      if (settled) return;
      let parsed = null;
      try { parsed = JSON.parse(stdout.trim() || '{}'); } catch {}
      if (!parsed || typeof parsed !== 'object'){
        const unavailable = /bad option|permission|ERR_ACCESS_DENIED|EACCES|cannot connect to the Docker daemon|No such image/i.test(stderr);
        const msg = unavailable ? '沙箱不可用或被系统拒绝' : `沙箱异常退出（code=${code ?? 'null'} signal=${signalName || 'none'}）`;
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
      kill();
      finish(reject, new ToolRunError('sandbox_unavailable', `沙箱写入失败：${e.message}`));
    }
  });
}

export async function stopAllSandboxes(reason = 'worker_stop'){
  return killAllSandboxProcesses(reason);
}
