import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { LauncherClient } from '../src/launcher-client.js';

async function fixture() {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    requests.push({
      method: req.method,
      url: req.url,
      authorization: req.headers.authorization || null,
      body: Buffer.concat(chunks).toString('utf8')
    });
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/api/v1/version') return res.end(JSON.stringify({ version: 'test' }));
    if (req.url === '/profile/create') {
      return res.end(JSON.stringify({
        status: { http_code: 200 },
        data: { profile_id: 'replacement-profile' }
      }));
    }
    if (req.url.startsWith('/api/v2/profile/f/')) return res.end(JSON.stringify({ data: { port: 12345 } }));
    if (req.url === '/api/v3/profile/quick') {
      return res.end(JSON.stringify({ data: { id: 'quick-1', port: 23456 } }));
    }
    if (req.url === '/api/v1/proxy/validate') {
      return res.end(JSON.stringify({
        status: { http_code: 200 },
        data: {
          ip: '203.0.113.10',
          country_code: 'US',
          country: 'United States',
          password: 'must-not-return'
        }
      }));
    }
    if (req.url === '/api/v1/profile/stop/p/already-stopped') {
      res.statusCode = 500;
      return res.end(JSON.stringify({ status: { http_code: 500, message: 'Profile already stopped' } }));
    }
    if (req.url.startsWith('/api/v1/profile/stop/p/')) return res.end(JSON.stringify({ ok: true }));
    res.statusCode = 404;
    return res.end(JSON.stringify({ message: 'not found' }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  return {
    requests,
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve) => server.close(resolve))
  };
}

test('launcher client performs authenticated allowlisted profile operations', async (t) => {
  const fx = await fixture();
  t.after(fx.close);
  const client = new LauncherClient({
    baseUrl: fx.baseUrl,
    apiBaseUrl: fx.baseUrl,
    automationToken: 'workspace-token',
    timeoutMs: 1000
  });

  assert.deepEqual(await client.health(), { ok: true });
  assert.deepEqual(
    await client.startSavedProfile({ folderId: 'folder-1', profileId: 'profile-1', headless: true }),
    { profileId: 'profile-1', port: 12345, automation: 'playwright', headless: true }
  );
  assert.deepEqual(
    await client.createSavedProfile({ folderId: 'folder-1', name: 'Canva owner@example.com' }),
    {
      profileId: 'replacement-profile',
      folderId: 'folder-1',
      name: 'Canva owner@example.com',
      browserType: 'mimic',
      osType: 'windows',
      proxy: false
    }
  );
  assert.deepEqual(
    await client.startQuickProfile({ automation: 'selenium', customStartUrls: ['https://example.com'] }),
    { profileId: 'quick-1', port: 23456, automation: 'selenium', headless: false }
  );
  assert.deepEqual(await client.stopProfile({ profileId: 'quick-1' }), {
    profileId: 'quick-1',
    stopped: true
  });
  assert.deepEqual(await client.stopProfile({ profileId: 'already-stopped' }), {
    profileId: 'already-stopped',
    stopped: true,
    alreadyStopped: true
  });
  const validation = await client.validateProxy({
    proxy: {
      type: 'http',
      host: 'proxy.example',
      port: 8080,
      username: 'user',
      password: 'secret'
    }
  });
  assert.deepEqual(validation, {
    status: { http_code: 200 },
    data: { ip: '203.0.113.10', country_code: 'US', country: 'United States' }
  });
  assert.doesNotMatch(JSON.stringify(validation), /secret|must-not-return/);

  assert.equal(fx.requests[0].authorization, null);
  assert.equal(fx.requests[1].authorization, 'Bearer workspace-token');
  const createBody = JSON.parse(fx.requests[2].body);
  assert.equal(createBody.parameters.flags.proxy_masking, 'disabled');
  assert.equal(createBody.parameters.proxy, undefined);
  const quickBody = JSON.parse(fx.requests[3].body);
  assert.equal(quickBody.automation, 'selenium');
  assert.deepEqual(quickBody.parameters.custom_start_urls, ['https://example.com']);
});

test('launcher client does not run profile jobs without an automation token', async (t) => {
  const fx = await fixture();
  t.after(fx.close);
  const client = new LauncherClient({ baseUrl: fx.baseUrl, timeoutMs: 1000 });
  await assert.rejects(() => client.stopProfile({ profileId: 'quick-1' }), /MULTILOGIN_TOKEN/);
});

test('launcher client validates identifiers and proxy secrets before network calls', async (t) => {
  const fx = await fixture();
  t.after(fx.close);
  const client = new LauncherClient({
    baseUrl: fx.baseUrl,
    apiBaseUrl: fx.baseUrl,
    automationToken: 'workspace-token',
    timeoutMs: 1000
  });
  await assert.rejects(
    () => client.startSavedProfile({ folderId: '../bad', profileId: 'profile-1' }),
    /folderId is invalid/
  );
  await assert.rejects(
    () => client.startQuickProfile({ proxy: { type: 'http', host: 'bad host', port: 8080 } }),
    /proxy configuration is invalid/
  );
  await assert.rejects(
    () => client.createSavedProfile({ folderId: 'folder-1', name: 'bad\nname' }),
    /profile name is invalid/
  );
});
