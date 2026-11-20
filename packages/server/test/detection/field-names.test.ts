/**
 * Field names without regard to ASCII case (ARCHITECTURE §5.3, S11): shippers rename keys,
 * so a rule's `CommandLine` must find an event key `commandline`. The exact spelling wins;
 * otherwise the first key in the event's own order; only A to Z fold.
 */
import { join } from 'node:path';
import type { NormalizedEvent } from '@centinela/shared';
import { describe, expect, it } from 'vitest';
import { FILE_SOURCES, generate } from '../../../loggen/src/index.js';
import { asciiEqualIgnoringCase, asciiLower, EventView } from '../../src/detection/event-view.js';
import { createDetector } from '../../src/detection/index.js';
import { sysmonParser } from '../../src/parsers/sysmon/index.js';
import { repoRoot } from '../../src/paths.js';
import { fieldMatches } from './helpers.js';

const view = (fields: Record<string, string>) => new EventView({ message: '', fields });

describe('the event view', () => {
  it('finds a field whatever the ASCII case of the event key', () => {
    const lower = view({ commandline: 'whoami /all', image: 'C:\\Windows\\cmd.exe' });
    expect(lower.text('CommandLine')).toBe('whoami /all');
    expect(lower.value('IMAGE')).toBe('C:\\Windows\\cmd.exe');
    expect(lower.has('Image')).toBe(true);
    expect(lower.text('ParentImage')).toBeUndefined();
  });

  it('prefers the exact spelling, then the first key in the event order', () => {
    expect(view({ commandline: 'first', CommandLine: 'exact' }).text('CommandLine')).toBe('exact');
    expect(view({ COMMANDLINE: 'first', commandline: 'second' }).text('CommandLine')).toBe('first');
    expect(view({ commandline: 'first', COMMANDLINE: 'second' }).text('CommandLine')).toBe('first');
  });

  it('folds A to Z only', () => {
    // U+0130 (İ) and U+212A (Kelvin sign) lower-case to i and k outside ASCII.
    expect(view({ '\u0130mage': 'x' }).text('image')).toBeUndefined();
    expect(view({ '\u212Aey': 'x' }).text('key')).toBeUndefined();
    expect(view({ 'user@name': 'x' }).text('user`name')).toBeUndefined();
    expect(view({ 'a[b': 'x' }).text('a{b')).toBeUndefined();
    expect(asciiEqualIgnoringCase('Hashes', 'hASHES')).toBe(true);
    expect(asciiEqualIgnoringCase('Hash', 'Hashes')).toBe(false);
    expect(asciiLower('Ünïcode İmage')).toBe('Ünïcode İmage'.replace('U', 'u'));
    expect(asciiLower('CommandLine')).toBe('commandline');
  });

  it('applies to detection items and field references', () => {
    expect(
      fieldMatches('CommandLine|contains', 'whoami', { fields: { commandline: 'whoami' } }),
    ).toBe(true);
    expect(
      fieldMatches('Image|fieldref', 'ParentImage', {
        fields: { image: 'C:\\a.exe', parentimage: 'C:\\A.EXE' },
      }),
    ).toBe(true);
    expect(fieldMatches('CommandLine|cased', 'Whoami', { fields: { commandline: 'whoami' } })).toBe(
      false,
    );
  });
});

describe('the repository rules on events with renamed keys', () => {
  const RECEIVED_AT = new Date('2026-10-26T00:00:00Z');

  /** Loggen's Windows data through the sysmon parser, with every field key lower-cased. */
  function sysmonEvents(lowerKeys: boolean): NormalizedEvent[] {
    const lines = generate({
      seed: 42,
      days: 3,
      startMs: Date.parse('2026-10-20T00:00:00Z'),
      small: true,
    }).lines.filter((line) => FILE_SOURCES[line.file] === 'sysmon');
    const events = lines.map((line, index): NormalizedEvent => {
      const parsed = sysmonParser.parse(line.text, {
        source: 'sysmon',
        host: 'unknown',
        receivedAt: RECEIVED_AT,
        timezone: 'UTC',
      });
      if (!parsed.ok) throw new Error(parsed.reason);
      const fields = lowerKeys
        ? Object.fromEntries(
            Object.entries(parsed.event.fields).map(([k, v]) => [k.toLowerCase(), v]),
          )
        : parsed.event.fields;
      return {
        ...parsed.event,
        fields,
        id: `01930f6e-8a4b-7c2d-9e1f-${index.toString(16).padStart(12, '0')}`,
        ingestedAt: RECEIVED_AT.toISOString(),
      };
    });
    return events.sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
  }

  it('a Windows rule matches an event whose keys are lower-cased, as it does the original', () => {
    const run = (events: NormalizedEvent[]) => {
      const detector = createDetector({ rulesDir: join(repoRoot, 'rules') });
      const fired: string[] = [];
      for (const event of events) {
        for (const candidate of detector.process(event)) fired.push(candidate.rule.id);
      }
      for (const candidate of detector.flush(new Date('2030-01-01T00:00:00Z'))) {
        fired.push(candidate.rule.id);
      }
      return fired;
    };
    const original = run(sysmonEvents(false));
    expect(original.length).toBeGreaterThan(0);
    expect(run(sysmonEvents(true))).toEqual(original);
  });
});
