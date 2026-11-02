// TaskWorker：领取、心跳续租、执行、回收、优雅停机（设计文档 §10.2–§10.9）。
import os from 'node:os';
import crypto from 'node:crypto';
import {
  claimNextTask,
  renewLease,
  releaseTask,
  getTask,
  transitionTaskTx,
  registerWorker,
  heartbeatWorker,
  setWorkerStatus,
  sqlNowPlusMs,
} from './task-repo.js';
import { TaskService, RETRYABLE_ERRORS } from './task-service.js';
import { executeTask, TaskExecutionError } from './task-executor.js';
import { resolveSandboxRuntime } from '../tools/sandbox-runtime.js';
import { stopAllSandboxes } from '../tools/sandbox.js';
import { injectFault } from '../testing/fault-injection.js';

const sleep = ms => new Promise(r => setTimeout(r, ms));

export const DEFAULT_WORKER_OPTIONS = {
  leaseTtlMs: 60000,
  heartbeatIntervalMs: 20000,
  reaperIntervalMs: 15000,
  pollIntervalMs: 1000,
  retryBaseMs: 5000,
  maxRetryDelayMs: 45000,
  shutdownGraceMs: 10000,
};

export class TaskWorker {
  constructor({
    workerId = `worker-${crypto.randomUUID()}`,
    model = null,
    modelResolver = null,
    service = new TaskService(),
    knowledgeFactory = null,
    skillLoader = null,
    toolFactory = null,
    log = msg => console.log(`[worker ${workerId}] ${msg}`),
    ...options
  } = {}){
    this.workerId = workerId;
    this.model = model;
    this.modelResolver = modelResolver;
    this.service = service;
    this.knowledgeFactory = knowledgeFactory;
    this.skillLoader = skillLoader;
    this.toolFactory = toolFactory;
    this.log = log;
    this.options = { ...DEFAULT_WORKER_OPTIONS, ...options };
    this.running = false;
    this.current = null;
    this.lastReapAt = 0;
  }

  async start(){
    if (this.running) return;
    // container 模式必须在领取任务前确认运行时/镜像，缺一即启动失败（失败关闭）。
    resolveSandboxRuntime();
    this.running = true;
    await registerWorker({
      workerId: this.workerId, hostname: os.hostname(),
      pid: process.pid, version: process.env.npm_package_version || '0.0.0',
    });
    this.log(`started (lease ${this.options.leaseTtlMs}ms, poll ${this.options.pollIntervalMs}ms)`);
    this._loopPromise = this._loop();
  }

  async _loop(){
    while (this.running){
      try {
        const task = await claimNextTask({
          workerId: this.workerId, leaseTtlMs: this.options.leaseTtlMs,
          tenantId: this.options.tenantId || null,
        });
        if (task){
          await this.runTask(task);
          continue;
        }
        await this._maybeReap();
        await sleep(this.options.pollIntervalMs);
      } catch (e){
        this.log(`loop error: ${e.message}`);
        await sleep(Math.max(this.options.pollIntervalMs, 1000));
      }
    }
  }

  async _maybeReap(){
    if (Date.now() - this.lastReapAt < this.options.reaperIntervalMs) return;
    this.lastReapAt = Date.now();
    try {
      const stats = await this.service.reapExpired({ workerId: this.workerId });
      if (stats.recovered || stats.requeued_retry || stats.approvals_expired || stats.inputs_expired){
        this.log(`reap: ${JSON.stringify(stats)}`);
      }
    } catch (e){
      this.log(`reap failed: ${e.message}`);
    }
  }

  async runOnce(){
    const task = await claimNextTask({
      workerId: this.workerId, leaseTtlMs: this.options.leaseTtlMs,
      tenantId: this.options.tenantId || null,
    });
    if (!task) return null;
    return this.runTask(task);
  }

