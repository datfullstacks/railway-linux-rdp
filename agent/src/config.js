import { AgentError } from './errors.js';

const PLACEHOLDER_SECRET = /^(replace|change|example|placeholder|secret|token|changeme)/i;

function integer(env, key, fallback, { min, max }) {
  const raw = env[key];
  const value = raw == null || raw === '' ? fallback : Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new AgentError('CONFIG_INVALID', `${key} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function strongSecret(value, key) {
  const secret = String(value || '').trim();
  if (secret.length < 32 || PLACEHOLDER_SECRET.test(secret)) {
    throw new AgentError('CONFIG_INVALID', `${key} must be a unique secret of at least 32 characters`);
  }
  return secret;
}

export function loadConfig(env = process.env) {
  const launcherUrl = String(env.MLX_LAUNCHER || 'https://launcher.mlx.yt:45001').replace(/\/+$/, '');
  let parsedLauncher;
  try {
    parsedLauncher = new URL(launcherUrl);
  } catch {
    throw new AgentError('CONFIG_INVALID', 'MLX_LAUNCHER must be an absolute HTTP or HTTPS URL');
  }
  if (!['http:', 'https:'].includes(parsedLauncher.protocol)) {
    throw new AgentError('CONFIG_INVALID', 'MLX_LAUNCHER must use HTTP or HTTPS');
  }

  return {
    bind: String(env.MULTILOGIN_AGENT_BIND || '::').trim(),
    port: integer(env, 'MULTILOGIN_AGENT_PORT', 8787, { min: 1, max: 65535 }),
    apiToken: strongSecret(env.MULTILOGIN_AGENT_TOKEN, 'MULTILOGIN_AGENT_TOKEN'),
    automationToken: String(env.MULTILOGIN_TOKEN || '').trim(),
    launcherUrl,
    launcherTimeoutMs: integer(env, 'MULTILOGIN_AGENT_LAUNCHER_TIMEOUT_MS', 60000, {
      min: 1000,
      max: 300000
    }),
    readinessTimeoutMs: integer(env, 'MULTILOGIN_AGENT_READY_TIMEOUT_MS', 2500, {
      min: 500,
      max: 15000
    }),
    concurrency: integer(env, 'MULTILOGIN_AGENT_CONCURRENCY', 1, { min: 1, max: 4 }),
    maxBacklog: integer(env, 'MULTILOGIN_AGENT_MAX_BACKLOG', 50, { min: 1, max: 500 }),
    maxStoredJobs: integer(env, 'MULTILOGIN_AGENT_MAX_STORED_JOBS', 200, { min: 10, max: 2000 }),
    jobRetentionMs: integer(env, 'MULTILOGIN_AGENT_JOB_RETENTION_MS', 900000, {
      min: 60000,
      max: 86400000
    }),
    bodyLimitBytes: integer(env, 'MULTILOGIN_AGENT_BODY_LIMIT_BYTES', 65536, {
      min: 4096,
      max: 1048576
    })
  };
}
