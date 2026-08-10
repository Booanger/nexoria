import { createClient } from '@supabase/supabase-js';
import { config } from './config.js';

class SupabaseEventStore {
  constructor() {
    this.supabase = null;
    this.eventLocks = new Map();
    if (config.supabaseUrl && config.supabaseKey) {
      this.supabase = createClient(config.supabaseUrl, config.supabaseKey, {
        auth: {
          autoRefreshToken: false,
          persistSession: false
        }
      });
      console.log('[EventStore] Supabase client initialized.');
    } else {
      console.warn('[EventStore] Supabase credentials missing. Database operations will be disabled.');
    }
  }

  /**
   * Serializes read-modify-write operations for one event in this process.
   * Render Free runs a single instance, so this prevents concurrent Discord
   * interactions from overwriting each other.
   *
   * @template T
   * @param {string} eventId
   * @param {() => Promise<T>} operation
   * @returns {Promise<T>}
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

  /**
   * Deletes events older than 72 hours from the database.
   */
  async pruneOldEvents() {
    if (!this.supabase) return;
    try {
      const seventyTwoHoursAgo = new Date(Date.now() - 72 * 60 * 60 * 1000).toISOString();
      const { error } = await this.supabase
        .from('events')
        .delete()
        .lt('created_at', seventyTwoHoursAgo);

      if (error) {
        console.error('[EventStore] Failed to prune old events:', error.message);
      } else {
        console.log('[EventStore] Pruned events older than 72 hours from Supabase.');
      }
    } catch (error) {
      console.error('[EventStore] Pruning error:', error);
    }
  }

  /**
   * Retrieves an event by message ID.
   * @param {string} eventId 
   * @returns {Promise<object|null>}
   */
  async getEvent(eventId) {
    if (!this.supabase) return null;
    try {
      const { data, error } = await this.supabase
        .from('events')
        .select('data')
        .eq('id', eventId)
        .maybeSingle();

      if (error) {
        console.error('[EventStore] Error fetching event:', error.message);
        return null;
      }
      return data ? data.data : null;
    } catch (error) {
      console.error('[EventStore] Error in getEvent:', error);
      return null;
    }
  }

  /**
   * Saves or updates an event in Supabase.
   * @param {string} eventId 
   * @param {object} eventData 
   */
  async saveEvent(eventId, eventData) {
    if (!this.supabase) return;
    try {
      const { error } = await this.supabase
        .from('events')
        .upsert({
          id: eventId,
          data: eventData,
          created_at: eventData.createdAt ? new Date(eventData.createdAt).toISOString() : new Date().toISOString()
        });

      if (error) {
        console.error('[EventStore] Error saving event:', error.message);
      }
    } catch (error) {
      console.error('[EventStore] Error in saveEvent:', error);
    }
  }

  /**
   * Deletes an event by message ID.
   * @param {string} eventId 
   * @returns {Promise<boolean>}
   */
  async deleteEvent(eventId) {
    if (!this.supabase) return false;
    try {
      const { error } = await this.supabase
        .from('events')
        .delete()
        .eq('id', eventId);

      if (error) {
        console.error('[EventStore] Error deleting event:', error.message);
        return false;
      }
      return true;
    } catch (error) {
      console.error('[EventStore] Error in deleteEvent:', error);
      return false;
    }
  }

  /**
   * Retrieves all active events created by a specific user.
   * @param {string} leaderId 
   * @returns {Promise<Array<object>>}
   */
  async getEventsByLeader(leaderId) {
    if (!this.supabase) return [];
    try {
      const { data, error } = await this.supabase
        .from('events')
        .select('data')
        .eq('data->>leaderId', leaderId);

      if (error) {
        console.error('[EventStore] Error fetching events by leader:', error.message);
        return [];
      }
      return data ? data.map(item => item.data) : [];
    } catch (error) {
      console.error('[EventStore] Error in getEventsByLeader:', error);
      return [];
    }
  }
}

export const eventStore = new SupabaseEventStore();
