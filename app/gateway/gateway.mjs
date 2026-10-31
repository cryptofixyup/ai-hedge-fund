import { createHmac, createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { Readable } from 'node:stream';

export const SESSION_COOKIE = '__Host-aihf_session';
export const SESSION_TTL_SECONDS = 8 * 60 * 60;
const MAX_LOGIN_BODY_BYTES = 16 * 1024;
const MAX_PROXY_BODY_BYTES = 20 * 1024 * 1024;
const HOP_BY_HOP_HEADERS = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade',
]);
const REQUEST_HEADERS_TO_DROP = new Set([
  ...HOP_BY_HOP_HEADERS, 'host', 'content-length', 'cookie', 'authorization',
  'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'x-real-ip',
]);
const RESPONSE_HEADERS_TO_DROP = new Set([
  ...HOP_BY_HOP_HEADERS, 'content-length', 'content-encoding', 'set-cookie', 'location',
]);

function requiredSecret(value, name) {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') < 32) {
    throw new Error(name + ' must be configured and contain at least 32 bytes');
  }
  return value;
}

function loadConfig(env) {
  const ownerPassword = requiredSecret(env.AI_HEDGE_FUND_OWNER_PASSWORD, 'AI_HEDGE_FUND_OWNER_PASSWORD');
  const sessionSecret = requiredSecret(env.AI_HEDGE_FUND_SESSION_SECRET, 'AI_HEDGE_FUND_SESSION_SECRET');
  const apiToken = requiredSecret(env.AI_HEDGE_FUND_API_TOKEN, 'AI_HEDGE_FUND_API_TOKEN');
  if (!env.AI_HEDGE_FUND_API_URL) {
    throw new Error('AI_HEDGE_FUND_API_URL service binding is missing');
  }

  let apiUrl;
  try {
    apiUrl = new URL(env.AI_HEDGE_FUND_API_URL);
  } catch {
    throw new Error('AI_HEDGE_FUND_API_URL must be a valid absolute URL');
  }
  if (!['https:', 'http:'].includes(apiUrl.protocol) || apiUrl.username || apiUrl.password) {
    throw new Error('AI_HEDGE_FUND_API_URL must be an HTTP(S) URL without embedded credentials');
  }
  return { ownerPassword, sessionSecret, apiToken, apiUrl };
}

function equalSecret(left, right) {
  const a = createHash('sha256').update(left, 'utf8').digest();
  const b = createHash('sha256').update(right, 'utf8').digest();
  return timingSafeEqual(a, b);
}

function signSession(secret, now = Math.floor(Date.now() / 1000)) {
  const payload = Buffer.from(JSON.stringify({
    iat: now,
    exp: now + SESSION_TTL_SECONDS,
    nonce: randomBytes(16).toString('base64url'),
  })).toString('base64url');
  const signature = createHmac('sha256', secret).update(payload).digest('base64url');
  return payload + '.' + signature;
}

function verifySession(token, secret, now = Math.floor(Date.now() / 1000)) {
  if (typeof token !== 'string') return false;
  const separator = token.lastIndexOf('.');
  if (separator <= 0 || separator === token.length - 1) return false;
  const payloadPart = token.slice(0, separator);
  const supplied = Buffer.from(token.slice(separator + 1), 'base64url');
  const expected = createHmac('sha256', secret).update(payloadPart).digest();
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return false;

  try {
    const payload = JSON.parse(Buffer.from(payloadPart, 'base64url').toString('utf8'));
    return Number.isInteger(payload.iat)
      && Number.isInteger(payload.exp)
      && typeof payload.nonce === 'string'
      && payload.iat <= now + 60
      && payload.exp > now
      && payload.exp > payload.iat
      && payload.exp - payload.iat <= SESSION_TTL_SECONDS;
  } catch {
    return false;
  }
}

function readCookie(cookieHeader, name) {
  for (const part of (cookieHeader || '').split(';')) {
    const separator = part.indexOf('=');
    if (separator >= 0 && part.slice(0, separator).trim() === name) {
      return part.slice(separator + 1).trim();
    }
  }
  return null;
}

function cookieHeader(value, maxAge) {
  return SESSION_COOKIE + '=' + value
    + '; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=' + maxAge;
}

function isSameOrigin(req) {
  if (!req.headers.origin) return false;
  try {
    const origin = new URL(req.headers.origin);
    const forwardedHost = req.headers['x-forwarded-host'];
    const requestHost = String(forwardedHost || req.headers.host || '')
      .split(',')[0].trim().toLowerCase();
    const forwardedProto = req.headers['x-forwarded-proto'];
    const protocol = String(forwardedProto || (req.socket.encrypted ? 'https' : 'http'))
      .split(',')[0].trim().toLowerCase() + ':';
    return origin.host.toLowerCase() === requestHost && origin.protocol === protocol;
  } catch {
    return false;
  }
}

function applySecurityHeaders(res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
}

