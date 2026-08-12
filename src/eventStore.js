import { createClient } from '@supabase/supabase-js';
import { config } from './config.js';
import { EventCache } from './eventCache.js';

const SUPABASE_REQUEST_TIMEOUT_MS = 5_000;
const SUPABASE_RETRY_DELAY_MS = 300;
const FAILED_REFRESH_COOLDOWN_MS = 5_000;
const BACKEND_CIRCUIT_BREAK_MS = 5_000;
const OUTBOX_RETRY_BASE_MS = 5_000;
const OUTBOX_RETRY_MAX_MS = 5 * 60_000;
const OUTBOX_MAX_ENTRIES = 1_000;

function fetchWithTimeout(input, init = {}) {
  const timeoutSignal = AbortSignal.timeout(SUPABASE_REQUEST_TIMEOUT_MS);
  const signal = init.signal
    ? AbortSignal.any([init.signal, timeoutSignal])
    : timeoutSignal;
  return fetch(input, { ...init, signal });
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isRetryableDatabaseError(error) {
  const status = Number(error?.status || error?.statusCode);
  if (status === 408 || status === 429 || status >= 500) return true;
  if (status >= 400 && status < 500) return false;

  const code = String(error?.code || '');
  if (code.startsWith('PGRST')) {
    return ['PGRST000', 'PGRST001', 'PGRST002', 'PGRST003'].includes(code);
  }
  if (/^[0-9A-Z]{5}$/.test(code)) {
    return ['08', '40', '53', '57', '58'].includes(code.slice(0, 2));
  }

  return true;
}

export class EventStoreError extends Error {
  constructor(operation, cause) {
    super(`Supabase ${operation} operation failed: ${cause?.message || String(cause)}`);
    this.name = 'EventStoreError';
    this.operation = operation;
    this.cause = cause;
  }
}

export class SupabaseEventStore {
  constructor({ client, cache, logger = console } = {}) {
    this.logger = logger;
    this.eventLocks = new Map();
    this.inflightReads = new Map();
    this.eventVersions = new Map();
    this.backendUnavailableUntil = 0;
    this.pendingWrites = new Map();
    this.pendingSequence = 0;
    this.outboxTimer = null;
    this.outboxFlushPromise = null;
    this.cache = cache || new EventCache();

    if (client !== undefined) {
      this.supabase = client;
    } else if (config.supabaseUrl && config.supabaseKey) {
      this.supabase = createClient(config.supabaseUrl, config.supabaseKey, {
        auth: {
          autoRefreshToken: false,
          persistSession: false
        },
        global: {
          fetch: fetchWithTimeout
        }
      });
    } else {
      this.supabase = null;
    }

    if (this.supabase) {
      this.logger.log('[EventStore] Supabase client initialized.');
    } else {
      this.logger.warn('[EventStore] Supabase credentials missing. Database operations will be disabled.');
    }
  }

  getCachedEvent(eventId) {
    const pending = this.pendingWrites.get(eventId);
    if (pending) {
      return pending.type === 'delete' ? null : structuredClone(pending.data);
    }

    const fresh = this.cache.getFresh(eventId);
    return fresh.hit ? fresh.value : this.cache.getStale(eventId);
  }

  getPendingWriteCount() {
    return this.pendingWrites.size;
  }

  #getVersion(eventId) {
    return this.eventVersions.get(eventId) || 0;
  }

  #bumpVersion(eventId) {
    const nextVersion = this.#getVersion(eventId) + 1;
    if (this.inflightReads.has(eventId)) {
      this.eventVersions.set(eventId, nextVersion);
    } else {
      this.eventVersions.delete(eventId);
    }
    return nextVersion;
  }

  /**
   * Serializes read-modify-write operations for one event in this process.
   * Render Free runs a single instance, preventing concurrent interactions
   * from overwriting each other.
   */
  async withEventLock(eventId, operation) {
    const previous = this.eventLocks.get(eventId) || Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    this.eventLocks.set(eventId, current);

    try {
      return await current;
    } finally {
      if (this.eventLocks.get(eventId) === current) {
        this.eventLocks.delete(eventId);
      }
    }
  }

  async #runWithRetry(operation, request, { bypassCircuit = false } = {}) {
    if (!bypassCircuit && Date.now() < this.backendUnavailableUntil) {
      throw new Error('Supabase is in a short recovery cooldown');
    }

    try {
      const result = await request();
      this.backendUnavailableUntil = 0;
      return result;
    } catch (error) {
      if (!isRetryableDatabaseError(error)) throw error;
      this.logger.warn(`[EventStore] Supabase ${operation} failed; retrying once:`, error?.message || error);
      await wait(SUPABASE_RETRY_DELAY_MS);

      try {
        const result = await request();
        this.backendUnavailableUntil = 0;
        return result;
      } catch (retryError) {
        if (isRetryableDatabaseError(retryError)) {
          this.backendUnavailableUntil = Date.now() + BACKEND_CIRCUIT_BREAK_MS;
        }
        throw retryError;
      }
    }
  }

  #enqueuePendingWrite(eventId, type, data = null) {
    if (!this.pendingWrites.has(eventId) && this.pendingWrites.size >= OUTBOX_MAX_ENTRIES) {
      throw new EventStoreError('queue', new Error('Pending write queue is full'));
    }

    const entry = {
      eventId,
      type,
      data: data ? structuredClone(data) : null,
      sequence: ++this.pendingSequence,
      attempts: 0,
      nextAttemptAt: Math.max(Date.now() + OUTBOX_RETRY_BASE_MS, this.backendUnavailableUntil)
    };
    this.pendingWrites.set(eventId, entry);
    this.#scheduleOutboxFlush();
    return entry;
  }

  #scheduleOutboxFlush() {
    if (this.outboxTimer) {
      clearTimeout(this.outboxTimer);
      this.outboxTimer = null;
    }
    if (this.pendingWrites.size === 0) return;

    const nextAttemptAt = Math.min(...Array.from(this.pendingWrites.values(), entry => entry.nextAttemptAt));
    this.outboxTimer = setTimeout(() => {
      this.outboxTimer = null;
      void this.flushPendingWrites();
    }, Math.max(0, nextAttemptAt - Date.now()));
    this.outboxTimer.unref();
  }

  async flushPendingWrites({ force = false } = {}) {
    if (this.outboxFlushPromise) {
      const currentResult = await this.outboxFlushPromise;
      if (force && this.pendingWrites.size > 0) {
        return this.flushPendingWrites({ force: true });
      }
      return currentResult;
    }

    this.outboxFlushPromise = this.#flushPendingWrites(force).finally(() => {
      this.outboxFlushPromise = null;
      this.#scheduleOutboxFlush();
    });
    return this.outboxFlushPromise;
  }

  async #flushPendingWrites(force) {
    let flushed = 0;
    const now = Date.now();
    const dueEntries = Array.from(this.pendingWrites.values())
      .filter(entry => force || entry.nextAttemptAt <= now);

    for (const snapshot of dueEntries) {
      await this.withEventLock(snapshot.eventId, async () => {
        const current = this.pendingWrites.get(snapshot.eventId);
        if (!current || current.sequence !== snapshot.sequence) return;

        try {
          if (current.type === 'delete') {
            await this.#persistDelete(current.eventId, { bypassCircuit: force });
          } else {
            await this.#persistUpsert(current.eventId, current.data, { bypassCircuit: force });
          }

          const latest = this.pendingWrites.get(current.eventId);
          if (!latest || latest.sequence !== current.sequence) return;

          if (current.type === 'delete') {
            this.cache.delete(current.eventId);
          } else {
            this.cache.set(current.eventId, current.data);
          }
          this.pendingWrites.delete(current.eventId);
          this.#bumpVersion(current.eventId);
          flushed += 1;
          this.logger.log(`[EventStore] Background ${current.type} synced for ${current.eventId}.`);
        } catch (error) {
          const latest = this.pendingWrites.get(current.eventId);
          if (!latest || latest.sequence !== current.sequence) return;

          latest.attempts += 1;
          const retryDelay = isRetryableDatabaseError(error)
            ? Math.min(OUTBOX_RETRY_BASE_MS * (2 ** Math.min(latest.attempts - 1, 6)), OUTBOX_RETRY_MAX_MS)
            : OUTBOX_RETRY_MAX_MS;
          latest.nextAttemptAt = Date.now() + retryDelay;
          this.logger.warn(
            `[EventStore] Background ${latest.type} still pending for ${latest.eventId}; `
            + `retrying in ${Math.ceil(retryDelay / 1_000)}s:`,
            error?.message || error
          );
        }
      });
    }

    return { flushed, remaining: this.pendingWrites.size };
  }

  async pruneOldEvents() {
    if (!this.supabase) return false;
    const cutoffMs = Date.now() - 72 * 60 * 60 * 1000;

    try {
      await this.#runWithRetry('prune', async () => {
        const { error } = await this.supabase
          .from('events')
          .delete()
          .lt('created_at', new Date(cutoffMs).toISOString());
        if (error) throw error;
      });
      this.cache.deleteWhere(event => event.createdAt && event.createdAt < cutoffMs);
      this.logger.log('[EventStore] Pruned events older than 72 hours from Supabase.');
      return true;
    } catch (error) {
      this.logger.error('[EventStore] Failed to prune old events:', error?.message || error);
      return false;
    }
  }

  async getEvent(eventId) {
    const pending = this.pendingWrites.get(eventId);
    if (pending) {
      return pending.type === 'delete' ? null : structuredClone(pending.data);
    }

    const fresh = this.cache.getFresh(eventId);
    if (fresh.hit) return fresh.value;

    const pendingRead = this.inflightReads.get(eventId);
    if (pendingRead) return structuredClone(await pendingRead);

    const stale = this.cache.getStale(eventId);
    const readVersion = this.#getVersion(eventId);
    const read = this.#readEvent(eventId, stale, readVersion);
    this.inflightReads.set(eventId, read);

    try {
      const event = await read;
      return event ? structuredClone(event) : null;
    } finally {
      if (this.inflightReads.get(eventId) === read) {
        this.inflightReads.delete(eventId);
        this.eventVersions.delete(eventId);
      }
    }
  }

  async #readEvent(eventId, stale, readVersion) {
    if (!this.supabase) {
      if (stale) return stale;
      throw new EventStoreError('read', new Error('Supabase client is not configured'));
    }

    try {
      const data = await this.#runWithRetry('read', async () => {
        const { data, error } = await this.supabase
          .from('events')
          .select('data')
          .eq('id', eventId)
          .maybeSingle();
        if (error) throw error;
        return data;
      });

      // A write/delete completed while this slower read was in flight.
      // Never let its older response replace the newer cache state.
      if (readVersion !== this.#getVersion(eventId)) {
        return this.getCachedEvent(eventId);
      }

      if (!data) {
        this.cache.setMissing(eventId);
        return null;
      }

      this.cache.set(eventId, data.data);
      return data.data;
    } catch (error) {
      if (readVersion !== this.#getVersion(eventId)) {
        return this.getCachedEvent(eventId);
      }
      const currentStale = this.cache.getStale(eventId);
      if (currentStale) {
        this.cache.postponeRefresh(eventId, FAILED_REFRESH_COOLDOWN_MS);
        this.logger.warn(`[EventStore] Supabase read failed for ${eventId}; serving stale cache:`, error?.message || error);
        return currentStale;
      }
      throw new EventStoreError('read', error);
    }
  }

  async saveEvent(eventId, eventData) {
    if (!this.supabase) {
      throw new EventStoreError('write', new Error('Supabase client is not configured'));
    }

    try {
      await this.#persistUpsert(eventId, eventData);
      this.#bumpVersion(eventId);
      this.cache.set(eventId, eventData);
      this.pendingWrites.delete(eventId);
      this.#scheduleOutboxFlush();
      return { persisted: true, queued: false };
    } catch (error) {
      if (isRetryableDatabaseError(error)) {
        this.#enqueuePendingWrite(eventId, 'upsert', eventData);
        this.cache.set(eventId, eventData);
        this.logger.warn(`[EventStore] Write queued for background sync: ${eventId}`);
        return { persisted: false, queued: true };
      }
      throw new EventStoreError('write', error);
    }
  }

  async #persistUpsert(eventId, eventData, retryOptions) {
    await this.#runWithRetry('write', async () => {
      const { error } = await this.supabase
        .from('events')
        .upsert({
          id: eventId,
          data: eventData,
          created_at: eventData.createdAt
            ? new Date(eventData.createdAt).toISOString()
            : new Date().toISOString()
        });
      if (error) throw error;
    }, retryOptions);
  }

  async deleteEvent(eventId) {
    if (!this.supabase) {
      throw new EventStoreError('delete', new Error('Supabase client is not configured'));
    }

    try {
      await this.#persistDelete(eventId);
      this.#bumpVersion(eventId);
      this.cache.delete(eventId);
      this.pendingWrites.delete(eventId);
      this.#scheduleOutboxFlush();
      return { persisted: true, queued: false };
    } catch (error) {
      if (isRetryableDatabaseError(error)) {
        this.#enqueuePendingWrite(eventId, 'delete');
        this.cache.delete(eventId);
        this.logger.warn(`[EventStore] Delete queued for background sync: ${eventId}`);
        return { persisted: false, queued: true };
      }
      throw new EventStoreError('delete', error);
    }
  }

  async #persistDelete(eventId, retryOptions) {
    await this.#runWithRetry('delete', async () => {
      const { error } = await this.supabase
        .from('events')
        .delete()
        .eq('id', eventId);
      if (error) throw error;
    }, retryOptions);
  }

  async getEventsByLeader(leaderId) {
    if (!this.supabase) {
      throw new EventStoreError('list', new Error('Supabase client is not configured'));
    }

    try {
      const data = await this.#runWithRetry('list', async () => {
        const { data, error } = await this.supabase
          .from('events')
          .select('data')
          .eq('data->>leaderId', leaderId);
        if (error) throw error;
        return data;
      });

      return this.#mergeLeaderEvents(data ? data.map(item => item.data) : [], leaderId);
    } catch (error) {
      if (isRetryableDatabaseError(error)) {
        this.logger.warn(`[EventStore] Leader event list is using cache while Supabase recovers: ${leaderId}`);
        return this.#mergeLeaderEvents(this.cache.values(), leaderId);
      }
      throw new EventStoreError('list', error);
    }
  }

  #mergeLeaderEvents(events, leaderId) {
    const merged = new Map(
      events
        .filter(event => event?.leaderId === leaderId && event?.id)
        .map(event => [event.id, event])
    );

    for (const pending of this.pendingWrites.values()) {
      if (pending.type === 'delete') {
        merged.delete(pending.eventId);
      } else if (pending.data?.leaderId === leaderId) {
        merged.set(pending.eventId, pending.data);
      }
    }

    return structuredClone(Array.from(merged.values()));
  }
}

export const eventStore = new SupabaseEventStore();
