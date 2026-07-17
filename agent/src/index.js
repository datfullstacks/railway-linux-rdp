import { loadConfig } from './config.js';
import { LauncherClient } from './launcher-client.js';
import { createJobRegistry } from './job-registry.js';
import { JobQueue } from './job-queue.js';
import { createAgentServer } from './server.js';
import { SessionRegistry } from './session-registry.js';
import { createBrowserProxy } from './browser-proxy.js';

const config = loadConfig();
const launcher = new LauncherClient({
  baseUrl: config.launcherUrl,
  automationToken: config.automationToken,
  timeoutMs: config.launcherTimeoutMs
});
const sessions = new SessionRegistry();
const browserProxy = createBrowserProxy(sessions);
const registry = createJobRegistry(launcher, sessions);
const queue = new JobQueue({
  registry,
  concurrency: config.concurrency,
  maxBacklog: config.maxBacklog,
  maxStoredJobs: config.maxStoredJobs,
  retentionMs: config.jobRetentionMs
});
const app = createAgentServer({ config, launcher, queue, registry, sessions, browserProxy });

app.server.listen(config.port, config.bind, () => {
  console.log(`[multilogin-agent] listening on http://${config.bind}:${config.port}`);
  console.log(`[multilogin-agent] concurrency=${config.concurrency} maxBacklog=${config.maxBacklog}`);
});

let stopping = false;
async function stop(signal) {
  if (stopping) return;
  stopping = true;
  console.log(`[multilogin-agent] ${signal} received; draining active jobs`);
  const force = setTimeout(() => process.exit(1), 65000);
  force.unref();
  await app.shutdown();
  clearTimeout(force);
  process.exit(0);
}

process.once('SIGTERM', () => void stop('SIGTERM'));
process.once('SIGINT', () => void stop('SIGINT'));
