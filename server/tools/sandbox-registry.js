// 活动沙箱句柄注册表：abort、超时与 Worker 停机都必须能杀干净。
const active = new Map();

export function registerSandboxProcess(id, handle){
  active.set(String(id), handle);
  return () => active.delete(String(id));
}

export function unregisterSandboxProcess(id){
  active.delete(String(id));
}

export function listSandboxProcesses(){
  return [...active.keys()];
}

export async function killSandboxProcess(id, reason = 'kill'){
  const handle = active.get(String(id));
  if (!handle) return false;
  active.delete(String(id));
  try { await handle.kill(reason); } catch {}
  return true;
}

export async function killAllSandboxProcesses(reason = 'worker_stop'){
  const handles = [...active.entries()];
  active.clear();
  await Promise.all(handles.map(async ([, handle]) => {
    try { await handle.kill(reason); } catch {}
  }));
  return handles.length;
}
