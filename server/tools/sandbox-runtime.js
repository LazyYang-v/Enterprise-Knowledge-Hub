// 沙箱后端选择与 Docker 运行参数。container 模式缺失运行时/镜像时失败关闭。
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';
import { ToolRunError } from './result.js';

const WORKER_PATH = fileURLToPath(new URL('./sandbox-worker.js', import.meta.url));
export const SANDBOX_IMAGE_USER = '10001:10001';

export function permissionSupported(){
  return process.allowedNodeEnvironmentFlags?.has('--permission')
    && process.allowedNodeEnvironmentFlags?.has('--allow-fs-read');
}

export function workerPath(){
  return WORKER_PATH;
}

export function probeDocker({ bin = config.tools.sandboxDockerBin, probeMs = config.tools.sandboxDockerProbeMs } = {}){
  try {
    const out = execFileSync(bin, ['version', '--format', '{{.Server.Version}}'], {
      timeout: probeMs, stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8',
    });
    return { available: true, version: String(out).trim() };
  } catch (e){
    return { available: false, error: e?.message || String(e) };
  }
}

export function probeSandboxImage({ bin = config.tools.sandboxDockerBin, image = config.tools.sandboxImage } = {}){
  const r = spawnSync(bin, ['image', 'inspect', image], {
    timeout: config.tools.sandboxDockerProbeMs, stdio: 'ignore',
  });
  return r.status === 0;
}

/** @returns {'process'|'container'} */
export function resolveSandboxRuntime({ mode = config.tools.sandboxMode } = {}){
  if (mode === 'container'){
    const docker = probeDocker();
    if (!docker.available){
      throw new ToolRunError('sandbox_unavailable', 'container 沙箱需要可用的 Docker', { retryable: false });
    }
    if (!probeSandboxImage()){
      throw new ToolRunError('sandbox_unavailable', `container 沙箱镜像不存在：${config.tools.sandboxImage}`, { retryable: false });
    }
    return 'container';
  }
  if (mode === 'required' && !permissionSupported()){
    throw new ToolRunError('sandbox_unavailable', '当前 Node 不支持权限沙箱', { retryable: false });
  }
  return 'process';
}

export function sandboxAvailable({ mode = config.tools.sandboxMode } = {}){
  if (mode === 'container') return probeDocker().available && probeSandboxImage();
  if (mode === 'required') return permissionSupported();
  return true;
}

/** 自定义工具只允许这三个 profile；network_allowlist 属于 MCP，browser 未实现。 */
export const CUSTOM_TOOL_PROFILES = Object.freeze(['read_only', 'workspace_write', 'code_exec']);

export function assertSandboxProfileSupported(profile){
  const value = String(profile || 'code_exec');
  if (!CUSTOM_TOOL_PROFILES.includes(value)){
    throw new ToolRunError(
      'sandbox_profile_unsupported',
      `当前沙箱后端不支持 profile：${value}`,
      { retryable: false },
    );
  }
  return value;
}

export function buildDockerArgs({
  image = config.tools.sandboxImage,
  name,
  profile = 'code_exec',
  timeoutMs = config.tools.timeoutMs,
  memoryMb = config.tools.sandboxMemoryMb,
  pidsLimit = config.tools.sandboxPidsLimit,
  cpuLimit = config.tools.sandboxCpuLimit,
  tmpfsMb = config.tools.sandboxTmpfsMb,
  workspaceMb = config.tools.sandboxWorkspaceMb,
} = {}){
  if (!name) throw new Error('容器名不能为空');
  const args = [
    'run', '--rm', '-i', '--init',
    '--name', String(name),
    '--label', 'ekh.sandbox=1',
    '--network', 'none',
    '--read-only',
    '--tmpfs', `/tmp:rw,noexec,nosuid,size=${tmpfsMb}m,mode=1777`,
    '--user', SANDBOX_IMAGE_USER,
    '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges',
    '--pids-limit', String(pidsLimit),
    '--memory', `${memoryMb}m`,
    '--memory-swap', `${memoryMb}m`,
    '--cpus', String(cpuLimit),
    '--ulimit', 'nofile=64:64',
    '--ulimit', `cpu=${Math.ceil(Number(timeoutMs) / 1000) + 5}`,
    '-e', `EKH_SANDBOX_HARD_TIMEOUT_MS=${Number(timeoutMs) + config.tools.sandboxHardTimeoutGraceMs}`,
    '-e', 'NODE_ENV=production',
  ];
  if (profile === 'workspace_write'){
    args.push('--tmpfs', `/workspace:rw,noexec,nosuid,size=${workspaceMb}m,mode=1777`);
  }
  args.push(String(image));
  return args;
}
