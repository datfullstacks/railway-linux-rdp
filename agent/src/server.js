import crypto from 'node:crypto';
import http from 'node:http';
import { AgentError, publicError } from './errors.js';

function sendJson(res, status, body, headers = {}) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(data),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...headers
  });
  res.end(data);
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ''), 'utf8');
  const b = Buffer.from(String(right || ''), 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function providedToken(req) {
  const direct = req.headers['x-agent-token'];
  if (typeof direct === 'string' && direct) return direct;
  const authorization = req.headers.authorization;
  const match = typeof authorization === 'string' ? authorization.match(/^Bearer\s+(.+)$/i) : null;
  return match ? match[1] : '';
}

async function readJson(req, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) {
      throw new AgentError('BODY_TOO_LARGE', 'Request body is too large', { status: 413 });
    }
    chunks.push(chunk);
  }
  if (size === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new AgentError('JSON_INVALID', 'Request body must be valid JSON', { status: 400 });
  }
}

function routeJobId(pathname) {
  const match = pathname.match(/^\/v1\/jobs\/(mlx_[0-9a-f-]+)$/i);
  return match ? match[1] : null;
}

export function createAgentServer({ config, launcher, queue, registry, sessions, browserProxy }) {
  let shuttingDown = false;
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', 'http://multilogin-agent.local');
      if (req.method === 'GET' && url.pathname === '/livez') {
        return sendJson(res, shuttingDown ? 503 : 200, { ok: !shuttingDown });
      }
      if (req.method === 'GET' && url.pathname === '/readyz') {
        if (shuttingDown) return sendJson(res, 503, { ok: false });
        try {
          await launcher.health({ timeoutMs: config.readinessTimeoutMs });
          return sendJson(res, 200, { ok: true });
        } catch {
          return sendJson(res, 503, { ok: false });
        }
      }

      if (browserProxy.matches(req.url)) {
        return browserProxy.proxyHttp(req, res);
      }

      if (!safeEqual(providedToken(req), config.apiToken)) {
        return sendJson(res, 401, { error: { code: 'UNAUTHORIZED', message: 'Unauthorized' } });
      }

      if (req.method === 'GET' && url.pathname === '/v1/status') {
        let launcherReady = false;
        try {
          await launcher.health({ timeoutMs: config.readinessTimeoutMs });
          launcherReady = true;
        } catch {}
        return sendJson(res, 200, {
          ok: true,
          launcherReady,
          automationTokenConfigured: Boolean(config.automationToken),
          queue: queue.stats(),
          browserSessions: sessions.count(),
          supportedJobTypes: registry.types,
          time: new Date().toISOString()
        });
      }

      if (req.method === 'GET' && url.pathname === '/v1/jobs') {
        const limit = Math.min(100, Math.max(1, Number.parseInt(url.searchParams.get('limit') || '50', 10) || 50));
        return sendJson(res, 200, { jobs: queue.list(limit) });
      }

      if (req.method === 'POST' && url.pathname === '/v1/jobs') {
        const body = await readJson(req, config.bodyLimitBytes);
        const queued = queue.enqueue({
          type: body.type,
          payload: body.payload,
          idempotencyKey: req.headers['idempotency-key']
        });
        return sendJson(res, queued.replayed ? 200 : 202, {
          job: queued.job,
          replayed: queued.replayed
        }, { Location: `/v1/jobs/${queued.job.id}` });
      }

      const jobId = routeJobId(url.pathname);
      if (jobId && req.method === 'GET') {
        const job = queue.get(jobId);
        return job
          ? sendJson(res, 200, { job })
          : sendJson(res, 404, { error: { code: 'JOB_NOT_FOUND', message: 'Job not found' } });
      }
      if (jobId && req.method === 'DELETE') {
        const job = queue.cancel(jobId);
        return job
          ? sendJson(res, 200, { job })
          : sendJson(res, 404, { error: { code: 'JOB_NOT_FOUND', message: 'Job not found' } });
      }

      return sendJson(res, 404, { error: { code: 'NOT_FOUND', message: 'Not found' } });
    } catch (error) {
      const status = error instanceof AgentError ? error.status : 500;
      return sendJson(res, status, { error: publicError(error) });
    }
  });

  server.requestTimeout = 70000;
  server.headersTimeout = 10000;
  server.keepAliveTimeout = 5000;
  server.on('upgrade', (req, socket, head) => browserProxy.proxyUpgrade(req, socket, head));

  return {
    server,
    async shutdown() {
      if (shuttingDown) return;
      shuttingDown = true;
      browserProxy.close();
      await new Promise((resolve) => server.close(resolve));
      await queue.shutdown();
    }
  };
}