function sendJson(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload));
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
  });
  res.end(body);
}

async function readBody(req, limit) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > limit) {
      const error = new Error('Request body exceeds configured limit');
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, total);
}

function isAuthenticated(req, secret) {
  return verifySession(readCookie(req.headers.cookie, SESSION_COOKIE), secret);
}

function requestHeadersForBackend(req, apiToken) {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (REQUEST_HEADERS_TO_DROP.has(name.toLowerCase()) || value === undefined) continue;
    headers.set(name, Array.isArray(value) ? value.join(', ') : String(value));
  }
  headers.set('authorization', 'Bearer ' + apiToken);
  return headers;
}

async function proxyToBackend(req, res, requestUrl, config, fetchImpl) {
  const backendPath = requestUrl.pathname === '/api' ? '/' : requestUrl.pathname.slice(4);
  const upstreamUrl = new URL(backendPath + requestUrl.search, config.apiUrl);
  const method = req.method || 'GET';
  const controller = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded) controller.abort();
  });

  let body;
  if (method !== 'GET' && method !== 'HEAD') {
    body = await readBody(req, MAX_PROXY_BODY_BYTES);
    if (body.length === 0) body = undefined;
  }

  const upstream = await fetchImpl(upstreamUrl, {
    method,
    headers: requestHeadersForBackend(req, config.apiToken),
    body,
    redirect: 'manual',
    signal: controller.signal,
  });

  const responseHeaders = {};
  for (const [name, value] of upstream.headers) {
    if (!RESPONSE_HEADERS_TO_DROP.has(name.toLowerCase())) responseHeaders[name] = value;
  }
  responseHeaders['cache-control'] = 'no-store';
  res.writeHead(upstream.status, responseHeaders);

  if (!upstream.body) {
    res.end();
    return;
  }
  Readable.fromWeb(upstream.body).pipe(res);
}

export function createGatewayServer(options = {}) {
  const config = loadConfig(options.env || process.env);
  const fetchImpl = options.fetchImpl || globalThis.fetch;

  return createServer(async (req, res) => {
    applySecurityHeaders(res);
    let requestUrl;
    try {
      requestUrl = new URL(req.url || '/', 'http://gateway.local');
    } catch {
      sendJson(res, 400, { detail: 'Invalid request URL.' });
      return;
    }

    const path = requestUrl.pathname;
    const method = (req.method || 'GET').toUpperCase();

    try {
      if (path === '/api/auth/session' && method === 'GET') {
        sendJson(res, 200, { authenticated: isAuthenticated(req, config.sessionSecret) });
        return;
      }

      if (path === '/api/auth/login' && method === 'POST') {
        if (!isSameOrigin(req)) {
          sendJson(res, 403, { detail: 'Cross-origin request rejected.' });
          return;
        }
        if (!String(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) {
          sendJson(res, 415, { detail: 'Expected application/json.' });
          return;
        }

        let submitted;
        try {
          submitted = JSON.parse((await readBody(req, MAX_LOGIN_BODY_BYTES)).toString('utf8'));
        } catch (error) {
          sendJson(res, error.statusCode || 400, { detail: 'Invalid login request.' });
          return;
        }

        const password = typeof submitted?.password === 'string' ? submitted.password : '';
        if (!equalSecret(password, config.ownerPassword)) {
          sendJson(res, 401, { detail: 'Invalid credentials.' });
          return;
        }

        res.setHeader('Set-Cookie', cookieHeader(signSession(config.sessionSecret), SESSION_TTL_SECONDS));
        sendJson(res, 200, { authenticated: true });
        return;
      }

      if (path === '/api/auth/logout' && method === 'POST') {
        if (!isSameOrigin(req)) {
          sendJson(res, 403, { detail: 'Cross-origin request rejected.' });
          return;
        }
        res.setHeader('Set-Cookie', cookieHeader('', 0));
        res.writeHead(204);
        res.end();
        return;
      }

      if (path !== '/api' && !path.startsWith('/api/')) {
        sendJson(res, 404, { detail: 'Not found.' });
        return;
      }

      if (!isAuthenticated(req, config.sessionSecret)) {
        sendJson(res, 401, { detail: 'Authentication required.' });
        return;
      }

      if (!['GET', 'HEAD', 'OPTIONS'].includes(method) && !isSameOrigin(req)) {
        sendJson(res, 403, { detail: 'Cross-origin request rejected.' });
        return;
      }

      if (!['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'].includes(method)) {
        sendJson(res, 405, { detail: 'Method not allowed.' });
        return;
      }

      await proxyToBackend(req, res, requestUrl, config, fetchImpl);
    } catch (error) {
      if (res.headersSent) {
        res.destroy(error);
        return;
      }
      const status = error.statusCode === 413 ? 413 : 502;
      sendJson(res, status, { detail: status === 413 ? 'Request body too large.' : 'Upstream service unavailable.' });
    }
  });
}
