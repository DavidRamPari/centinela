/**
 * Pipeline contracts (ARCHITECTURE §2.3). Implementations live in their owners' folders;
 * `index.ts` wires the defaults.
 */
import type {
  Alert,
  IngestAck,
  IngestSummary,
  Level,
  NormalizedEvent,
  SourceType,
} from '@centinela/shared';

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
  /** Who delivers these lines (ARCHITECTURE §8.1); default: the command line. */
  stream?: { kind: StreamKind; tokenId: string | null };
  /**
   * `evaluated` (default): the call ends after its events went through detection, so the
   * summary's alert counts are final. `stored`: the call ends once the events are stored
   * and they wait in the reorder buffer for the horizon (ARCHITECTURE §6.2).
   */
  ack?: IngestAck;
  /**
   * For a token scoped to some hosts (S11): whether a parsed event's own host is one of
   * them. An event outside is rejected with `host not allowed for this token`.
   */
  acceptsHost?: (host: string) => boolean;
}

export const STREAM_KINDS = ['token', 'upload', 'cli', 'collector', 'connector'] as const;
export type StreamKind = (typeof STREAM_KINDS)[number];

/** One delivery path: who sent events, for which source and host. */
export interface StreamKey {
  kind: StreamKind;
  tokenId: string | null;
  source: SourceType;
  host: string;
}

export interface StreamCounts {
  accepted: number;
  rejected: number;
  late: number;
  /** Newest event time accepted in the call, if any. */
  lastEventTs: Date | null;
  /** When the call was received. */
  at: Date;
}

/** A token already owns the maximum number of streams (the HTTP layer answers 403). */
export class StreamLimitError extends Error {
  constructor(limit: number) {
    super(`this token already delivers for ${limit} source and host pairs`);
    this.name = 'StreamLimitError';
  }
}

export interface StreamRegistry {
  /** The id of a stream, created on first use. Rejects with `StreamLimitError`. */
  resolve(key: StreamKey): Promise<string>;
  /** Add one call's counts to the stream and move its last signal forward. */
  record(id: string, counts: StreamCounts): Promise<void>;
}

export type ParseResult =
  { ok: true; event: Omit<NormalizedEvent, 'id' | 'ingestedAt'> } | { ok: false; reason: string };

/**
 * What a parser reads (ARCHITECTURE §4): `line`, a log line; `object`, the JSON text of one
 * event. It decides what an `application/x-ndjson` line becomes (`ingest/body.ts`).
 */
export type ParserInput = 'line' | 'object';

export interface Parser {
  readonly source: SourceType;
  readonly input: ParserInput;
  parse(line: string, ctx: IngestContext): ParseResult;
}

/** Parsers by source type (`src/parsers/index.ts`). */
export type ParserRegistry = ReadonlyMap<SourceType, Parser>;

export interface EventStore {
  insertMany(events: NormalizedEvent[], meta?: { streamId: string | null }): Promise<void>;
}

/** Reads stored events back for the detector after a restart (ARCHITECTURE §6.3). */
export interface EventReader {
  /** The events with these ids that still exist, in any order. */
  byIds(ids: readonly string[]): Promise<NormalizedEvent[]>;
  /**
   * Up to `limit` events with an id after `position` (all of them when it is null), in id
   * order, leaving out what the command line stored: its runs evaluate their own events.
   */
  after(position: string | null, limit: number): Promise<NormalizedEvent[]>;
  /** The id of the newest stored event, or null in an empty database. */
  newestId(): Promise<string | null>;
}

/** The detector's saved state (`detector_checkpoints`). */
export interface Checkpoint {
  /** Id of the last event handed to the reorder buffer. */
  position: string | null;
  version: number;
  /** The snapshot as it was saved; validated by whoever restores it. */
  state: unknown;
}

export interface CheckpointStore {
  load(): Promise<Checkpoint | null>;
  save(checkpoint: Checkpoint): Promise<void>;
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
  /**
   * Evaluate one event. The pipeline hands events over in detection-time order and passes
   * that time (epoch ms): the event's own time, or the receive time when the event claims
   * to come from the future. Without it the detector uses the event's own time.
   */
  process(event: NormalizedEvent, detectionTime?: number): AlertCandidate[];
  /** Advance event time without new events (end of a replay); returns pending matches. */
  flush(watermark: Date): AlertCandidate[];
  /** State to save across a restart, as plain JSON data; detectors without state omit it. */
  snapshot?(): unknown;
  /** Replace the state with a snapshot; throws when the snapshot is malformed. */
  restore?(snapshot: unknown): { restored: number; dropped: number };
}

export interface AlertSink {
  upsert(candidates: AlertCandidate[]): Promise<{ created: Alert[]; updated: Alert[] }>;
}

export interface AlertPublisher {
  publish(change: { type: 'alert.created' | 'alert.updated'; alert: Alert }): void;
}
