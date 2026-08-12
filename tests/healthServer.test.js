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

test('Render health check stays alive while Discord is reconnecting', async (t) => {
  const { server, url } = await startServer(() => ({ connected: false, state: 'retry_wait' }));
  t.after(() => server.close());

  const response = await fetch(`${url}/health`);
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.status, 'ok');
  assert.equal(body.connected, false);
  assert.equal(body.discord, 'retry_wait');
  assert.equal(body.pendingWrites, 0);
});

test('health response reports an established Discord connection', async (t) => {
  const { server, url } = await startServer(() => ({ connected: true, state: 'connected' }));
  t.after(() => server.close());

  const response = await fetch(url);
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.connected, true);
  assert.equal(body.discord, 'connected');
});

test('health server returns 404 for unknown paths', async (t) => {
  const { server, url } = await startServer(() => ({ connected: true, state: 'connected' }));
  t.after(() => server.close());

  const response = await fetch(`${url}/unknown`);

  assert.equal(response.status, 404);
});
