/**
 * Pipeline contracts (ARCHITECTURE §2.3). Implementations live in their owners' folders;
 * `index.ts` wires the defaults.
 */
import type { Alert, IngestSummary, Level, NormalizedEvent, SourceType } from '@centinela/shared';

export type { IngestSummary };

export interface IngestContext {
  source: SourceType;
  /** Default host when the line does not carry one. */
  host: string;
  receivedAt: Date;
  /** IANA zone for timestamps without offset; default 'UTC'. */
  timezone: string;
  /** For RFC 3164 timestamps; default receivedAt's year. */
  defaultYear?: number;
}

export type ParseResult =
  { ok: true; event: Omit<NormalizedEvent, 'id' | 'ingestedAt'> } | { ok: false; reason: string };

export interface Parser {
  readonly source: SourceType;
  parse(line: string, ctx: IngestContext): ParseResult;
}

/** Parsers by source type (`src/parsers/index.ts`). */
export type ParserRegistry = ReadonlyMap<SourceType, Parser>;

export interface EventStore {
  insertMany(events: NormalizedEvent[]): Promise<void>;
}

/** Snapshot of the rule, so the sink can build a full Alert without a rule lookup. */
export interface AlertRuleInfo {
  id: string;
  title: string;
  type: 'sigma' | 'correlation';
  level: Level;
  techniques: string[];
  tactics: string[];
  author: string | null;
  url: string | null;
  license: 'DRL-1.1' | 'MIT';
}

export interface AlertCandidate {
  rule: AlertRuleInfo;
  dedupKey: string;
  groupKey: string | null;
  /** Contributing events, oldest first, at most 100. */
  eventIds: string[];
  /** ISO 8601 */
  firstSeen: string;
  lastSeen: string;
  host: string | null;
  entities: { ips: string[]; users: string[]; hosts: string[] };
}

export interface Detector {
  /** Evaluate one event (events arrive in event-time order per batch). */
  process(event: NormalizedEvent): AlertCandidate[];
  /** Advance event time without new events (end of a replay); returns pending matches. */
  flush(watermark: Date): AlertCandidate[];
}

export interface AlertSink {
  upsert(candidates: AlertCandidate[]): Promise<{ created: Alert[]; updated: Alert[] }>;
}

export interface AlertPublisher {
  publish(change: { type: 'alert.created' | 'alert.updated'; alert: Alert }): void;
}
