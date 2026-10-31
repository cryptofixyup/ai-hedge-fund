import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const configUrl = new URL('../../../vercel.json', import.meta.url);
const config = JSON.parse(readFileSync(configUrl, 'utf8'));

test('Vercel service names and roots match the agreed application topology', () => {
  assert.deepEqual(Object.keys(config.services).sort(), ['api', 'gateway', 'web']);
  assert.equal(config.services.web.root, 'app/frontend');
  assert.equal(config.services.gateway.root, 'app/gateway');
  assert.equal(config.services.api.root, '.');
  assert.equal(config.services.api.entrypoint, 'main:app');
});

test('only the gateway binds to the internal FastAPI service', () => {
  assert.deepEqual(config.services.gateway.bindings, [
    {
      type: 'service',
      service: 'api',
      format: 'url',
      env: 'AI_HEDGE_FUND_API_URL',
    },
  ]);
  assert.equal(config.services.web.bindings, undefined);
  assert.equal(config.services.api.bindings, undefined);
});

test('FastAPI service is never a public rewrite destination', () => {
  const publicDestinations = config.rewrites.map(rule => rule.destination?.service);
  assert.deepEqual(publicDestinations, ['gateway', 'gateway', 'web']);
  assert.equal(publicDestinations.includes('api'), false);
  assert.deepEqual(config.rewrites.map(rule => rule.source), [
    '/api',
    '/api/(.*)',
    '/(.*)',
  ]);
});
