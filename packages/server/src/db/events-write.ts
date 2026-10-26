/**
 * PostgreSQL `EventStore` (ARCHITECTURE §2.3). Session S1 implements batched inserts here;
 * until then the store rejects every write.
 */
import type { Pool } from 'pg';
import type { EventStore } from '../pipeline/types.js';

export function createEventStore(_pool?: Pool): EventStore {
  return {
    insertMany() {
      return Promise.reject(new Error('not implemented (S1)'));
    },
  };
}
