import http from 'node:http';
import https from 'node:https';
import { AgentError } from './errors.js';

const LOCAL_TLS_HOSTS = new Set(['launcher.mlx.yt', 'localhost', '127.0.0.1', '::1']);
const MAX_RESPONSE_BYTES = 1024 * 1024;

function launcherMessage(body, response) {
  const candidate = body?.status?.message || body?.message || response.statusMessage;
  return String(candidate || `Multilogin Launcher returned HTTP ${response.statusCode}`).slice(0, 300);
}

function parseBody(text) {
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

function cleanId(value, name) {
  const normalized = String(value || '').trim();
  if (!normalized || normalized.length > 200 || !/^[A-Za-z0-9._:-]+$/.test(normalized)) {
    throw new AgentError('PAYLOAD_INVALID', `${name} is invalid`, { status: 400 });
  }
  return normalized;
}

function cleanProfileName(value) {
  const normalized = String(value || '').trim();
  if (!normalized || normalized.length > 100 || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new AgentError('PAYLOAD_INVALID', 'profile name is invalid', { status: 400 });
  }
  return normalized;
}

function cleanProxy(proxy) {
  if (proxy == null) return null;
  if (!proxy || typeof proxy !== 'object' || Array.isArray(proxy)) {
    throw new AgentError('PAYLOAD_INVALID', 'proxy must be an object', { status: 400 });
  }
  const type = String(proxy.type || proxy.protocol || 'http').toLowerCase();
  const host = String(proxy.host || '').trim();
  const port = Number(proxy.port);
  const username = String(proxy.username || '');
  const password = String(proxy.password || '');
  if (!['http', 'https', 'socks5'].includes(type)
      || !host || host.length > 255 || /[\s/]/.test(host)
      || !Number.isInteger(port) || port < 1 || port > 65535
      || username.length > 512 || password.length > 2048) {
    throw new AgentError('PAYLOAD_INVALID', 'proxy configuration is invalid', { status: 400 });
  }
  return { type, host, port, username, password };
}

export class LauncherClient {
  constructor({ baseUrl, apiBaseUrl = 'https://api.multilogin.com', automationToken = '', timeoutMs = 60000 }) {
    this.baseUrl = new URL(baseUrl);
    this.apiBaseUrl = new URL(apiBaseUrl);
    this.automationToken = automationToken;
    this.timeoutMs = timeoutMs;
  }

  async request(pathname, { method = 'GET', body, authenticated = true, timeoutMs, signal, api = false } = {}) {
    if (authenticated && !this.automationToken) {
      throw new AgentError(
        'MULTILOGIN_TOKEN_REQUIRED',
        'MULTILOGIN_TOKEN is required for profile jobs',
        { status: 503 }
      );
    }

    const requestBaseUrl = api ? this.apiBaseUrl : this.baseUrl;
    const url = new URL(pathname, `${requestBaseUrl.toString().replace(/\/+$/, '')}/`);
    const serialized = body === undefined ? null : JSON.stringify(body);
    const headers = { Accept: 'application/json' };
    if (authenticated) headers.Authorization = `Bearer ${this.automationToken}`;
    if (serialized != null) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(serialized);
    }

    return new Promise((resolve, reject) => {
      const transport = url.protocol === 'https:' ? https : http;
      let settled = false;
      const fail = (error) => {
        if (settled) return;
        settled = true;
        reject(error);
      };
      const req = transport.request(url, {
        method,
        headers,
        ...(url.protocol === 'https:' && LOCAL_TLS_HOSTS.has(url.hostname.toLowerCase())
          ? { rejectUnauthorized: false }
          : {})
      }, (response) => {
        const chunks = [];
        let size = 0;
        response.on('data', (chunk) => {
          size += chunk.length;
          if (size > MAX_RESPONSE_BYTES) {
            req.destroy(new AgentError('LAUNCHER_RESPONSE_TOO_LARGE', 'Multilogin Launcher response was too large', {
              status: 502
            }));
            return;
          }
          chunks.push(chunk);
        });
        response.on('end', () => {
          if (settled) return;
          const parsed = parseBody(Buffer.concat(chunks).toString('utf8'));
          const httpCode = Number(parsed?.status?.http_code || response.statusCode || 500);
          if ((response.statusCode || 500) >= 400 || httpCode >= 400) {
            settled = true;
            reject(new AgentError(
              response.statusCode === 401 || response.statusCode === 403
                ? 'MULTILOGIN_AUTH_FAILED'
                : 'LAUNCHER_REQUEST_FAILED',
              response.statusCode === 401 || response.statusCode === 403
                ? 'Multilogin rejected the Automation Token'
                : launcherMessage(parsed, response),
              { status: response.statusCode === 401 || response.statusCode === 403 ? 401 : 502 }
            ));
            return;
          }
          settled = true;
          resolve(parsed);
        });
      });

      req.setTimeout(timeoutMs || this.timeoutMs, () => {
        req.destroy(new AgentError('LAUNCHER_TIMEOUT', 'Multilogin Launcher request timed out', {
          status: 504,
          retryable: true
        }));
      });
      req.on('error', (error) => {
        if (error instanceof AgentError) return fail(error);
        return fail(new AgentError('LAUNCHER_UNREACHABLE', 'Multilogin Launcher is not reachable', {
          status: 503,
          retryable: true
        }));
      });

      const abort = () => req.destroy(new AgentError('JOB_CANCELLED', 'Job was cancelled', { status: 409 }));
      if (signal) {
        if (signal.aborted) abort();
        else signal.addEventListener('abort', abort, { once: true });
      }
      if (serialized != null) req.write(serialized);
      req.end();
    });
  }

  async health({ timeoutMs, signal } = {}) {
    await this.request('/api/v1/version', { authenticated: false, timeoutMs, signal });
    return { ok: true };
  }

  async startSavedProfile({ folderId, profileId, headless = false, automation = 'playwright' }, context = {}) {
    const folder = cleanId(folderId, 'folderId');
    const profile = cleanId(profileId, 'profileId');
    const automationType = String(automation || 'playwright').toLowerCase();
    if (!['playwright', 'selenium'].includes(automationType)) {
      throw new AgentError('PAYLOAD_INVALID', 'automation must be playwright or selenium', { status: 400 });
    }
    const response = await this.request(
      `/api/v2/profile/f/${encodeURIComponent(folder)}/p/${encodeURIComponent(profile)}/start`
        + `?automation_type=${automationType}&headless_mode=${Boolean(headless)}`,
      { signal: context.signal }
    );
    const port = Number(response?.data?.port || response?.status?.message);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new AgentError('LAUNCHER_RESPONSE_INVALID', 'Saved profile did not return an automation port', {
        status: 502
      });
    }
    return { profileId: profile, port, automation: automationType, headless: Boolean(headless) };
  }

  async createSavedProfile({ folderId, name, browserType = 'mimic', osType = 'windows' }, context = {}) {
    const folder = cleanId(folderId, 'folderId');
    const profileName = cleanProfileName(name);
    const browser = String(browserType || 'mimic').toLowerCase();
    const os = String(osType || 'windows').toLowerCase();
    if (!['mimic', 'stealthfox'].includes(browser) || !['windows', 'macos', 'linux'].includes(os)) {
      throw new AgentError('PAYLOAD_INVALID', 'saved profile browser or OS type is invalid', { status: 400 });
    }
    const response = await this.request('/profile/create', {
      api: true,
      method: 'POST',
      body: {
        name: profileName,
        folder_id: folder,
        browser_type: browser,
        os_type: os,
        parameters: {
          flags: { proxy_masking: 'disabled' },
          storage: { is_local: false, save_service_worker: true }
        }
      },
      signal: context.signal
    });
    const profileId = response?.data?.profile_id || response?.data?.id;
    if (!profileId) {
      throw new AgentError('LAUNCHER_RESPONSE_INVALID', 'Created profile did not return a profile ID', {
        status: 502
      });
    }
    return {
      profileId: cleanId(profileId, 'profileId'),
      folderId: folder,
      name: profileName,
      browserType: browser,
      osType: os,
      proxy: false
    };
  }

  async startQuickProfile(payload = {}, context = {}) {
    const browserType = String(payload.browserType || 'mimic').toLowerCase();
    const osType = String(payload.osType || 'windows').toLowerCase();
    const automation = String(payload.automation || 'playwright').toLowerCase();
    if (!['mimic', 'stealthfox'].includes(browserType)
        || !['windows', 'macos', 'linux'].includes(osType)
        || !['playwright', 'selenium'].includes(automation)) {
      throw new AgentError('PAYLOAD_INVALID', 'quick profile browser, OS, or automation type is invalid', {
        status: 400
      });
    }
    const proxy = cleanProxy(payload.proxy);
    const customStartUrls = Array.isArray(payload.customStartUrls)
      ? payload.customStartUrls.map((value) => String(value)).filter(Boolean).slice(0, 5)
      : [];
    if (customStartUrls.some((value) => value.length > 2048 || !/^https?:\/\//i.test(value))) {
      throw new AgentError('PAYLOAD_INVALID', 'customStartUrls must contain HTTP or HTTPS URLs', { status: 400 });
    }
    const flags = {};
    if (proxy) flags.proxy_masking = 'custom';
    if (customStartUrls.length) flags.startup_behavior = 'custom';
    const parameters = { flags, proxy, fingerprint: {} };
    if (customStartUrls.length) parameters.custom_start_urls = customStartUrls;

    const response = await this.request('/api/v3/profile/quick', {
      method: 'POST',
      body: {
        browser_type: browserType,
        os_type: osType,
        automation,
        is_headless: Boolean(payload.headless),
        parameters
      },
      signal: context.signal
    });
    const profileId = response?.data?.id || response?.data?.profile_id;
    const port = Number(response?.data?.port);
    if (!profileId || !Number.isInteger(port) || port < 1 || port > 65535) {
      throw new AgentError('LAUNCHER_RESPONSE_INVALID', 'Quick profile did not return a profile ID and port', {
        status: 502
      });
    }
    return { profileId: String(profileId), port, automation, headless: Boolean(payload.headless) };
  }

  async validateProxy(payload = {}, context = {}) {
    const proxy = cleanProxy(payload.proxy);
    if (!proxy) {
      throw new AgentError('PAYLOAD_INVALID', 'proxy is required', { status: 400 });
    }
    const response = await this.request('/api/v1/proxy/validate', {
      method: 'POST',
      body: proxy,
      signal: context.signal
    });
    const data = response?.data || {};
    return {
      status: { http_code: Number(response?.status?.http_code || 200) },
      data: {
        ip: String(data.ip || ''),
        country_code: String(data.country_code || ''),
        country: String(data.country || '')
      }
    };
  }

  async stopProfile({ profileId }, context = {}) {
    const profile = cleanId(profileId, 'profileId');
    try {
      await this.request(`/api/v1/profile/stop/p/${encodeURIComponent(profile)}`, {
        signal: context.signal
      });
      return { profileId: profile, stopped: true };
    } catch (error) {
      const alreadyStopped = error?.code === 'LAUNCHER_REQUEST_FAILED'
        && /already (?:stopped|closed)|not (?:running|found)|does not exist|no active profile/i.test(String(error?.message || ''));
      if (!alreadyStopped) throw error;
      return { profileId: profile, stopped: true, alreadyStopped: true };
    }
  }
}
