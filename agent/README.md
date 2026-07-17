# Multilogin Agent

`multilogin-agent` is a private, authenticated control plane for the Multilogin
Launcher and the browser processes running inside the RDP container. It does
not expose arbitrary shell execution.

## Runtime contract

The agent listens on port `8787` by default. Keep this port private; the RDP
TCP proxy must continue to target only port `3389`.

Required Railway variables:

| Variable | Purpose |
| --- | --- |
| `MULTILOGIN_AGENT_TOKEN` | Shared secret used by Canva, Claude, and GPT workers. Minimum 32 characters. |
| `MULTILOGIN_TOKEN` | Multilogin workspace Automation Token used by the local Launcher API. Optional when `SIEUAPP_SETTINGS_JSON_BASE64` contains the same token. |
| `SIEUAPP_SETTINGS_JSON_BASE64` | Existing sieuapp settings; use a Railway reference to avoid copying the Automation Token. |

Optional variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `MULTILOGIN_AGENT_PORT` | `8787` | Private HTTP port. |
| `MULTILOGIN_AGENT_BIND` | `::` | Bind address. |
| `MLX_LAUNCHER` | `https://launcher.mlx.yt:45001` | Local Multilogin Launcher URL. |
| `MULTILOGIN_AGENT_CONCURRENCY` | `1` | Concurrent profile operations; keep this at `1` initially. |
| `MULTILOGIN_AGENT_MAX_BACKLOG` | `50` | Maximum queued and running jobs. |
| `MULTILOGIN_AGENT_JOB_RETENTION_MS` | `900000` | Terminal job retention in memory. |

The Supervisor start wrapper deliberately leaves the agent disabled when
`MULTILOGIN_AGENT_TOKEN` is absent. RDP continues to run in that state.

## Private URL

Other services in the same Railway project can reach the agent at:

```text
http://railway-linux-rdp.railway.internal:8787
```

Do not generate an HTTP public domain for this port.

## HTTP API

The liveness and readiness probes do not require authentication:

```text
GET /livez
GET /readyz
```

Readiness is `503` until the local Multilogin Launcher is running. All `/v1`
endpoints require either:

```text
Authorization: Bearer <MULTILOGIN_AGENT_TOKEN>
```

or:

```text
X-Agent-Token: <MULTILOGIN_AGENT_TOKEN>
```

Agent endpoints:

```text
GET    /v1/status
GET    /v1/jobs
POST   /v1/jobs
GET    /v1/jobs/:id
DELETE /v1/jobs/:id
```

Supported job types:

```text
launcher.health
profile.saved.start
profile.quick.start
profile.stop
```

Use an `Idempotency-Key` header for operations that must not be submitted
twice. The key is retained for the lifetime of the job record.

### Start a saved profile

```json
{
  "type": "profile.saved.start",
  "payload": {
    "folderId": "folder-id",
    "profileId": "profile-id",
    "automation": "playwright",
    "headless": false
  }
}
```

### Start a quick profile

```json
{
  "type": "profile.quick.start",
  "payload": {
    "browserType": "mimic",
    "osType": "windows",
    "automation": "selenium",
    "headless": true
  }
}
```

A successful start job returns a browser session like:

```json
{
  "sessionId": "mlxs_...",
  "profileId": "...",
  "automation": "playwright",
  "connectionPath": "/v1/browser/mlxs_.../<capability>"
}
```

The worker appends `connectionPath` to the private agent URL and uses the
result as its Playwright CDP or Selenium server URL. The capability is scoped
to that browser session and is removed after `profile.stop` succeeds. Never
log this URL.

### Stop a profile

Prefer stopping by agent session ID:

```json
{
  "type": "profile.stop",
  "payload": {
    "sessionId": "mlxs_..."
  }
}
```

Stopping by `profileId` is also supported. Running queue jobs cannot be
cancelled safely; queued jobs can be cancelled with `DELETE /v1/jobs/:id`.

## Security properties

- No arbitrary command or script endpoint.
- Strict allowlist of job types and request fields.
- Constant-time agent-token comparison.
- Local Launcher TLS verification is relaxed only for known loopback launcher
  hostnames.
- Browser ports stay bound to loopback and are exposed only through a
  per-session capability path.
- Job payloads are removed from memory when a job finishes.
- Queue concurrency defaults to one to avoid profile collisions.

Jobs and browser session mappings are held in memory. A container restart
invalidates outstanding job IDs and browser capability paths, so callers must
treat interrupted operations as uncertain and verify live state before retrying.

## Tests

```bash
cd agent
npm test
```
