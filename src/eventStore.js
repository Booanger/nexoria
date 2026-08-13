import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config } from './config.js';

const EVENT_RETENTION_MS = 72 * 60 * 60 * 1_000;
const SQLITE_BUSY_TIMEOUT_MS = 5_000;

function clone(value) {
  return value == null ? value : structuredClone(value);
}

export class EventStoreError extends Error {
  constructor(operation, cause) {
    super(`SQLite ${operation} operation failed: ${cause?.message || String(cause)}`);
    this.name = 'EventStoreError';
    this.operation = operation;
    this.cause = cause;
  }
}

/**
 * Durable local event storage for a single Discord bot process.
 *
 * SQLite calls are synchronous by design. They are short local SSD operations,
 * so each public method keeps the existing async interface while avoiding a
 * remote network dependency and its associated timeouts/rate limits.
 */
export class SQLiteEventStore {
  constructor({ database, databasePath = config.databasePath, logger = console } = {}) {
    this.logger = logger;
    this.eventLocks = new Map();
    this.closed = false;

    try {
      if (database) {
        this.database = database;
        this.databasePath = ':provided:';
      } else {
        this.databasePath = resolve(databasePath || 'data/nexoria.sqlite');
        mkdirSync(dirname(this.databasePath), { recursive: true });
        this.database = new DatabaseSync(this.databasePath, {
          timeout: SQLITE_BUSY_TIMEOUT_MS,
          enableForeignKeyConstraints: true,
          allowExtension: false
        });
      }

      this.#initialize();
      this.logger.log(`[EventStore] SQLite ready (${this.databasePath}).`);
    } catch (error) {
      try {
        this.database?.close();
      } catch {
        // Preserve the original initialization error.
      }
      throw new EventStoreError('initialization', error);
    }
  }

  #initialize() {
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS};
      PRAGMA wal_autocheckpoint = 1000;
      PRAGMA journal_size_limit = 67108864;

      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY NOT NULL,
        leader_id TEXT NOT NULL,
        guild_id TEXT,
        channel_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        data TEXT NOT NULL CHECK (json_valid(data))
      ) STRICT;

      CREATE INDEX IF NOT EXISTS idx_events_leader_created
        ON events (leader_id, created_at);

      CREATE INDEX IF NOT EXISTS idx_events_created
        ON events (created_at);
    `);

    const integrity = this.database.prepare('PRAGMA quick_check').get();
    if (integrity?.quick_check !== 'ok') {
      throw new Error(`SQLite integrity check failed: ${integrity?.quick_check || 'unknown result'}`);
    }

    this.statements = {
      get: this.database.prepare('SELECT data FROM events WHERE id = ?'),
      listByLeader: this.database.prepare(`
        SELECT data FROM events
        WHERE leader_id = ?
        ORDER BY created_at ASC
      `),
      upsert: this.database.prepare(`
        INSERT INTO events (
          id, leader_id, guild_id, channel_id, created_at, updated_at, data
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          leader_id = excluded.leader_id,
          guild_id = excluded.guild_id,
          channel_id = excluded.channel_id,
          created_at = excluded.created_at,
          updated_at = excluded.updated_at,
          data = excluded.data
      `),
      delete: this.database.prepare('DELETE FROM events WHERE id = ?'),
      prune: this.database.prepare('DELETE FROM events WHERE created_at < ?'),
      count: this.database.prepare('SELECT COUNT(*) AS count FROM events')
    };
  }

  #assertOpen() {
    if (this.closed) {
      throw new Error('SQLite database is closed');
    }
  }

  #parseRow(row, operation) {
    if (!row) return null;
    try {
      return JSON.parse(row.data);
    } catch (error) {
      throw new EventStoreError(operation, new Error(`Corrupt event JSON: ${error.message}`));
    }
  }

  /** Serializes read-modify-write operations for a single event. */
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

  /** Synchronous read used before opening a Discord modal, which cannot be deferred. */
  getEventNow(eventId) {
    try {
      this.#assertOpen();
      return clone(this.#parseRow(this.statements.get.get(eventId), 'read'));
    } catch (error) {
      if (error instanceof EventStoreError) throw error;
      throw new EventStoreError('read', error);
    }
  }

  async getEvent(eventId) {
    return this.getEventNow(eventId);
  }

  async saveEvent(eventId, eventData) {
    try {
      this.#assertOpen();
      const event = clone({ ...eventData, id: eventId });
      if (!event.leaderId) throw new Error('leaderId is required');

      const createdAt = Number.isFinite(event.createdAt) ? event.createdAt : Date.now();
      event.createdAt = createdAt;
      const serialized = JSON.stringify(event);

      this.statements.upsert.run(
        eventId,
        event.leaderId,
        event.guildId || null,
        event.channelId || null,
        createdAt,
        Date.now(),
        serialized
      );

      return { persisted: true };
    } catch (error) {
      throw new EventStoreError('write', error);
    }
  }

  async deleteEvent(eventId) {
    try {
      this.#assertOpen();
      const result = this.statements.delete.run(eventId);
      return { persisted: true, deleted: Number(result.changes) > 0 };
    } catch (error) {
      throw new EventStoreError('delete', error);
    }
  }

  async getEventsByLeader(leaderId) {
    try {
      this.#assertOpen();
      return this.statements.listByLeader
        .all(leaderId)
        .map(row => clone(this.#parseRow(row, 'list')));
    } catch (error) {
      if (error instanceof EventStoreError) throw error;
      throw new EventStoreError('list', error);
    }
  }

  async pruneOldEvents(now = Date.now()) {
    try {
      this.#assertOpen();
      const cutoff = now - EVENT_RETENTION_MS;
      const result = this.statements.prune.run(cutoff);
      const deleted = Number(result.changes);
      this.logger.log(`[EventStore] SQLite cleanup completed (${deleted} old event(s) removed).`);
      return deleted;
    } catch (error) {
      this.logger.error('[EventStore] SQLite cleanup failed:', error?.message || error);
      throw new EventStoreError('prune', error);
    }
  }

  getEventCount() {
    try {
      this.#assertOpen();
      return Number(this.statements.count.get().count);
    } catch (error) {
      throw new EventStoreError('count', error);
    }
  }

  close() {
    if (this.closed) return;

    try {
      // Persist the WAL into the main database before the process exits.
      this.database.exec('PRAGMA wal_checkpoint(TRUNCATE);');
      this.database.exec('PRAGMA optimize;');
      this.database.close();
      this.closed = true;
      this.logger.log('[EventStore] SQLite closed cleanly.');
    } catch (error) {
      throw new EventStoreError('close', error);
    }
  }
}

export const eventStore = new SQLiteEventStore();
