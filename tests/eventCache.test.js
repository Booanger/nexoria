import test from 'node:test';
import assert from 'node:assert/strict';
import { EventCache } from '../src/eventCache.js';
import { EventStoreError, SupabaseEventStore } from '../src/eventStore.js';

const silentLogger = {
  log() {},
  warn() {},
  error() {}
};

function createReadClient(read) {
  return {
    from() {
      return {
        select() { return this; },
        eq() { return this; },
        maybeSingle: read
      };
    }
  };
}

test('cache isolates values and supports fresh-to-stale transitions', () => {
  let now = 1_000;
  const cache = new EventCache({ ttlMs: 100, staleTtlMs: 500, now: () => now });
  const source = { id: '1', slots: [{ userId: null }] };

  cache.set('1', source);
  source.slots[0].userId = 'outside-mutation';

  const first = cache.getFresh('1');
  assert.equal(first.hit, true);
  assert.equal(first.value.slots[0].userId, null);

  first.value.slots[0].userId = 'caller-mutation';
  assert.equal(cache.getFresh('1').value.slots[0].userId, null);

  now += 101;
  assert.equal(cache.getFresh('1').hit, false);
  assert.equal(cache.getStale('1').slots[0].userId, null);

  now += 500;
  assert.equal(cache.getStale('1'), null);
  assert.equal(cache.size, 0);
});

test('negative cache suppresses repeated misses for a short window', () => {
  let now = 0;
  const cache = new EventCache({ negativeTtlMs: 50, now: () => now });

  cache.setMissing('missing');
  assert.deepEqual(cache.getFresh('missing'), { hit: true, value: null });

  now = 51;
  assert.equal(cache.getFresh('missing').hit, false);
});

test('failed refresh cooldown never extends the stale lifetime', () => {
  let now = 0;
  const cache = new EventCache({ ttlMs: 10, staleTtlMs: 100, now: () => now });
  cache.set('1', { id: '1' });

  now = 11;
  assert.equal(cache.postponeRefresh('1', 50), true);
  assert.equal(cache.getFresh('1').hit, true);

  now = 61;
  assert.equal(cache.getFresh('1').hit, false);
  assert.notEqual(cache.getStale('1'), null);

  now = 100;
  assert.equal(cache.getStale('1'), null);
});

test('cache evicts the least recently used entry at its size limit', () => {
  const cache = new EventCache({ maxEntries: 2 });
  cache.set('1', { id: '1' });
  cache.set('2', { id: '2' });
  cache.getFresh('1');
  cache.set('3', { id: '3' });

  assert.equal(cache.getFresh('1').hit, true);
  assert.equal(cache.getFresh('2').hit, false);
  assert.equal(cache.getFresh('3').hit, true);
});

test('cache values exclude negative and fully expired entries', () => {
  let now = 0;
  const cache = new EventCache({ ttlMs: 10, staleTtlMs: 20, now: () => now });
  cache.set('1', { id: '1' });
  cache.setMissing('missing');

  assert.deepEqual(cache.values(), [{ id: '1' }]);
  now = 20;
  assert.deepEqual(cache.values(), []);
});

test('concurrent cache misses share one Supabase request', async () => {
  let reads = 0;
  let releaseRead;
  const gate = new Promise(resolve => { releaseRead = resolve; });
  const client = createReadClient(async () => {
    reads += 1;
    await gate;
    return { data: { data: { id: '1', title: 'Event' } }, error: null };
  });
  const store = new SupabaseEventStore({ client, logger: silentLogger });

  const first = store.getEvent('1');
  const second = store.getEvent('1');
  releaseRead();

  const [firstEvent, secondEvent] = await Promise.all([first, second]);
  firstEvent.title = 'mutated';

  assert.equal(reads, 1);
  assert.equal(secondEvent.title, 'Event');
  assert.equal((await store.getEvent('1')).title, 'Event');
});

test('expired cache serves stale data when Supabase temporarily fails', async () => {
  let now = 0;
  const cache = new EventCache({ ttlMs: 10, staleTtlMs: 1_000, now: () => now });
  cache.set('1', { id: '1', title: 'Cached event' });
  now = 11;

  const client = createReadClient(async () => ({ data: null, error: new Error('network down') }));
  const store = new SupabaseEventStore({ client, cache, logger: silentLogger });

  assert.equal((await store.getEvent('1')).title, 'Cached event');
});

