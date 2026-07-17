import { AgentError } from './errors.js';

function objectPayload(payload) {
  if (payload == null) return {};
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new AgentError('PAYLOAD_INVALID', 'payload must be a JSON object', { status: 400 });
  }
  return payload;
}

function onlyKeys(payload, allowed) {
  const unknown = Object.keys(payload).filter((key) => !allowed.includes(key));
  if (unknown.length) {
    throw new AgentError('PAYLOAD_INVALID', `unsupported payload fields: ${unknown.join(', ')}`, { status: 400 });
  }
  return payload;
}

export function createJobRegistry(launcher, sessions) {
  const jobs = new Map([
    ['launcher.health', {
      validate(payload) {
        onlyKeys(objectPayload(payload), []);
        return {};
      },
      run: (_payload, context) => launcher.health(context)
    }],
    ['profile.saved.start', {
      validate(payload) {
        return onlyKeys(objectPayload(payload), ['folderId', 'profileId', 'headless', 'automation']);
      },
      async run(payload, context) {
        const started = await launcher.startSavedProfile(payload, context);
        return sessions.create(started);
      }
    }],
    ['profile.quick.start', {
      validate(payload) {
        return onlyKeys(objectPayload(payload), [
          'browserType', 'osType', 'automation', 'headless', 'proxy', 'customStartUrls'
        ]);
      },
      async run(payload, context) {
        const started = await launcher.startQuickProfile(payload, context);
        return sessions.create(started);
      }
    }],
    ['profile.stop', {
      validate(payload) {
        const value = onlyKeys(objectPayload(payload), ['profileId', 'sessionId']);
        if (Boolean(value.profileId) === Boolean(value.sessionId)) {
          throw new AgentError('PAYLOAD_INVALID', 'provide exactly one of profileId or sessionId', { status: 400 });
        }
        return value;
      },
      async run(payload, context) {
        const profileId = sessions.resolveProfile(payload);
        const stopped = await launcher.stopProfile({ profileId }, context);
        sessions.removeByProfile(profileId);
        return stopped;
      }
    }]
  ]);

  return {
    types: [...jobs.keys()],
    validate(type, payload) {
      const job = jobs.get(type);
      if (!job) {
        throw new AgentError('JOB_TYPE_UNSUPPORTED', `unsupported job type: ${type}`, { status: 400 });
      }
      return job.validate(payload);
    },
    run(type, payload, context) {
      return jobs.get(type).run(payload, context);
    }
  };
}
