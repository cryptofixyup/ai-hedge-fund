import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createGatewayServer, SESSION_COOKIE, SESSION_TTL_SECONDS } from '../gateway.mjs';

const env = {
  AI_HEDGE_FUND_OWNER_PASSWORD: 'owner-password-'.padEnd(40, 'x'),
  AI_HEDGE_FUND_SESSION_SECRET: 'session-secret-'.padEnd(40, 's'),
  AI_HEDGE_FUND_API_URL: 'https://private-api.internal.example',
};

function originFor(baseUrl) {
  return 'https://' + new URL(baseUrl).host;
}

async function withServer(options, callback) {
  const server = createGatewayServer(options);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  const baseUrl = 'http://127.0.0.1:' + address.port;
  try {
    await callback(baseUrl);
  } finally {
    server.close();
    await once(server, 'close');
  }
}

async function login(baseUrl, origin = originFor(baseUrl)) {
  return fetch(baseUrl + '/api/auth/login', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin,
    },
    body: JSON.stringify({ password: env.AI_HEDGE_FUND_OWNER_PASSWORD }),
  });
}

test('gateway fails closed when required secrets or service binding are missing', () => {
  assert.throws(() => createGatewayServer({ env: {} }), /AI_HEDGE_FUND_OWNER_PASSWORD/);
  assert.throws(() => createGatewayServer({ env: { ...env, AI_HEDGE_FUND_API_URL: '' } }), /AI_HEDGE_FUND_API_URL/);
  assert.throws(() => createGatewayServer({ env: { ...env, AI_HEDGE_FUND_API_URL: 'javascript:alert(1)' } }), /HTTP\(S\) URL/);
});

test('unauthenticated API requests are denied before upstream is called', async () => {
  let upstreamCalls = 0;
  await withServer({
    env,
    fetchImpl: async () => { upstreamCalls += 1; return new Response('unexpected'); },
  }, async baseUrl => {
    const response = await fetch(baseUrl + '/api/flows/');
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { detail: 'Authentication required.' });
    assert.equal(upstreamCalls, 0);
  });
});

test('login rejects cross-origin attempts and incorrect passwords', async () => {
  await withServer({ env }, async baseUrl => {
    const crossOrigin = await login(baseUrl, 'https://attacker.example');
    assert.equal(crossOrigin.status, 403);

    const wrongPassword = await fetch(baseUrl + '/api/auth/login', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: originFor(baseUrl),
      },
      body: JSON.stringify({ password: 'wrong-password'.padEnd(40, '!') }),
    });
    assert.equal(wrongPassword.status, 401);
    assert.equal(wrongPassword.headers.get('set-cookie'), null);
  });
});

test('valid login sets a Secure HttpOnly Strict cookie and logout clears it', async () => {
  await withServer({ env }, async baseUrl => {
    const response = await login(baseUrl);
    assert.equal(response.status, 200);
    const cookie = response.headers.get('set-cookie');
    assert.ok(cookie.startsWith(SESSION_COOKIE + '='));
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /Secure/);
    assert.match(cookie, /SameSite=Strict/);
    assert.match(cookie, new RegExp('Max-Age=' + SESSION_TTL_SECONDS));

    const token = cookie.split(';', 1)[0];
    const session = await fetch(baseUrl + '/api/auth/session', { headers: { cookie: token } });
    assert.deepEqual(await session.json(), { authenticated: true });

    const logout = await fetch(baseUrl + '/api/auth/logout', {
      method: 'POST',
      headers: {
        cookie: token,
        origin: originFor(baseUrl),
      },
    });
    assert.equal(logout.status, 204);
    assert.match(logout.headers.get('set-cookie'), /Max-Age=0/);
  });
});

test('authenticated requests preserve API route and SSE response without forwarding credentials', async () => {
  let captured;
  await withServer({
    env,
    fetchImpl: async (url, init) => {
      captured = { url: String(url), init };
      return new Response('event: complete\ndata: {"ok":true}\n\n', {
        status: 200,
        headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
      });
    },
  }, async baseUrl => {
    const loginResponse = await login(baseUrl);
    const cookie = loginResponse.headers.get('set-cookie').split(';', 1)[0];
    const response = await fetch(baseUrl + '/api/hedge-fund/run?trace=1', {
      method: 'POST',
      headers: {
        cookie,
        origin: originFor(baseUrl),
        'content-type': 'application/json',
        authorization: 'Bearer attacker-controlled-value',
      },
      body: JSON.stringify({ tickers: ['AAPL'] }),
    });

    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'text/event-stream');
    assert.match(await response.text(), /event: complete/);
    assert.equal(captured.url, 'https://private-api.internal.example/hedge-fund/run?trace=1');
    assert.equal(captured.init.headers.get('authorization'), null);
    assert.equal(captured.init.headers.get('cookie'), null);
    assert.equal(captured.init.headers.get('x-forwarded-for'), null);
    assert.equal(captured.init.method, 'POST');
    assert.equal(captured.init.body.toString(), JSON.stringify({ tickers: ['AAPL'] }));
  });
});

test('state-changing API requests reject missing or foreign Origin', async () => {
  let upstreamCalls = 0;
  await withServer({
    env,
    fetchImpl: async () => { upstreamCalls += 1; return new Response('ok'); },
  }, async baseUrl => {
    const loginResponse = await login(baseUrl);
    const cookie = loginResponse.headers.get('set-cookie').split(';', 1)[0];
    const response = await fetch(baseUrl + '/api/flows/', {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: '{}',
    });
    assert.equal(response.status, 403);
    assert.equal(upstreamCalls, 0);
  });
});
