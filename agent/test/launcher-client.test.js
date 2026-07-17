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
    if (req.url.startsWith('/api/v2/profile/f/')) return res.end(JSON.stringify({ data: { port: 12345 } }));
    if (req.url === '/api/v3/profile/quick') {
      return res.end(JSON.stringify({ data: { id: 'quick-1', port: 23456 } }));
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
    automationToken: 'workspace-token',
    timeoutMs: 1000
  });

  assert.deepEqual(await client.health(), { ok: true });
  assert.deepEqual(
    await client.startSavedProfile({ folderId: 'folder-1', profileId: 'profile-1', headless: true }),
    { profileId: 'profile-1', port: 12345, automation: 'playwright', headless: true }
  );
  assert.deepEqual(
    await client.startQuickProfile({ automation: 'selenium', customStartUrls: ['https://example.com'] }),
    { profileId: 'quick-1', port: 23456, automation: 'selenium', headless: false }
  );
  assert.deepEqual(await client.stopProfile({ profileId: 'quick-1' }), {
    profileId: 'quick-1',
    stopped: true
  });

  assert.equal(fx.requests[0].authorization, null);
  assert.equal(fx.requests[1].authorization, 'Bearer workspace-token');
  const quickBody = JSON.parse(fx.requests[2].body);
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
});
