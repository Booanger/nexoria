import fs from 'fs';
import path from 'path';

const DB_FILE = path.join(process.cwd(), 'database.json');

class EventStore {
  constructor() {
    this.events = new Map();
    this.load();
  }

  /**
   * Loads events from the database file and automatically prunes events older than 24 hours.
   */
  load() {
    try {
      if (fs.existsSync(DB_FILE)) {
        const raw = fs.readFileSync(DB_FILE, 'utf8');
        const data = JSON.parse(raw);
        
        const now = Date.now();
        const retentionPeriod = 48 * 60 * 60 * 1000; // 48 Hours
        let pruned = false;

        for (const [key, value] of Object.entries(data)) {
          // Keep if within retention period or if it doesn't have a timestamp (legacy format compatibility)
          if (!value.createdAt || (now - value.createdAt) < retentionPeriod) {
            this.events.set(key, value);
          } else {
            pruned = true;
            console.log(`[EventStore] Pruned abandoned/old event: "${value.title}" (${key})`);
          }
        }

        if (pruned) {
          this.save();
        }
      }
    } catch (error) {
      console.error('[EventStore] Database loading failed:', error);
    }
  }

  /**
   * Saves current state to the database file.
   */
  save() {
    try {
      const obj = {};
      for (const [key, value] of this.events.entries()) {
        obj[key] = value;
      }
      fs.writeFileSync(DB_FILE, JSON.stringify(obj, null, 2), 'utf8');
    } catch (error) {
      console.error('[EventStore] Database saving failed:', error);
    }
  }

  /**
   * Gets an event by its Discord message/event ID.
   * @param {string} eventId 
   * @returns {object|null}
   */
  getEvent(eventId) {
    return this.events.get(eventId) || null;
  }

  /**
   * Saves or updates an event.
   * @param {string} eventId 
   * @param {object} eventData 
   */
  saveEvent(eventId, eventData) {
    this.events.set(eventId, eventData);
    this.save();
  }

  /**
   * Deletes an event.
   * @param {string} eventId 
   * @returns {boolean}
   */
  deleteEvent(eventId) {
    const deleted = this.events.delete(eventId);
    if (deleted) {
      this.save();
    }
    return deleted;
  }
}

export const eventStore = new EventStore();
