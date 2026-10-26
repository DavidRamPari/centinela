/**
 * Replay log files through a pipeline, one file per `ingest` call (as `npm run ingest`
 * does). Each file must be in time order; correlation state is per group, so files from
 * different hosts can follow each other. Used by `npm run demo` and the end-to-end test.
 */
import type { SourceType } from '@centinela/shared';
import type { Pipeline } from './orchestrator.js';
import type { IngestSummary } from './types.js';

export interface ReplayFile {
  /** Label for reports, e.g. `bastion-01/auth.log`. */
  path: string;
  source: SourceType;
  host: string;
  lines: Iterable<string> | AsyncIterable<string>;
}

export interface ReplayResult {
  files: Array<{ path: string; summary: IngestSummary }>;
  accepted: number;
  rejected: number;
  alertsCreated: number;
  alertsUpdated: number;
  durationMs: number;
}

export async function replayFiles(
  pipeline: Pipeline,
  files: readonly ReplayFile[],
  receivedAt: Date = new Date(),
): Promise<ReplayResult> {
  const result: ReplayResult = {
    files: [],
    accepted: 0,
    rejected: 0,
    alertsCreated: 0,
    alertsUpdated: 0,
    durationMs: 0,
  };
  for (const file of files) {
    const summary = await pipeline.ingest(file.lines, {
      source: file.source,
      host: file.host,
      timezone: 'UTC',
      receivedAt,
    });
    result.files.push({ path: file.path, summary });
    result.accepted += summary.accepted;
    result.rejected += summary.rejected;
    result.alertsCreated += summary.alertsCreated;
    result.alertsUpdated += summary.alertsUpdated;
    result.durationMs += summary.durationMs;
  }
  return result;
}
