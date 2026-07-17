import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { createBrowserProxy } from '../src/browser-proxy.js';
import { SessionRegistry } from '../src/session-registry.js';

async function listen(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return server.address().port;
}

test('browser proxy hides local ports and rewrites CDP websocket endpoints', async (t) => {
  const browser = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({
      Browser: 'Mimic/Test',
      webSocketDebuggerUrl: `ws://127.0.0.1:${browser.address().port}/devtools/browser/abc`
    }));
  });
  const browserPort = await listen(browser);
  t.after(() => new Promise((resolve) => browser.close(resolve)));

  const sessions = new SessionRegistry();
  const registered = sessions.create({
    profileId: 'profile-1',
    port: browserPort,
    automation: 'playwright'
  });
  const proxy = createBrowserProxy(sessions);
  const agent = http.createServer((req, res) => {
    if (proxy.matches(req.url)) return proxy.proxyHttp(req, res);
    res.writeHead(404).end();
  });
  agent.on('upgrade', (req, socket, head) => proxy.proxyUpgrade(req, socket, head));
  const agentPort = await listen(agent);
  t.after(() => new Promise((resolve) => agent.close(resolve)));

  const response = await fetch(`http://127.0.0.1:${agentPort}${registered.connectionPath}/json/version`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(
    body.webSocketDebuggerUrl,
    `ws://127.0.0.1:${agentPort}${registered.connectionPath}/devtools/browser/abc`
  );
  assert.doesNotMatch(JSON.stringify(body), new RegExp(String(browserPort)));
});

test('browser proxy rejects invalid capabilities before connecting locally', async (t) => {
  const sessions = new SessionRegistry();
  const registered = sessions.create({
    profileId: 'profile-1',
    port: 65534,
    automation: 'selenium'
  });
  const proxy = createBrowserProxy(sessions);
  const agent = http.createServer((req, res) => proxy.proxyHttp(req, res));
  const agentPort = await listen(agent);
  t.after(() => new Promise((resolve) => agent.close(resolve)));

  const badPath = registered.connectionPath.replace(/.$/, 'x');
  const response = await fetch(`http://127.0.0.1:${agentPort}${badPath}/status`);
  assert.equal(response.status, 404);
  assert.equal((await response.json()).error.code, 'SESSION_NOT_FOUND');
});

test('browser proxy waits for a delayed DevTools listener', async (t) => {
  const reservation = http.createServer();
  const browserPort = await listen(reservation);
  await new Promise((resolve) => reservation.close(resolve));

  const sessions = new SessionRegistry();
  const registered = sessions.create({
    profileId: 'saved-profile',
    port: browserPort,
    automation: 'playwright'
  });
  const proxy = createBrowserProxy(sessions);
  const agent = http.createServer((req, res) => proxy.proxyHttp(req, res));
  const agentPort = await listen(agent);
  t.after(() => new Promise((resolve) => agent.close(resolve)));
  t.after(() => proxy.close());

  const browser = http.createServer((_req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ webSocketDebuggerUrl: `ws://127.0.0.1:${browserPort}/devtools/browser/delayed` }));
  });
  t.after(() => new Promise((resolve) => browser.close(resolve)));
  setTimeout(() => browser.listen(browserPort, '127.0.0.1'), 150);

  const response = await fetch(`http://127.0.0.1:${agentPort}${registered.connectionPath}/json/version`);
  assert.equal(response.status, 200);
  assert.match((await response.json()).webSocketDebuggerUrl, /\/devtools\/browser\/delayed$/);
});

test('browser proxy falls back to an IPv6 loopback DevTools listener', async (t) => {
  const browser = http.createServer((_req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ webSocketDebuggerUrl: `ws://[::1]:${browser.address().port}/devtools/browser/ipv6` }));
  });
  try {
    await new Promise((resolve, reject) => {
      browser.once('error', reject);
      browser.listen(0, '::1', resolve);
    });
  } catch {
    t.skip('IPv6 loopback is unavailable');
    return;
  }
  t.after(() => new Promise((resolve) => browser.close(resolve)));

  const sessions = new SessionRegistry();
  const registered = sessions.create({
    profileId: 'saved-ipv6-profile',
    port: browser.address().port,
    automation: 'playwright'
  });
  const proxy = createBrowserProxy(sessions);
  const agent = http.createServer((req, res) => proxy.proxyHttp(req, res));
  const agentPort = await listen(agent);
  t.after(() => new Promise((resolve) => agent.close(resolve)));
  t.after(() => proxy.close());

  const response = await fetch(`http://127.0.0.1:${agentPort}${registered.connectionPath}/json/version`);
  assert.equal(response.status, 200);
  assert.match((await response.json()).webSocketDebuggerUrl, /\/devtools\/browser\/ipv6$/);
});
