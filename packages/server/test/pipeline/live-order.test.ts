/**
 * Acceptance of PLAN S12, "Order": the same events give the same alerts whatever order
 * several machines deliver their batches in. The demo data is cut into the batches each
 * stream would send, delivered in a seeded shuffle through the real parsers and rules,
 * and the alerts are compared with the reference run (ARCHITECTURE §6.2).
 */
import { DEFAULT_SEED, DEFAULT_START, generate, type GenerationResult } from '@centinela/loggen';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  arrivalOrder,
  createLiveRun,
  cutIntoBatches,
  outcomes,
  referenceRun,
  seeded,
  type AlertOutcome,
} from './live.js';

const SEEDS = Array.from({ length: 20 }, (_, i) => i + 1);
/** Batches span under five seconds; with this delay none arrives nine seconds late. */
const MAX_DELAY_MS = 4000;

async function shuffledRun(sample: GenerationResult, seed: number) {
  const random = seeded(seed);
  const batches = arrivalOrder(cutIntoBatches(sample, random), random, MAX_DELAY_MS);
  const run = createLiveRun({ reorder: { windowMs: 10_000, idleMs: Number.POSITIVE_INFINITY } });
  let pending = 0;
  for (const batch of batches) pending = (await run.deliver(batch)).pending;
  await run.pipeline.drain();
  return { alerts: outcomes(run.sink), stats: run.pipeline.stats(), batches, pending };
}

describe('live detection: delivery order does not change the alerts (small demo)', () => {
  let sample: GenerationResult;
  let reference: AlertOutcome[];

  beforeAll(async () => {
    sample = generate({
      seed: DEFAULT_SEED,
      days: 3,
      startMs: Date.parse(DEFAULT_START),
      small: true,
    });
    reference = await referenceRun(sample);
  }, 120_000);

  it('the reference run raises alerts for the demo scenarios', () => {
    expect(reference.length).toBeGreaterThan(19);
    expect(new Set(reference.map((alert) => alert.dedupKey)).size).toBeGreaterThan(10);
  });

  it('the reference run does not depend on the order the streams are delivered in', async () => {
    const reversed: GenerationResult = { ...sample, lines: [...sample.lines] };
    // Whole streams in the opposite order: group by stream, reverse the groups.
    const groups = new Map<string, typeof sample.lines>();
    for (const line of sample.lines) {
      const key = `${line.host}/${line.file}`;
      groups.set(key, [...(groups.get(key) ?? []), line]);
    }
    reversed.lines = [...groups.values()].reverse().flat();
    expect(await referenceRun(reversed)).toEqual(reference);
  }, 120_000);

  it.each(SEEDS)(
    'seed %i: shuffled batches give exactly the alerts of the reference run',
    async (seed) => {
      const { alerts, stats, batches } = await shuffledRun(sample, seed);
      // The shuffle is a real one: batches of different streams interleave out of order.
      const outOfOrder = batches.filter(
        (batch, i) => i > 0 && batch.fromMs < (batches[i - 1]?.toMs ?? 0),
      ).length;
      expect(outOfOrder).toBeGreaterThan(50);
      expect(stats.late).toBe(0);
      expect(stats.early).toBe(0);
      expect(stats.buffered).toBe(0);
      expect(stats.evaluated).toBe(sample.lines.length);
      expect(alerts).toEqual(reference);
    },
    120_000,
  );

  it('answers a shipper before its events are evaluated (ack=stored)', async () => {
    const { pending } = await shuffledRun(sample, 1);
    // The last batch delivered is still inside the window when its call returns.
    expect(pending).toBeGreaterThan(0);
  }, 120_000);
});

describe('live detection: delivery order does not change the alerts (full demo)', () => {
  it('seeds 1 and 2 give exactly the alerts of the reference run', async () => {
    const sample = generate({
      seed: DEFAULT_SEED,
      days: 3,
      startMs: Date.parse(DEFAULT_START),
      small: false,
    });
    const reference = await referenceRun(sample);
    expect(reference.length).toBeGreaterThan(19);
    for (const seed of [1, 2]) {
      const { alerts, stats } = await shuffledRun(sample, seed);
      expect(stats.late).toBe(0);
      expect(stats.early).toBe(0);
      expect(stats.evaluated).toBe(sample.lines.length);
      expect(alerts).toEqual(reference);
    }
  }, 600_000);
});