  async runTask(task){
    const abort = new AbortController();
    let leaseLost = false;
    let finished = false;
    this.current = { task, abort };

    const heartbeat = setInterval(async () => {
      try {
        await renewLease({
          tenantId: task.tenant_id, taskId: task.id, workerId: this.workerId,
          leaseEpoch: task.lease_epoch, leaseTtlMs: this.options.leaseTtlMs,
        });
        await heartbeatWorker(this.workerId);
      } catch (e){
        leaseLost = true;
        this.log(`lease lost for ${task.id}: ${e.message}`);
        abort.abort();
      }
    }, this.options.heartbeatIntervalMs);
    heartbeat.unref?.();

    try {
      let model = this.model;
      if (this.modelResolver){
        try {
          model = await this.modelResolver(task);
        } catch (e){
          throw new TaskExecutionError('model_unavailable', `模型配置解析失败：${e.message}`, { retryable: false });
        }
      }
      await injectFault('worker.before_task', {
        task, signal: abort.signal, worker_id: this.workerId,
      });
      const result = await executeTask(task, {
        workerId: this.workerId, model, signal: abort.signal,
        log: msg => this.log(msg),
        knowledgeFactory: this.knowledgeFactory,
        skillLoader: this.skillLoader,
        toolFactory: this.toolFactory,
      });
      if (result.status === 'aborted'){
        this.log(`task ${task.id} aborted`);
        return { status: 'aborted' };
      }
      this.log(`task ${task.id} -> ${result.status}`);
      finished = true;
      return result;
    } catch (e){
      if (leaseLost) return { status: 'lease_lost' };
      // 停机/中止不是失败：交给 finally 释放任务回队列。
      if (abort.signal.aborted) return { status: 'aborted' };
      const err = e instanceof TaskExecutionError ? e : new TaskExecutionError('internal_error', e.message);
      await this._handleFailure(task, err, false);
      finished = true;
      return { status: 'failed_or_retried', error: err.code };
    } finally {
      clearInterval(heartbeat);
      this.current = null;
      // 中止/停机：任务仍由本 Worker 持有时放回队列，避免等租约过期。
      if (!finished && !leaseLost){
        try {
          const fresh = await getTask(task.tenant_id, task.id);
          if (fresh && fresh.status === 'running' && fresh.lease_owner === this.workerId
            && fresh.lease_epoch === task.lease_epoch){
            await releaseTask({
              tenantId: task.tenant_id, taskId: task.id, workerId: this.workerId,
              leaseEpoch: fresh.lease_epoch, expectVersion: fresh.version, reason: 'worker_interrupted',
            });
          }
        } catch (e){
          this.log(`release failed for ${task.id}: ${e.message}`);
        }
      }
    }
  }

  async _handleFailure(task, err, aborted){
    if (aborted && err.code === 'model_aborted') return;
    let fresh;
    try {
      fresh = await getTask(task.tenant_id, task.id);
    } catch (e){
      this.log(`reload failed: ${e.message}`);
      return;
    }
    if (!fresh || fresh.status !== 'running' || fresh.lease_owner !== this.workerId
      || fresh.lease_epoch !== task.lease_epoch) return;

    const retryable = err.retryable || RETRYABLE_ERRORS.has(err.code);
    if (retryable && fresh.attempt_count < fresh.max_attempts){
      const delay = this._backoff(fresh.attempt_count);
      try {
        await transitionTaskTx({
          tenantId: fresh.tenant_id, taskId: fresh.id, workerId: this.workerId, leaseEpoch: fresh.lease_epoch,
          expectStatus: 'running', expectVersion: fresh.version,
          to: 'retry_wait',
          patch: {
            ready_at: sqlNowPlusMs(delay),
            last_error_code: err.code, last_error_detail: err.message,
            lease_owner: null, lease_expires_at: null,
          },
          eventType: 'task.retry_scheduled',
          eventPayload: { error_code: err.code, retryable: true, attempt: fresh.attempt_count, delay_ms: delay },
          actorType: 'worker', actorId: this.workerId,
        });
        this.log(`task ${fresh.id} retry in ${delay}ms (${err.code})`);
      } catch (e){
        this.log(`retry transition failed for ${fresh.id}: ${e.message}`);
      }
      return;
    }

    const code = retryable && fresh.attempt_count >= fresh.max_attempts ? 'retry_exhausted' : err.code;
    try {
      await transitionTaskTx({
        tenantId: fresh.tenant_id, taskId: fresh.id, workerId: this.workerId, leaseEpoch: fresh.lease_epoch,
        expectStatus: 'running', expectVersion: fresh.version,
        to: 'failed',
        patch: {
          last_error_code: code, last_error_detail: err.message,
          lease_owner: null, lease_expires_at: null,
        },
        eventType: 'task.failed',
        eventPayload: {
          error_code: code, message: err.message,
          ...(err.meta && typeof err.meta === 'object' ? err.meta : {}),
        },
        actorType: 'worker', actorId: this.workerId,
      });
      this.log(`task ${fresh.id} failed: ${code}`);
    } catch (e){
      this.log(`fail transition failed for ${fresh.id}: ${e.message}`);
    }
  }

  _backoff(attempt){
    const delay = this.options.retryBaseMs * Math.pow(3, Math.max(0, attempt - 1));
    return Math.min(delay, this.options.maxRetryDelayMs);
  }

  async stop(){
    if (!this.running) return;
    this.running = false;
    try { await setWorkerStatus(this.workerId, 'draining'); } catch {}
    this.log('draining…');
    const deadline = Date.now() + this.options.shutdownGraceMs;
    while (this.current && Date.now() < deadline){
      await sleep(50);
    }
    if (this.current){
      this.current.abort.abort();
      // 给 finally 释放租约的时间
      await sleep(200);
    }
    await stopAllSandboxes('worker_shutdown');
    await Promise.race([
      this._loopPromise || Promise.resolve(),
      sleep(Math.max(this.options.shutdownGraceMs, 2000)),
    ]).catch(() => {});
    try { await setWorkerStatus(this.workerId, 'stopped'); } catch {}
    this.log('stopped');
  }
}
