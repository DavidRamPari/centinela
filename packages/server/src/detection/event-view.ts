/**
 * The view rules match against (ARCHITECTURE §3.1, §5.6): `fields` by exact name, plus
 * `message` for keyword searches. Values are cut to 8,192 characters before matching and
 * their string and lower-cased forms are computed once per event and field.
 *
 * Field names used by rules get a numeric slot at compile time, so the per-event caches
 * are plain arrays. `memo` holds the results of shared predicates (identical selections
 * and detection items across rules are evaluated once per event, see `sigma/compile.ts`).
 */
import { MAX_MESSAGE_LENGTH, type FieldValue } from '@centinela/shared';
import type { LiteralIndex } from './sigma/literal-index.js';

/** Longest field value the matchers look at (ARCHITECTURE §5.6). */
export const MAX_MATCH_LENGTH = MAX_MESSAGE_LENGTH;

export interface MatchableEvent {
  message: string;
  fields: Readonly<Record<string, FieldValue>>;
}

/** Sigma's string form of a value: numbers in decimal, booleans as `true`/`false`. */
export function valueText(value: string | number | boolean): string {
  const text = typeof value === 'string' ? value : String(value);
  return text.length > MAX_MATCH_LENGTH ? text.slice(0, MAX_MATCH_LENGTH) : text;
}

const slots = new Map<string, number>();
const NO_LITERALS: ReadonlySet<number> = new Set();

/** The slot of a field name (allocated on first use; rule field names are few). */
export function fieldSlot(name: string): number {
  let slot = slots.get(name);
  if (slot === undefined) {
    slot = slots.size;
    slots.set(name, slot);
  }
  return slot;
}

/** Memo states: not computed yet, true, false. */
export const MEMO_UNKNOWN = 0;
export const MEMO_TRUE = 1;
export const MEMO_FALSE = 2;

export class EventView {
  readonly event: MatchableEvent;
  /** Results of shared predicates for this event; null disables memoization. */
  readonly memo: Int8Array | null;
  /** Per slot: string form, `null` when absent or null, `undefined` when not computed. */
  private readonly texts: Array<string | null | undefined> = [];
  private readonly lowers: Array<string | null | undefined> = [];
  private messageCache: string | undefined;
  private lowerMessageCache: string | undefined;
  /** Per slot + 1 (`message` is slot -1): ids of the indexed literals the value matches. */
  private literalSets: Array<ReadonlySet<number> | undefined> = [];
  private literalIndex: LiteralIndex | null = null;

  constructor(event: MatchableEvent, memoSlots = 0) {
    this.event = event;
    this.memo = memoSlots > 0 ? new Int8Array(memoSlots) : null;
  }

  /** The field's value; `undefined` when the event does not have the field. */
  value(field: string): FieldValue | undefined {
    return Object.hasOwn(this.event.fields, field) ? this.event.fields[field] : undefined;
  }

  /** Present and not null. */
  has(field: string): boolean {
    const value = this.value(field);
    return value !== undefined && value !== null;
  }

  /** String form, truncated; `undefined` when the field is absent or null. */
  text(field: string): string | undefined {
    return this.textAt(fieldSlot(field), field);
  }

  /** Lower-cased string form, cached. */
  lower(field: string): string | undefined {
    return this.lowerAt(fieldSlot(field), field);
  }

  /** `text()` with the slot already known (compiled matchers). */
  textAt(slot: number, field: string): string | undefined {
    let text = this.texts[slot];
    if (text === undefined) {
      const value = this.value(field);
      text = value === undefined || value === null ? null : valueText(value);
      this.texts[slot] = text;
    }
    return text ?? undefined;
  }

  /** `lower()` with the slot already known (compiled matchers). */
  lowerAt(slot: number, field: string): string | undefined {
    let lower = this.lowers[slot];
    if (lower === undefined) {
      lower = this.textAt(slot, field)?.toLowerCase() ?? null;
      this.lowers[slot] = lower;
    }
    return lower ?? undefined;
  }

  /**
   * Ids of the literals of `index` that the lower-cased field value (or `message`, for
   * slot -1) matches; one scan per field and event. Empty when the field is absent.
   */
  literals(index: LiteralIndex, slot: number, field: string | null): ReadonlySet<number> {
    if (this.literalIndex !== index) {
      this.literalIndex = index;
      this.literalSets = [];
    }
    let found = this.literalSets[slot + 1];
    if (found === undefined) {
      const value = field === null ? this.lowerMessage : this.lowerAt(slot, field);
      found = value === undefined ? NO_LITERALS : index.match(slot, value);
      this.literalSets[slot + 1] = found;
    }
    return found;
  }

  get message(): string {
    if (this.messageCache === undefined) {
      const { message } = this.event;
      this.messageCache =
        message.length > MAX_MATCH_LENGTH ? message.slice(0, MAX_MATCH_LENGTH) : message;
    }
    return this.messageCache;
  }

  get lowerMessage(): string {
    this.lowerMessageCache ??= this.message.toLowerCase();
    return this.lowerMessageCache;
  }
}
