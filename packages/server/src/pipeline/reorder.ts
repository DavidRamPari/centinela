/**
 * Reorder buffer (ARCHITECTURE §6.2). Several machines deliver their batches at the same
 * moment and in any order, but three things depend on the order of evaluation: which
 * events a correlation fires on, whether its window was already cleared, and whether a
 * match folds into an open alert. Stored events wait here and leave in order-key order,
 * so the result does not depend on how the batches interleaved.
 *
 * - The order key is `(detection time, host, source, id)`. Ids are assigned in line order,
 *   so the events of one stream keep the order they were written in.
 * - `horizon = newest detection time seen − window`. Every push releases what is at or
 *   before the horizon.
 * - An event that arrives with a key before the last released one is late: it cannot be
 *   put back in order, so it is handed out at once and reported.
 * - The buffer is bounded; when it is full the oldest events leave early.
 *
 * The buffer never reads a clock. Idle release and draining are decided by its owner.
 */
import type { NormalizedEvent } from '@centinela/shared';

export interface Buffered {
  event: NormalizedEvent;
  /** Detection time (epoch ms): `min(event time, receive time)`. */
  time: number;
  /** Sequence number of the ingest call that delivered it; 0 for events read back at start. */
  call: number;
}

export interface OrderKey {
  time: number;
  host: string;
  source: string;
  id: string;
}

export function orderKeyOf(item: Buffered): OrderKey {
  return { time: item.time, host: item.event.host, source: item.event.source, id: item.event.id };
}

/** Code-unit comparison: the same on every machine, unlike `localeCompare`. */
function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function compareOrderKeys(a: OrderKey, b: OrderKey): number {
  return (
    a.time - b.time ||
    compareText(a.host, b.host) ||
    compareText(a.source, b.source) ||
    compareText(a.id, b.id)
  );
}

function compareBuffered(a: Buffered, b: Buffered): number {
  return (
    a.time - b.time ||
    compareText(a.event.host, b.event.host) ||
    compareText(a.event.source, b.event.source) ||
    compareText(a.event.id, b.event.id)
  );
}

export interface ReorderOptions {
  /** How far behind the newest detection time the horizon stays; `Infinity` holds everything. */
  windowMs: number;
  /** Bound on buffered events; `Infinity` for none. */
  maxEvents: number;
}

export interface PushResult {
  /** Arrived behind the last released event; in order among themselves. Evaluate first. */
  late: Buffered[];
  /** Left the buffer, in order. */
  released: Buffered[];
  /** How many of `released` left only because the buffer was full. */
  early: number;
}

export interface ReorderSnapshot {
  newest: number | null;
  lastReleased: OrderKey | null;
  /** The buffered events: their ids and detection times. */
  events: Array<{ id: string; time: number }>;
}

export class ReorderBuffer {
  private readonly windowMs: number;
  private readonly maxEvents: number;
  /** Binary min-heap by order key. */
  private heap: Buffered[] = [];
  private newestTime: number | null = null;
  private last: OrderKey | null = null;

  constructor(options: ReorderOptions) {
    this.windowMs = options.windowMs;
    this.maxEvents = options.maxEvents;
  }

  get size(): number {
    return this.heap.length;
  }

  /** Newest detection time seen, or null before the first event. */
  get newest(): number | null {
    return this.newestTime;
  }

  /** Order key of the last event that left the buffer in order. */
  get lastReleased(): OrderKey | null {
    return this.last;
  }

  /** How many events of one ingest call are still waiting. */
  countOfCall(call: number): number {
    let count = 0;
    for (const item of this.heap) if (item.call === call) count += 1;
    return count;
  }

  push(items: readonly Buffered[]): PushResult {
    const late: Buffered[] = [];
    for (const item of items) {
      if (this.newestTime === null || item.time > this.newestTime) this.newestTime = item.time;
      if (this.last !== null && compareOrderKeys(orderKeyOf(item), this.last) < 0) {
        late.push(item);
      } else {
        this.insert(item);
      }
    }
    late.sort(compareBuffered);
    const released =
      this.newestTime === null ? [] : this.releaseThrough(this.newestTime - this.windowMs);
    let early = 0;
    while (this.heap.length > this.maxEvents) {
      const item = this.remove();
      if (item === undefined) break;
      released.push(item);
      early += 1;
    }
    if (early > 0) this.markReleased(released);
    return { late, released, early };
  }

  /** Release every buffered event whose detection time is at or before `time`, in order. */
  releaseThrough(time: number): Buffered[] {
    const released: Buffered[] = [];
    for (;;) {
      const first = this.heap[0];
      if (first === undefined || first.time > time) break;
      this.remove();
      released.push(first);
    }
    this.markReleased(released);
    return released;
  }

  /** Release everything, in order. */
  releaseAll(): Buffered[] {
    const released: Buffered[] = [];
    for (let item = this.remove(); item !== undefined; item = this.remove()) released.push(item);
    this.markReleased(released);
    return released;
  }

  snapshot(): ReorderSnapshot {
    return {
      newest: this.newestTime,
      lastReleased: this.last === null ? null : { ...this.last },
      events: this.heap
        .map((item) => ({ id: item.event.id, time: item.time }))
        .sort((a, b) => a.time - b.time || compareText(a.id, b.id)),
    };
  }

  /** Replace the contents (after a restart). */
  restore(state: {
    newest: number | null;
    lastReleased: OrderKey | null;
    items: readonly Buffered[];
  }): void {
    this.heap = [];
    this.newestTime = state.newest;
    this.last = state.lastReleased === null ? null : { ...state.lastReleased };
    for (const item of state.items) this.insert(item);
  }

  private markReleased(released: readonly Buffered[]): void {
    const final = released[released.length - 1];
    if (final === undefined) return;
    const key = orderKeyOf(final);
    if (this.last === null || compareOrderKeys(key, this.last) > 0) this.last = key;
  }

  private insert(item: Buffered): void {
    const heap = this.heap;
    let at = heap.length;
    heap.push(item);
    while (at > 0) {
      const parent = (at - 1) >> 1;
      const above = heap[parent];
      if (above === undefined || compareBuffered(above, item) <= 0) break;
      heap[at] = above;
      at = parent;
    }
    heap[at] = item;
  }

  private remove(): Buffered | undefined {
    const heap = this.heap;
    const first = heap[0];
    const moved = heap.pop();
    if (first === undefined || moved === undefined) return undefined;
    if (heap.length === 0) return first;
    let at = 0;
    for (;;) {
      const left = 2 * at + 1;
      const right = left + 1;
      let child = left;
      const leftItem = heap[left];
      const rightItem = heap[right];
      if (leftItem === undefined) break;
      let smallest = leftItem;
      if (rightItem !== undefined && compareBuffered(rightItem, leftItem) < 0) {
        child = right;
        smallest = rightItem;
      }
      if (compareBuffered(moved, smallest) <= 0) break;
      heap[at] = smallest;
      at = child;
    }
    heap[at] = moved;
    return first;
  }
}