test('database failure without cache is surfaced instead of pretending not found', async () => {
  const client = createReadClient(async () => ({ data: null, error: new Error('network down') }));
  const store = new SupabaseEventStore({ client, logger: silentLogger });

  await assert.rejects(() => store.getEvent('1'), EventStoreError);
});

test('a transient Supabase read is retried once', async () => {
  let reads = 0;
  const client = createReadClient(async () => {
    reads += 1;
    if (reads === 1) return { data: null, error: new Error('temporary network error') };
    return { data: { data: { id: '1', title: 'Recovered' } }, error: null };
  });
  const store = new SupabaseEventStore({ client, logger: silentLogger });

  assert.equal((await store.getEvent('1')).title, 'Recovered');
  assert.equal(reads, 2);
});

test('persistent outage opens a short circuit instead of queuing repeated timeouts', async () => {
  let reads = 0;
  const client = createReadClient(async () => {
    reads += 1;
    return { data: null, error: new Error('network down') };
  });
  const store = new SupabaseEventStore({ client, logger: silentLogger });

  await assert.rejects(() => store.getEvent('1'), EventStoreError);
  assert.equal(reads, 2);

  await assert.rejects(() => store.getEvent('2'), EventStoreError);
  assert.equal(reads, 2);
});

test('an older in-flight read cannot overwrite a newer successful write', async () => {
  let releaseRead;
  const gate = new Promise(resolve => { releaseRead = resolve; });
  const client = {
    from() {
      return {
        select() { return this; },
        eq() { return this; },
        async maybeSingle() {
          await gate;
          return { data: { data: { id: '1', title: 'Old value' } }, error: null };
        },
        async upsert() {
          return { error: null };
        }
      };
    }
  };
  const store = new SupabaseEventStore({ client, logger: silentLogger });

  const slowRead = store.getEvent('1');
  await store.saveEvent('1', { id: '1', title: 'New value' });
  releaseRead();

  assert.equal((await slowRead).title, 'New value');
  assert.equal((await store.getEvent('1')).title, 'New value');
});

test('permanent write failures never poison a previously valid cache entry', async () => {
  const cache = new EventCache();
  cache.set('1', { id: '1', title: 'Persisted value' });
  const permanentError = new Error('invalid database request');
  permanentError.status = 400;
  const client = {
    from() {
      return {
        async upsert() {
          return { error: permanentError };
        }
      };
    }
  };
  const store = new SupabaseEventStore({ client, cache, logger: silentLogger });

  await assert.rejects(
    () => store.saveEvent('1', { id: '1', title: 'Unpersisted value' }),
    EventStoreError
  );
  assert.equal(store.getCachedEvent('1').title, 'Persisted value');
});

test('transient write failure keeps the event usable and queues background sync', async () => {
  let backendAvailable = false;
  let writes = 0;
  const client = {
    from() {
      return {
        async upsert() {
          writes += 1;
          return backendAvailable
            ? { error: null }
            : { error: new Error('network down') };
        }
      };
    }
  };
  const store = new SupabaseEventStore({ client, logger: silentLogger });

  const result = await store.saveEvent('1', { id: '1', title: 'Cached event', leaderId: 'leader-1' });
  assert.deepEqual(result, { persisted: false, queued: true });
  assert.equal(store.getPendingWriteCount(), 1);
  assert.equal((await store.getEvent('1')).title, 'Cached event');
  assert.deepEqual(
    (await store.getEventsByLeader('leader-1')).map(event => event.id),
    ['1']
  );
  assert.equal(writes, 2);

  backendAvailable = true;
  const flush = await store.flushPendingWrites({ force: true });
  assert.deepEqual(flush, { flushed: 1, remaining: 0 });
  assert.equal(store.getPendingWriteCount(), 0);
});

test('pending writes coalesce to the newest event state', async () => {
  let backendAvailable = false;
  const persisted = [];
  const client = {
    from() {
      return {
        async upsert(payload) {
          if (!backendAvailable) return { error: new Error('network down') };
          persisted.push(structuredClone(payload.data));
          return { error: null };
        }
      };
    }
  };
  const store = new SupabaseEventStore({ client, logger: silentLogger });

  await store.saveEvent('1', { id: '1', title: 'First state' });
  await store.saveEvent('1', { id: '1', title: 'Newest state' });
  assert.equal(store.getPendingWriteCount(), 1);
  assert.equal((await store.getEvent('1')).title, 'Newest state');

  backendAvailable = true;
  await store.flushPendingWrites({ force: true });
  assert.deepEqual(persisted, [{ id: '1', title: 'Newest state' }]);
});
