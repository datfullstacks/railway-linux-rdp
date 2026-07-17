import assert from 'node:assert/strict';
import test from 'node:test';
import { createJobRegistry } from '../src/job-registry.js';
import { JobQueue } from '../src/job-queue.js';
import { createAgentServer } from '../src/server.js';
import { SessionRegistry } from '../src/session-registry.js';
import { createBrowserProxy } from '../src/browser-proxy.js';

const API_TOKEN = 'z'.repeat(48);

async function fixture() {
  const launcher = {
    health: async () => ({ ok: true }),
    createSavedProfile: async (payload) => ({ profileId: 'replacement-profile', folderId: payload.folderId, proxy: false }),
    startSavedProfile: async (payload) => ({ profileId: payload.profileId, port: 12345 }),
    startQuickProfile: async () => ({ profileId: 'quick-1', port: 23456 }),
    validateProxy: async () => ({ status: { http_code: 200 }, data: { ip: '203.0.113.10' } }),
    stopProfile: async (payload) => ({ profileId: payload.profileId, stopped: true })
  };
  const sessions = new SessionRegistry();
  const browserProxy = createBrowserProxy(sessions);
  const registry = createJobRegistry(launcher, sessions);
  const queue = new JobQueue({ registry, retentionMs: 60000 });
  const config = {
    apiToken: API_TOKEN,
    automationToken: 'configured',
    readinessTimeoutMs: 100,
    bodyLimitBytes: 4096
  };
  const app = createAgentServer({ config, launcher, queue, registry, sessions, browserProxy });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const address = app.server.address();
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    app
  };
}

async function waitForJob(baseUrl, id) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const response = await fetch(`${baseUrl}/v1/jobs/${id}`, {
      headers: { Authorization: `Bearer ${API_TOKEN}` }
    });
    const body = await response.json();
    if (['succeeded', 'failed'].includes(body.job.status)) return body.job;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error('Timed out waiting for job');
}

test('server exposes unauthenticated probes and protects agent details', async (t) => {
  const fx = await fixture();
  t.after(() => fx.app.shutdown());
  assert.equal((await fetch(`${fx.baseUrl}/livez`)).status, 200);
  assert.equal((await fetch(`${fx.baseUrl}/readyz`)).status, 200);
  assert.equal((await fetch(`${fx.baseUrl}/v1/status`)).status, 401);

  const status = await fetch(`${fx.baseUrl}/v1/status`, {
    headers: { 'X-Agent-Token': API_TOKEN }
  });
  assert.equal(status.status, 200);
  const body = await status.json();
  assert.equal(body.launcherReady, true);
  assert.ok(body.supportedJobTypes.includes('profile.saved.start'));
  assert.ok(body.supportedJobTypes.includes('profile.saved.create'));
});

test('server queues, polls, and idempotently replays profile jobs', async (t) => {
  const fx = await fixture();
  t.after(() => fx.app.shutdown());
  const request = {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${API_TOKEN}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': 'saved-profile-1'
    },
    body: JSON.stringify({
      type: 'profile.saved.start',
      payload: { folderId: 'folder-1', profileId: 'profile-1' }
    })
  };
  const accepted = await fetch(`${fx.baseUrl}/v1/jobs`, request);
  assert.equal(accepted.status, 202);
  const acceptedBody = await accepted.json();
  const job = await waitForJob(fx.baseUrl, acceptedBody.job.id);
  assert.equal(job.status, 'succeeded');
  assert.equal(job.result.profileId, 'profile-1');
  assert.match(job.result.sessionId, /^mlxs_/);
  assert.match(job.result.connectionPath, /^\/v1\/browser\/mlxs_/);

  const replay = await fetch(`${fx.baseUrl}/v1/jobs`, request);
  assert.equal(replay.status, 200);
  assert.equal((await replay.json()).replayed, true);
});

test('server rejects unsupported fields instead of accepting arbitrary commands', async (t) => {
  const fx = await fixture();
  t.after(() => fx.app.shutdown());
  const response = await fetch(`${fx.baseUrl}/v1/jobs`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${API_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ type: 'profile.stop', payload: { profileId: 'one', command: 'rm -rf /' } })
  });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error.code, 'PAYLOAD_INVALID');
});
