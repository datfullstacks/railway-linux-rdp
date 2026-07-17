import crypto from 'node:crypto';
import { AgentError, publicError } from './errors.js';

function nowIso(now) {
  return new Date(now()).toISOString();
}

function publicJob(job) {
  return {
    id: job.id,
    type: job.type,
    status: job.status,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    ...(job.status === 'succeeded' ? { result: job.result } : {}),
    ...(job.status === 'failed' ? { error: job.error } : {})
  };
}

export class JobQueue {
  constructor({ registry, concurrency = 1, maxBacklog = 50, maxStoredJobs = 200, retentionMs = 900000, now = Date.now }) {
    this.registry = registry;
    this.concurrency = concurrency;
    this.maxBacklog = maxBacklog;
    this.maxStoredJobs = maxStoredJobs;
    this.retentionMs = retentionMs;
    this.now = now;
    this.jobs = new Map();
    this.pending = [];
    this.idempotency = new Map();
    this.active = 0;
    this.closed = false;
    this.idleWaiters = [];
  }

  enqueue({ type, payload, idempotencyKey = '' }) {
    if (this.closed) throw new AgentError('AGENT_SHUTTING_DOWN', 'Agent is shutting down', { status: 503 });
    const normalizedType = String(type || '').trim();
    const normalizedKey = String(idempotencyKey || '').trim();
    if (normalizedKey && (normalizedKey.length > 128 || !/^[A-Za-z0-9._:-]+$/.test(normalizedKey))) {
      throw new AgentError('IDEMPOTENCY_KEY_INVALID', 'Idempotency-Key is invalid', { status: 400 });
    }
    if (normalizedKey) {
      const existingId = this.idempotency.get(normalizedKey);
      const existing = existingId ? this.jobs.get(existingId) : null;
      if (existing) {
        if (existing.type !== normalizedType) {
          throw new AgentError('IDEMPOTENCY_KEY_CONFLICT', 'Idempotency-Key is already used for another job type', {
            status: 409
          });
        }
        return { job: publicJob(existing), replayed: true };
      }
    }
    if (this.pending.length + this.active >= this.maxBacklog) {
      throw new AgentError('QUEUE_FULL', 'Multilogin agent queue is full', { status: 429, retryable: true });
    }
    this.prune();
    if (this.jobs.size >= this.maxStoredJobs) {
      throw new AgentError('JOB_STORE_FULL', 'Multilogin agent job store is full', { status: 503, retryable: true });
    }

    const normalizedPayload = this.registry.validate(normalizedType, payload);
    const createdAt = nowIso(this.now);
    const job = {
      id: `mlx_${crypto.randomUUID()}`,
      type: normalizedType,
      status: 'queued',
      createdAt,
      startedAt: null,
      finishedAt: null,
      payload: normalizedPayload,
      result: null,
      error: null,
      idempotencyKey: normalizedKey || null
    };
    this.jobs.set(job.id, job);
    if (normalizedKey) this.idempotency.set(normalizedKey, job.id);
    this.pending.push(job.id);
    queueMicrotask(() => this.drain());
    return { job: publicJob(job), replayed: false };
  }

  get(id) {
    const job = this.jobs.get(String(id || ''));
    return job ? publicJob(job) : null;
  }

  list(limit = 50) {
    return [...this.jobs.values()].slice(-limit).reverse().map(publicJob);
  }

  cancel(id) {
    const job = this.jobs.get(String(id || ''));
    if (!job) return null;
    if (job.status === 'running') {
      throw new AgentError('JOB_ALREADY_RUNNING', 'Running jobs cannot be cancelled safely', { status: 409 });
    }
    if (job.status !== 'queued') return publicJob(job);
    const index = this.pending.indexOf(job.id);
    if (index !== -1) this.pending.splice(index, 1);
    job.status = 'cancelled';
    job.finishedAt = nowIso(this.now);
    job.payload = null;
    this.notifyIdle();
    return publicJob(job);
  }

  stats() {
    return {
      active: this.active,
      queued: this.pending.length,
      stored: this.jobs.size,
      concurrency: this.concurrency,
      maxBacklog: this.maxBacklog
    };
  }

  async drain() {
    while (!this.closed && this.active < this.concurrency && this.pending.length) {
      const id = this.pending.shift();
      const job = this.jobs.get(id);
      if (!job || job.status !== 'queued') continue;
      this.active += 1;
      job.status = 'running';
      job.startedAt = nowIso(this.now);
      void this.execute(job);
    }
    this.notifyIdle();
  }

  async execute(job) {
    try {
      job.result = await this.registry.run(job.type, job.payload, {});
      job.status = 'succeeded';
    } catch (error) {
      job.error = publicError(error);
      job.status = 'failed';
      console.error(`[multilogin-agent] job failed id=${job.id} type=${job.type} code=${job.error.code}`);
    } finally {
      job.payload = null;
      job.finishedAt = nowIso(this.now);
      this.active -= 1;
      this.scheduleRemoval(job);
      this.drain();
    }
  }

  prune() {
    const cutoff = this.now() - this.retentionMs;
    for (const job of this.jobs.values()) {
      if (!job.finishedAt || Date.parse(job.finishedAt) > cutoff) continue;
      this.remove(job);
    }
  }

  scheduleRemoval(job) {
    const timer = setTimeout(() => this.remove(job), this.retentionMs);
    timer.unref?.();
  }

  remove(job) {
    if (!this.jobs.has(job.id) || ['queued', 'running'].includes(job.status)) return;
    this.jobs.delete(job.id);
    if (job.idempotencyKey && this.idempotency.get(job.idempotencyKey) === job.id) {
      this.idempotency.delete(job.idempotencyKey);
    }
  }

  async shutdown() {
    this.closed = true;
    for (const id of [...this.pending]) this.cancel(id);
    if (this.active === 0) return;
    await new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  notifyIdle() {
    if (this.active !== 0 || this.pending.length !== 0) return;
    for (const resolve of this.idleWaiters.splice(0)) resolve();
  }
}
