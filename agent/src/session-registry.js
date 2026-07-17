import crypto from 'node:crypto';
import { AgentError } from './errors.js';

function publicSession(session) {
  return {
    sessionId: session.id,
    profileId: session.profileId,
    automation: session.automation,
    headless: session.headless,
    connectionPath: `/v1/browser/${session.id}/${session.capability}`,
    createdAt: session.createdAt
  };
}

export class SessionRegistry {
  constructor() {
    this.byId = new Map();
  }

  create({ profileId, port, automation, headless }) {
    if (!profileId || !Number.isInteger(port) || port < 1 || port > 65535) {
      throw new AgentError('SESSION_INVALID', 'Cannot register an invalid browser session');
    }
    const session = {
      id: `mlxs_${crypto.randomUUID()}`,
      capability: crypto.randomBytes(32).toString('base64url'),
      profileId: String(profileId),
      port,
      automation: String(automation || 'playwright'),
      headless: Boolean(headless),
      createdAt: new Date().toISOString()
    };
    this.byId.set(session.id, session);
    return publicSession(session);
  }

  get(id) {
    const session = this.byId.get(String(id || ''));
    return session ? publicSession(session) : null;
  }

  resolveCapability(id, capability) {
    const session = this.byId.get(String(id || ''));
    if (!session) return null;
    const supplied = Buffer.from(String(capability || ''), 'utf8');
    const expected = Buffer.from(session.capability, 'utf8');
    if (supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) return null;
    return { ...session };
  }

  resolveProfile({ profileId, sessionId }) {
    if (sessionId) {
      const session = this.byId.get(String(sessionId));
      if (!session) {
        throw new AgentError('SESSION_NOT_FOUND', 'Browser session not found', { status: 404 });
      }
      return session.profileId;
    }
    return String(profileId || '');
  }

  removeByProfile(profileId) {
    const removed = [];
    for (const session of this.byId.values()) {
      if (session.profileId !== String(profileId)) continue;
      this.byId.delete(session.id);
      removed.push(publicSession(session));
    }
    return removed;
  }

  count() {
    return this.byId.size;
  }
}
