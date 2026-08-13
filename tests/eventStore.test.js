import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { EventStoreError, SQLiteEventStore } from '../src/eventStore.js';

const silentLogger = {
  log() {},
  warn() {},
  error() {}
};

function event(id, overrides = {}) {
  return {
    id,
    title: `Event ${id}`,
    description: '',
    leaderId: 'leader-1',
    leaderUsername: 'Leader',
    guildId: 'guild-1',
    channelId: 'channel-1',
    createdAt: Date.now(),
    slots: [{ id: 'slot-1', name: 'Tank', userId: null, username: null }],
    ...overrides
  };
}

function memoryStore() {
  return new SQLiteEventStore({
    database: new DatabaseSync(':memory:'),
    logger: silentLogger
  });
}

test('SQLite saves, reads and updates events without leaking object mutations', async (t) => {
  const store = memoryStore();
  t.after(() => store.close());

  const source = event('1');
  assert.deepEqual(await store.saveEvent('1', source), { persisted: true });
  source.title = 'Mutated outside';

  const firstRead = await store.getEvent('1');
  assert.equal(firstRead.title, 'Event 1');
  firstRead.slots[0].userId = 'outside-mutation';
  assert.equal((await store.getEvent('1')).slots[0].userId, null);

  await store.saveEvent('1', { ...firstRead, title: 'Updated' });
  assert.equal(store.getEventNow('1').title, 'Updated');
  assert.equal(store.getEventCount(), 1);
});

test('SQLite lists only the requested leader in creation order', async (t) => {
  const store = memoryStore();
  t.after(() => store.close());

  await store.saveEvent('newer', event('newer', { createdAt: 200 }));
  await store.saveEvent('other', event('other', { leaderId: 'leader-2', createdAt: 50 }));
  await store.saveEvent('older', event('older', { createdAt: 100 }));

  const result = await store.getEventsByLeader('leader-1');
  assert.deepEqual(result.map(item => item.id), ['older', 'newer']);
});

test('SQLite delete reports whether an event existed', async (t) => {
  const store = memoryStore();
  t.after(() => store.close());

  await store.saveEvent('1', event('1'));
  assert.deepEqual(await store.deleteEvent('1'), { persisted: true, deleted: true });
  assert.deepEqual(await store.deleteEvent('1'), { persisted: true, deleted: false });
  assert.equal(await store.getEvent('1'), null);
});

test('SQLite prunes only events older than 72 hours', async (t) => {
  const store = memoryStore();
  t.after(() => store.close());
  const now = 1_000_000_000;
  const retention = 72 * 60 * 60 * 1_000;

  await store.saveEvent('expired', event('expired', { createdAt: now - retention - 1 }));
  await store.saveEvent('boundary', event('boundary', { createdAt: now - retention }));
  await store.saveEvent('active', event('active', { createdAt: now }));

  assert.equal(await store.pruneOldEvents(now), 1);
  assert.equal(await store.getEvent('expired'), null);
  assert.notEqual(await store.getEvent('boundary'), null);
  assert.notEqual(await store.getEvent('active'), null);
});

test('SQLite file survives a complete store restart', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'nexoria-sqlite-'));
  const databasePath = join(directory, 'events.sqlite');

  const firstStore = new SQLiteEventStore({ databasePath, logger: silentLogger });
  await firstStore.saveEvent('persistent', event('persistent'));
  firstStore.close();

  const secondStore = new SQLiteEventStore({ databasePath, logger: silentLogger });
  t.after(() => {
    secondStore.close();
    rmSync(directory, { recursive: true, force: true });
  });
  assert.equal((await secondStore.getEvent('persistent')).title, 'Event persistent');
});

test('invalid events fail clearly and do not create partial rows', async (t) => {
  const store = memoryStore();
  t.after(() => store.close());

  await assert.rejects(
    () => store.saveEvent('invalid', { title: 'Missing leader' }),
    EventStoreError
  );
  assert.equal(await store.getEvent('invalid'), null);
});
