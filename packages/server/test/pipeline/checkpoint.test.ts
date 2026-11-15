/**
 * The detector checkpoint (ARCHITECTURE §6.3, PLAN S12): a clean restart changes nothing,
 * a crash loses nothing, and a saved state that cannot be trusted is not used.
 */
import { DEFAULT_SEED, DEFAULT_START, generate, type GenerationResult } from '@centinela/loggen';
import type { NormalizedEvent } from '@centinela/shared';
import { beforeAll, describe, expect, it } from 'vitest';
import { SNAPSHOT_VERSION } from '../../src/pipeline/orchestrator.js';
import type { Checkpoint, EventReader } from '../../src/pipeline/types.js';
import {
  arrivalOrder,
  createLiveRun,
  cutIntoBatches,
  memoryCheckpoints,
  memoryReader,
  outcomes,
  seeded,
  type AlertOutcome,
  type LiveRun,
  type StreamBatch,
} from './live.js';

const WINDOW = { windowMs: 10_000, idleMs: Number.POSITIVE_INFINITY };

/** Ids that sort in the order events were stored, the same in every run of a delivery order. */
function sequentialIds() {
  let n = 0;
  return () => `event-${String((n += 1)).padStart(8, '0')}`;
}

describe('detector checkpoint', () => {
  let sample: GenerationResult;
  let batches: StreamBatch[];
  let uninterrupted: AlertOutcome[];

  beforeAll(async () => {
    sample = generate({
      seed: DEFAULT_SEED,
      days: 3,
      startMs: Date.parse(DEFAULT_START),
      small: true,
    });
    const random = seeded(11);
    batches = arrivalOrder(cutIntoBatches(sample, random), random, 4000);
    const run = createLiveRun({ reorder: WINDOW, newId: sequentialIds() });
    for (const batch of batches) await run.deliver(batch);
    await run.pipeline.drain();
    uninterrupted = outcomes(run.sink);
    expect(run.pipeline.stats().late).toBe(0);
  }, 120_000);

  /** Deliver batches [from, to) to a run. */
  async function deliver(run: LiveRun, from: number, to: number) {
    for (const batch of batches.slice(from, to)) await run.deliver(batch);
  }

  it.each([1, 2, 3, 4, 5])(
    'clean restart at a seeded batch (%i): the alerts are those of the uninterrupted run',
    async (seed) => {
      const stopAt = 1 + Math.floor(seeded(seed)() * (batches.length - 2));
      const newId = sequentialIds();
      const checkpoints = memoryCheckpoints();

      const first = createLiveRun({ reorder: WINDOW, newId, keepEvents: true, checkpoints });
      first.pipeline.components.eventReader = memoryReader(first.events);
      await deliver(first, 0, stopAt);
      const waiting = first.pipeline.stats().buffered;
      // A clean stop: nothing is evaluated early, the state is saved as it is.
      first.pipeline.stop();
      expect(await first.pipeline.checkpoint()).toBe(true);
      expect(await first.pipeline.checkpoint()).toBe(false);

      const second = createLiveRun({
        reorder: WINDOW,
        newId,
        keepEvents: true,
        checkpoints,
        eventReader: memoryReader(first.events),
        continueFrom: first,
      });
      const restored = await second.pipeline.restore();
      expect(restored).toMatchObject({ restored: true, buffered: waiting, replayed: 0 });
      expect(restored.rules.dropped).toBe(0);
      expect(second.pipeline.stats().buffered).toBe(waiting);
      await deliver(second, stopAt, batches.length);
      await second.pipeline.drain();

      expect(second.pipeline.stats().late).toBe(0);
      expect(outcomes(second.sink)).toEqual(uninterrupted);
    },
    120_000,
  );

  it('without the checkpoint a restart loses the events that were waiting', async () => {
    const stopAt = Math.floor(batches.length / 2);
    const newId = sequentialIds();
    const first = createLiveRun({ reorder: WINDOW, newId });
    await deliver(first, 0, stopAt);
    const waiting = first.pipeline.stats().buffered;
    expect(waiting).toBeGreaterThan(0);
    const second = createLiveRun({ reorder: WINDOW, newId, continueFrom: first });
    await deliver(second, stopAt, batches.length);
    await second.pipeline.drain();
    expect(first.pipeline.stats().evaluated + second.pipeline.stats().evaluated).toBe(
      sample.lines.length - waiting,
    );
  }, 120_000);

  it.each([1, 2, 3])(
    'crash (%i): events after the last checkpoint are evaluated again and no alert is lost or doubled',
    async (seed) => {
      const random = seeded(seed + 100);
      const checkpointAt = 20 + Math.floor(random() * (batches.length - 60));
      // The process dies a few batches (seconds of traffic) after its last checkpoint.
      const crashAt = checkpointAt + 1 + Math.floor(random() * 20);
      const newId = sequentialIds();
      const checkpoints = memoryCheckpoints();

      const first = createLiveRun({ reorder: WINDOW, newId, keepEvents: true, checkpoints });
      first.pipeline.components.eventReader = memoryReader(first.events);
      await deliver(first, 0, checkpointAt);
      await first.pipeline.checkpoint();
      const evaluatedAtCheckpoint = first.pipeline.stats().evaluated;
      await deliver(first, checkpointAt, crashAt);
      const storedAtCrash = first.events.length;
      first.pipeline.stop(); // and nothing else: the state in memory is gone

      const second = createLiveRun({
        reorder: WINDOW,
        newId,
        keepEvents: true,
        checkpoints,
        eventReader: memoryReader(first.events),
        continueFrom: first,
      });
      const restored = await second.pipeline.restore();
      expect(restored.restored).toBe(true);
      expect(restored.replayed).toBeGreaterThan(0);
      await deliver(second, crashAt, batches.length);
      await second.pipeline.drain();

      // Nothing stored stays unevaluated: everything after the checkpoint went through again.
      expect(evaluatedAtCheckpoint + second.pipeline.stats().evaluated).toBe(sample.lines.length);
      expect(storedAtCrash).toBeGreaterThan(evaluatedAtCheckpoint);

      const after = outcomes(second.sink);
      expect(after.map((a) => [a.ruleId, a.dedupKey, a.firstSeen, a.lastSeen])).toEqual(
        uninterrupted.map((a) => [a.ruleId, a.dedupKey, a.firstSeen, a.lastSeen]),
      );
      let repeated = 0;
      after.forEach((alert, i) => {
        const expected = uninterrupted[i];
        if (expected === undefined) throw new Error('missing alert');
        expect([...alert.events].sort()).toEqual([...expected.events].sort());
        expect(alert.count).toBeGreaterThanOrEqual(expected.count);
        repeated += alert.count - expected.count;
      });
      // Only matches of the stretch between the checkpoint and the crash can repeat.
      expect(repeated).toBeLessThanOrEqual(storedAtCrash - evaluatedAtCheckpoint);
    },
    120_000,
  );

  it('the first start on a database marks its place without evaluating what is already stored', async () => {
    const newId = sequentialIds();
    const earlier = createLiveRun({ reorder: WINDOW, newId, keepEvents: true });
    await deliver(earlier, 0, 30);
    await earlier.pipeline.drain();
    const before = outcomes(earlier.sink);

    const checkpoints = memoryCheckpoints();
    const server = createLiveRun({
      reorder: WINDOW,
      newId,
      keepEvents: true,
      checkpoints,
      eventReader: memoryReader(earlier.events),
      continueFrom: earlier,
    });
    expect(await server.pipeline.restore()).toEqual({
      restored: false,
      rules: { restored: 0, dropped: 0 },
      buffered: 0,
      replayed: 0,
    });
    expect(server.pipeline.stats().evaluated).toBe(0);
    expect(outcomes(server.sink)).toEqual(before);
    const saved = JSON.parse(checkpoints.saved ?? 'null') as Checkpoint;
    expect(saved.position).toBe(earlier.events[earlier.events.length - 1]?.id);
    expect(saved.version).toBe(SNAPSHOT_VERSION);
    // restore() runs once.
    expect(await server.pipeline.restore()).toMatchObject({ restored: false, replayed: 0 });
    expect(checkpoints.saves).toBe(1);
  });

  /** A saved state taken in the middle of the run, to tamper with. */
  async function savedMidRun() {
    const newId = sequentialIds();
    const checkpoints = memoryCheckpoints();
    const first = createLiveRun({ reorder: WINDOW, newId, keepEvents: true, checkpoints });
    first.pipeline.components.eventReader = memoryReader(first.events);
    await deliver(first, 0, Math.floor(batches.length / 2));
    await first.pipeline.checkpoint();
    first.pipeline.stop();
    const restart = () =>
      createLiveRun({
        reorder: WINDOW,
        newId,
        keepEvents: true,
        checkpoints,
        eventReader: memoryReader(first.events),
        continueFrom: first,
      });
    return { checkpoints, first, restart, newId };
  }

  it('a rule whose correlation block changed between runs loses its own state and nothing else', async () => {
    const ATTACKER = '203.0.113.45';
    const failures = (from: number, to: number): StreamBatch => ({
      stream: 'bastion-01/auth',
      host: 'bastion-01',
      source: 'linux_auth',
      lines: Array.from(
        { length: to - from },
        (_, i) =>
          `2026-10-25T11:00:0${from + i}Z bastion-01 sshd[4242]: Failed password for invalid user u${from + i} from ${ATTACKER} port 50022 ssh2`,
      ),
      fromMs: 0,
      toMs: 0,
    });
    const titles = (run: LiveRun) =>
      run.sink
        .list()
        .map((alert) => alert.ruleTitle)
        .sort();

    /** Five failures, a checkpoint, a restart with `tamper` applied to the saved state, five more. */
    async function restartWith(tamper: (correlations: SavedCorrelation[]) => void) {
      const newId = sequentialIds();
      const checkpoints = memoryCheckpoints();
      const first = createLiveRun({ newId, keepEvents: true, checkpoints });
      first.pipeline.components.eventReader = memoryReader(first.events);
      // Five users from one address: the brute-force window (address and host) and the
      // spraying window (address alone) are both half full.
      await first.deliver(failures(0, 5), 'evaluated');
      await first.pipeline.checkpoint();
      const saved = JSON.parse(checkpoints.saved ?? 'null') as {
        state: { engine: { correlations: SavedCorrelation[] } };
      };
      tamper(saved.state.engine.correlations);
      checkpoints.saved = JSON.stringify(saved);

      const second = createLiveRun({
        newId,
        keepEvents: true,
        checkpoints,
        eventReader: memoryReader(first.events),
        continueFrom: first,
      });
      const restored = await second.pipeline.restore();
      await second.deliver(failures(5, 10), 'evaluated');
      return { restored, titles: titles(second) };
    }
    interface SavedCorrelation {
      id: string;
      fingerprint: string;
      groups: Array<{ values: string[] }>;
    }

    const untouched = await restartWith(() => undefined);
    expect(untouched.restored.rules).toEqual({ restored: 2, dropped: 0 });
    expect(untouched.titles).toEqual([
      'SSH brute force from a single source',
      'SSH password spraying from a single source',
    ]);

    // The spraying rule groups by the address alone; pretend its block was edited.
    const changed = await restartWith((correlations) => {
      const spraying = correlations.find((c) => c.groups[0]?.values.length === 1);
      if (spraying === undefined) throw new Error('no spraying state saved');
      spraying.fingerprint = '0'.repeat(32);
      correlations.push({ id: 'a-rule-that-was-deleted', fingerprint: 'x', groups: [] });
    });
    expect(changed.restored.restored).toBe(true);
    expect(changed.restored.rules).toEqual({ restored: 1, dropped: 2 });
    // Brute force kept its five matches and fires on the tenth; spraying starts again.
    expect(changed.titles).toEqual(['SSH brute force from a single source']);
  });

  it('a saved state of another version is ignored, but its position is kept', async () => {
    const { checkpoints, first, restart } = await savedMidRun();
    const saved = JSON.parse(checkpoints.saved ?? 'null') as Checkpoint;
    checkpoints.saved = JSON.stringify({ ...saved, version: SNAPSHOT_VERSION + 1 });
    const second = restart();
    const restored = await second.pipeline.restore();
    expect(restored).toMatchObject({ restored: false, buffered: 0, replayed: 0 });
    expect(restored.ignored).toContain(`version ${SNAPSHOT_VERSION + 1}`);
    // The state that replaces it is saved at once, with the position it had.
    const replaced = JSON.parse(checkpoints.saved ?? 'null') as Checkpoint;
    expect(replaced.version).toBe(SNAPSHOT_VERSION);
    expect(replaced.position).toBe(first.events[first.events.length - 1]?.id);
  });

  it.each([
    ['not an object', 'nonsense'],
    ['a buffer that is not a buffer', { engine: null, buffer: { newest: 'soon' } }],
    [
      'correlation state with the wrong shape',
      {
        engine: { watermark: 1, lastSweep: null, correlations: [{ id: 1, groups: 'many' }] },
        buffer: { newest: null, lastReleased: null, events: [] },
      },
    ],
  ])('a malformed saved state (%s) is refused and the pipeline starts clean', async (_, state) => {
    const { checkpoints, restart } = await savedMidRun();
    const saved = JSON.parse(checkpoints.saved ?? 'null') as Checkpoint;
    checkpoints.saved = JSON.stringify({ ...saved, state });
    const second = restart();
    const restored = await second.pipeline.restore();
    expect(restored).toMatchObject({ restored: false, ignored: 'saved state is malformed' });
    expect(second.pipeline.stats().buffered).toBe(0);
    // It still works.
    const next = batches[Math.floor(batches.length / 2)];
    if (next === undefined) throw new Error('no batch');
    await expect(second.deliver(next)).resolves.toMatchObject({ rejected: 0 });
  });

  it('a failure to read the waiting events back is not a malformed state: the restore fails, the checkpoint stays and the next attempt uses it', async () => {
    const { checkpoints, first, newId } = await savedMidRun();
    const waiting = first.pipeline.stats().buffered;
    expect(waiting).toBeGreaterThan(0);
    const before = checkpoints.saved;
    const reader = memoryReader(first.events);
    let failures = 1;
    const flaky: EventReader = {
      ...reader,
      byIds(ids) {
        if (failures === 0) return reader.byIds(ids);
        failures -= 1;
        return Promise.reject(new Error('connection terminated unexpectedly'));
      },
    };
    const second = createLiveRun({
      reorder: WINDOW,
      newId,
      keepEvents: true,
      checkpoints,
      eventReader: flaky,
      continueFrom: first,
    });

    await expect(second.pipeline.restore()).rejects.toThrow('connection terminated unexpectedly');
    // Taken for malformed, the state would have been replaced by an empty one and the
    // waiting events would never be evaluated.
    expect(checkpoints.saved).toBe(before);
    expect(second.pipeline.stats().buffered).toBe(0);

    expect(await second.pipeline.restore()).toMatchObject({ restored: true, buffered: waiting });
    await deliver(second, Math.floor(batches.length / 2), batches.length);
    await second.pipeline.drain();
    expect(outcomes(second.sink)).toEqual(uninterrupted);
  }, 120_000);

  it.each([
    ['is used', (saved: Checkpoint) => saved],
    ['is of another version', (saved: Checkpoint) => ({ ...saved, version: SNAPSHOT_VERSION + 1 })],
  ])(
    'a restore that fails while it reads the events stored after the checkpoint leaves nothing behind (the saved state %s)',
    async (_, tamper) => {
      const ATTACKER = '203.0.113.45';
      const failures = (from: number, to: number): StreamBatch => ({
        stream: 'bastion-01/auth',
        host: 'bastion-01',
        source: 'linux_auth',
        lines: Array.from(
          { length: to - from },
          (_line, i) =>
            `2026-10-25T11:00:0${from + i}Z bastion-01 sshd[4242]: Failed password for root from ${ATTACKER} port 50022 ssh2`,
        ),
        fromMs: 0,
        toMs: 0,
      });
      const newId = sequentialIds();
      const checkpoints = memoryCheckpoints();
      const stored: NormalizedEvent[] = [];
      const reader = (): EventReader => memoryReader(stored);
      const first = createLiveRun({
        reorder: WINDOW,
        newId,
        checkpoints,
        eventReader: {
          byIds: (ids) => reader().byIds(ids),
          after: (position, limit) => reader().after(position, limit),
          newestId: () => reader().newestId(),
        },
        eventStore: {
          insertMany(events) {
            stored.push(...events);
            return Promise.resolve();
          },
        },
      });
      // The first start marks its place; six failures are stored after it, one per
      // request, and the server dies before the next checkpoint.
      await first.pipeline.restore();
      for (let i = 0; i < 6; i += 1) await first.deliver(failures(i, i + 1), 'evaluated');
      first.pipeline.stop();
      checkpoints.saved = JSON.stringify(
        tamper(JSON.parse(checkpoints.saved ?? 'null') as Checkpoint),
      );

      // The second page of the replay fails once, as a database that went away would.
      let pages = 0;
      const flaky: EventReader = {
        ...reader(),
        after(position) {
          pages += 1;
          if (pages === 2) return Promise.reject(new Error('connection terminated unexpectedly'));
          return reader().after(position, 4);
        },
      };
      const second = createLiveRun({
        reorder: WINDOW,
        newId,
        checkpoints,
        eventReader: flaky,
        continueFrom: first,
      });
      await expect(second.pipeline.restore()).rejects.toThrow('connection terminated unexpectedly');
      expect(second.pipeline.stats().buffered).toBe(0);

      expect(await second.pipeline.restore()).toMatchObject({ replayed: 6 });
      // Six events wait, not the four of the failed attempt and six more.
      expect(second.pipeline.stats().buffered).toBe(6);
      // Nine failures in all: one short of the brute-force rule's ten.
      await second.deliver(failures(6, 9), 'evaluated');
      await second.pipeline.drain();
      expect(second.pipeline.stats().evaluated).toBe(9);
      expect(second.sink.list().map((alert) => alert.ruleTitle)).toEqual([]);
    },
  );

  it('ingest waits for the restore: a request that arrives first is evaluated against the restored state', async () => {
    const { restart } = await savedMidRun();
    const second = restart();
    // No explicit restore(): the first delivery triggers it.
    await deliver(second, Math.floor(batches.length / 2), batches.length);
    await second.pipeline.drain();
    expect(outcomes(second.sink)).toEqual(uninterrupted);
  }, 120_000);

  it('a pipeline without a checkpoint store saves nothing', async () => {
    const run = createLiveRun({ reorder: WINDOW });
    await deliver(run, 0, 5);
    expect(await run.pipeline.checkpoint()).toBe(false);
    expect(await run.pipeline.restore()).toMatchObject({ restored: false });
  });
});
