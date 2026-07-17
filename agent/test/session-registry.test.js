import assert from 'node:assert/strict';
import test from 'node:test';
import { SessionRegistry } from '../src/session-registry.js';

test('session registry exposes a capability path without exposing the local port', () => {
  const sessions = new SessionRegistry();
  const created = sessions.create({
    profileId: 'profile-1',
    port: 45678,
    automation: 'playwright',
    headless: false
  });
  assert.match(created.sessionId, /^mlxs_/);
  assert.match(created.connectionPath, /^\/v1\/browser\/mlxs_[^/]+\/[A-Za-z0-9_-]{40,}$/);
  assert.doesNotMatch(JSON.stringify(created), /45678/);

  const [, , , id, capability] = created.connectionPath.split('/');
  const internal = sessions.resolveCapability(id, capability);
  assert.equal(internal.port, 45678);
  assert.equal(sessions.resolveCapability(id, `${capability}x`), null);
});

test('session registry resolves stop requests and removes every profile capability', () => {
  const sessions = new SessionRegistry();
  const first = sessions.create({ profileId: 'profile-1', port: 1111, automation: 'playwright' });
  sessions.create({ profileId: 'profile-1', port: 2222, automation: 'playwright' });
  assert.equal(sessions.resolveProfile({ sessionId: first.sessionId }), 'profile-1');
  assert.equal(sessions.removeByProfile('profile-1').length, 2);
  assert.equal(sessions.count(), 0);
  assert.throws(() => sessions.resolveProfile({ sessionId: first.sessionId }), /not found/);
});
