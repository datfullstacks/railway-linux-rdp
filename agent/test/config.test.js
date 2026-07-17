import assert from 'node:assert/strict';
import test from 'node:test';
import { loadConfig } from '../src/config.js';

const TOKEN = 'a'.repeat(48);

test('config uses safe single-job defaults', () => {
  const config = loadConfig({ MULTILOGIN_AGENT_TOKEN: TOKEN });
  assert.equal(config.port, 8787);
  assert.equal(config.concurrency, 1);
  assert.equal(config.maxBacklog, 50);
  assert.equal(config.launcherUrl, 'https://launcher.mlx.yt:45001');
});

test('config rejects missing, weak, and placeholder agent tokens', () => {
  assert.throws(() => loadConfig({}), /MULTILOGIN_AGENT_TOKEN/);
  assert.throws(() => loadConfig({ MULTILOGIN_AGENT_TOKEN: 'short' }), /at least 32/);
  assert.throws(
    () => loadConfig({ MULTILOGIN_AGENT_TOKEN: `replace-${'x'.repeat(40)}` }),
    /unique secret/
  );
});

test('config rejects unsafe numeric values and non-http launcher URLs', () => {
  assert.throws(
    () => loadConfig({ MULTILOGIN_AGENT_TOKEN: TOKEN, MULTILOGIN_AGENT_CONCURRENCY: '0' }),
    /CONCURRENCY/
  );
  assert.throws(
    () => loadConfig({ MULTILOGIN_AGENT_TOKEN: TOKEN, MLX_LAUNCHER: 'file:///tmp/launcher' }),
    /HTTP or HTTPS/
  );
});
