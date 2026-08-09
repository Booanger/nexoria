import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createHealthServer } from '../src/healthServer.js';

async function startServer(getDiscordStatus) {
  const server = createHealthServer({ getDiscordStatus });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  return { server, url: `http://127.0.0.1:${port}` };
}

test('health endpoint reports 503 while Discord is not ready', async (t) => {
  const { server, url } = await startServer(() => ({ ready: false, state: 'connecting' }));
  t.after(() => server.close());

  const response = await fetch(`${url}/health`);
  const body = await response.json();

  assert.equal(response.status, 503);
  assert.equal(body.status, 'unavailable');
  assert.equal(body.discord, 'connecting');
});

test('health endpoint reports 200 only when Discord is ready', async (t) => {
  const { server, url } = await startServer(() => ({ ready: true, state: 'connected' }));
  t.after(() => server.close());

  const response = await fetch(`${url}/health`);
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.status, 'ok');
  assert.equal(body.discord, 'connected');
});

test('health server returns 404 for unknown paths', async (t) => {
  const { server, url } = await startServer(() => ({ ready: true, state: 'connected' }));
  t.after(() => server.close());

  const response = await fetch(`${url}/unknown`);

  assert.equal(response.status, 404);
});
