import http from 'node:http';
import net from 'node:net';

const MAX_PROXY_RESPONSE_BYTES = 2 * 1024 * 1024;

function parseBrowserRoute(rawUrl) {
  const url = new URL(rawUrl || '/', 'http://multilogin-agent.local');
  const match = url.pathname.match(/^\/v1\/browser\/(mlxs_[0-9a-f-]+)\/([A-Za-z0-9_-]{40,})(\/.*)?$/i);
  if (!match) return null;
  return {
    sessionId: match[1],
    capability: match[2],
    targetPath: `${match[3] || '/'}${url.search}`,
    prefix: `/v1/browser/${match[1]}/${match[2]}`
  };
}

function targetHeaders(headers, port) {
  const copy = { ...headers, host: `127.0.0.1:${port}` };
  delete copy.authorization;
  delete copy['x-agent-token'];
  delete copy['idempotency-key'];
  return copy;
}

function writeProxyError(res, status, code) {
  if (res.headersSent) return res.destroy();
  const data = JSON.stringify({ error: { code, message: code === 'SESSION_NOT_FOUND' ? 'Browser session not found' : 'Browser proxy failed' } });
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(data),
    'Cache-Control': 'no-store'
  });
  res.end(data);
}

function rewriteDebuggerUrls(text, requestHost, session, route) {
  if (!text.includes('webSocketDebuggerUrl') && !text.includes(`:${session.port}`)) return text;
  const browserBase = `ws://${requestHost}${route.prefix}`;
  return text.replace(
    new RegExp(`ws:\\/\\/(?:127\\.0\\.0\\.1|localhost|0\\.0\\.0\\.0):${session.port}`, 'gi'),
    browserBase
  );
}

export function createBrowserProxy(sessionRegistry) {
  const upgradedSockets = new Set();
  return {
    matches(rawUrl) {
      return Boolean(parseBrowserRoute(rawUrl));
    },

    proxyHttp(req, res) {
      const route = parseBrowserRoute(req.url);
      const session = route && sessionRegistry.resolveCapability(route.sessionId, route.capability);
      if (!route || !session) return writeProxyError(res, 404, 'SESSION_NOT_FOUND');

      const target = http.request({
        hostname: '127.0.0.1',
        port: session.port,
        path: route.targetPath,
        method: req.method,
        headers: targetHeaders(req.headers, session.port)
      }, (targetResponse) => {
        const chunks = [];
        let size = 0;
        targetResponse.on('data', (chunk) => {
          size += chunk.length;
          if (size > MAX_PROXY_RESPONSE_BYTES) {
            target.destroy(new Error('Browser proxy response too large'));
            return;
          }
          chunks.push(chunk);
        });
        targetResponse.on('end', () => {
          if (res.destroyed) return;
          let body = Buffer.concat(chunks);
          const contentType = String(targetResponse.headers['content-type'] || '');
          if (/json|text/i.test(contentType)) {
            body = Buffer.from(rewriteDebuggerUrls(
              body.toString('utf8'),
              req.headers.host || 'railway-linux-rdp.railway.internal:8787',
              session,
              route
            ));
          }
          const headers = { ...targetResponse.headers, 'content-length': body.length };
          delete headers['transfer-encoding'];
          res.writeHead(targetResponse.statusCode || 502, headers);
          res.end(body);
        });
      });
      target.setTimeout(70000, () => target.destroy(new Error('Browser proxy timeout')));
      target.on('error', () => writeProxyError(res, 502, 'BROWSER_PROXY_FAILED'));
      req.pipe(target);
      return undefined;
    },

    proxyUpgrade(req, socket, head) {
      const route = parseBrowserRoute(req.url);
      const session = route && sessionRegistry.resolveCapability(route.sessionId, route.capability);
      if (!route || !session) {
        socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
        return;
      }

      const target = net.connect(session.port, '127.0.0.1');
      upgradedSockets.add(socket);
      upgradedSockets.add(target);
      const forget = () => {
        upgradedSockets.delete(socket);
        upgradedSockets.delete(target);
      };
      socket.once('close', forget);
      target.once('close', forget);
      target.once('connect', () => {
        const headers = targetHeaders(req.headers, session.port);
        const lines = [`${req.method || 'GET'} ${route.targetPath} HTTP/${req.httpVersion || '1.1'}`];
        for (const [name, value] of Object.entries(headers)) {
          if (Array.isArray(value)) {
            for (const item of value) lines.push(`${name}: ${item}`);
          } else if (value != null) {
            lines.push(`${name}: ${value}`);
          }
        }
        target.write(`${lines.join('\r\n')}\r\n\r\n`);
        if (head?.length) target.write(head);
        socket.pipe(target).pipe(socket);
      });
      target.once('error', () => {
        if (!socket.destroyed) socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n');
      });
      socket.once('error', () => target.destroy());
    },

    close() {
      for (const socket of upgradedSockets) socket.destroy();
      upgradedSockets.clear();
    }
  };
}
