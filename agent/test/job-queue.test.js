import assert from 'node:assert/strict';
import test from 'node:test';
import { JobQueue } from '../src/job-queue.js';

async function waitFor(check, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = check();
    if (value) return value;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error('Timed out waiting for queue state');
}

test('queue runs jobs sequentially and clears private payloads', async () => {
  const starts = [];
  let releaseFirst;
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
  const registry = {
    validate: (_type, payload) => payload,
    async run(_type, payload) {
      starts.push(payload.sequence);
      if (payload.sequence === 1) await firstGate;
      return { sequence: payload.sequence };
    }
  };
  const queue = new JobQueue({ registry, concurrency: 1, retentionMs: 60000 });
  const first = queue.enqueue({ type: 'test', payload: { sequence: 1, secret: 'never-return' } }).job;
  const second = queue.enqueue({ type: 'test', payload: { sequence: 2 } }).job;

  await waitFor(() => queue.get(first.id)?.status === 'running');
  assert.equal(queue.get(second.id).status, 'queued');
  assert.deepEqual(starts, [1]);
  releaseFirst();

  await waitFor(() => queue.get(second.id)?.status === 'succeeded');
  assert.deepEqual(starts, [1, 2]);
  assert.equal(queue.jobs.get(first.id).payload, null);
  assert.doesNotMatch(JSON.stringify(queue.get(first.id)), /never-return/);
});

test('queue replays idempotent jobs and rejects cross-type reuse', () => {
  const registry = {
    validate: (_type, payload) => payload,
    run: async () => ({ ok: true })
  };
  const queue = new JobQueue({ registry });
  const first = queue.enqueue({ type: 'profile.stop', payload: { profileId: 'one' }, idempotencyKey: 'same-1' });
  const replay = queue.enqueue({ type: 'profile.stop', payload: { profileId: 'two' }, idempotencyKey: 'same-1' });
  assert.equal(replay.replayed, true);
  assert.equal(replay.job.id, first.job.id);
  assert.throws(
    () => queue.enqueue({ type: 'profile.quick.start', payload: {}, idempotencyKey: 'same-1' }),
    /another job type/
  );
});

test('queued jobs can be cancelled but running jobs cannot', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const registry = {
    validate: (_type, payload) => payload,
    run: async () => gate
  };
  const queue = new JobQueue({ registry, concurrency: 1 });
  const running = queue.enqueue({ type: 'test', payload: {} }).job;
  const queued = queue.enqueue({ type: 'test', payload: {} }).job;
  await waitFor(() => queue.get(running.id)?.status === 'running');
  assert.throws(() => queue.cancel(running.id), /cannot be cancelled safely/);
  assert.equal(queue.cancel(queued.id).status, 'cancelled');
  release({ ok: true });
  await waitFor(() => queue.get(running.id)?.status === 'succeeded');
});
