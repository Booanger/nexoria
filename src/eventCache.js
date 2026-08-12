const DEFAULT_TTL_MS = 60_000;
const DEFAULT_STALE_TTL_MS = 30 * 60_000;
const DEFAULT_NEGATIVE_TTL_MS = 5_000;
const DEFAULT_MAX_ENTRIES = 500;

function clone(value) {
  return value === null ? null : structuredClone(value);
}

/**
 * Bounded LRU cache with fresh, stale and negative-cache windows.
 * Values are cloned on both ingress and egress so callers cannot mutate cache state.
 */
export class EventCache {
  constructor({
    ttlMs = DEFAULT_TTL_MS,
    staleTtlMs = DEFAULT_STALE_TTL_MS,
    negativeTtlMs = DEFAULT_NEGATIVE_TTL_MS,
    maxEntries = DEFAULT_MAX_ENTRIES,
    now = Date.now
  } = {}) {
    this.ttlMs = Math.max(1, ttlMs);
    this.staleTtlMs = Math.max(this.ttlMs, staleTtlMs);
    this.negativeTtlMs = Math.max(1, negativeTtlMs);
    this.maxEntries = Math.max(1, maxEntries);
    this.now = now;
    this.entries = new Map();
  }

  set(eventId, event) {
    const timestamp = this.now();
    this.#store(eventId, {
      value: clone(event),
      missing: false,
      expiresAt: timestamp + this.ttlMs,
      staleUntil: timestamp + this.staleTtlMs
    });
  }

  setMissing(eventId) {
    const timestamp = this.now();
    this.#store(eventId, {
      value: null,
      missing: true,
      expiresAt: timestamp + this.negativeTtlMs,
      staleUntil: timestamp + this.negativeTtlMs
    });
  }

  getFresh(eventId) {
    const entry = this.entries.get(eventId);
    if (!entry) return { hit: false, value: null };

    const timestamp = this.now();
    if (timestamp >= entry.expiresAt) {
      if (timestamp >= entry.staleUntil) this.entries.delete(eventId);
      return { hit: false, value: null };
    }

    this.#touch(eventId, entry);
    return { hit: true, value: clone(entry.value) };
  }

  getStale(eventId) {
    const entry = this.entries.get(eventId);
    if (!entry || entry.missing) return null;

    if (this.now() >= entry.staleUntil) {
      this.entries.delete(eventId);
      return null;
    }

    this.#touch(eventId, entry);
    return clone(entry.value);
  }

  postponeRefresh(eventId, delayMs) {
    const entry = this.entries.get(eventId);
    if (!entry || entry.missing) return false;

    const timestamp = this.now();
    if (timestamp >= entry.staleUntil) {
      this.entries.delete(eventId);
      return false;
    }

    entry.expiresAt = Math.min(timestamp + Math.max(1, delayMs), entry.staleUntil);
    this.#touch(eventId, entry);
    return true;
  }

  delete(eventId) {
    this.entries.delete(eventId);
  }

  deleteWhere(predicate) {
    for (const [eventId, entry] of this.entries) {
      if (!entry.missing && predicate(entry.value, eventId)) {
        this.entries.delete(eventId);
      }
    }
  }

  values() {
    const values = [];
    const timestamp = this.now();

    for (const [eventId, entry] of this.entries) {
      if (entry.missing) continue;
      if (timestamp >= entry.staleUntil) {
        this.entries.delete(eventId);
        continue;
      }
      values.push(clone(entry.value));
    }

    return values;
  }

  clear() {
    this.entries.clear();
  }

  get size() {
    return this.entries.size;
  }

  #store(eventId, entry) {
    this.entries.delete(eventId);
    this.entries.set(eventId, entry);

    while (this.entries.size > this.maxEntries) {
      const oldestKey = this.entries.keys().next().value;
      this.entries.delete(oldestKey);
    }
  }

  #touch(eventId, entry) {
    this.entries.delete(eventId);
    this.entries.set(eventId, entry);
  }
}
