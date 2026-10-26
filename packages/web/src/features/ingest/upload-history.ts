/**
 * Results of the last uploads, kept in localStorage for this browser only (a convenience;
 * S4 may replace it with server-side history). Stored values are re-validated on read.
 */
import { ingestSummarySchema, sourceTypeSchema } from '@centinela/shared';
import { z } from 'zod';
import { readStorage, writeStorage } from '../../lib/storage';

export const UPLOAD_HISTORY_KEY = 'centinela.uploads';
export const MAX_HISTORY = 10;

export const uploadRecordSchema = z.object({
  at: z.iso.datetime(),
  fileName: z.string().max(255),
  source: sourceTypeSchema,
  host: z.string().max(255),
  summary: ingestSummarySchema,
});
export type UploadRecord = z.infer<typeof uploadRecordSchema>;

export function readUploadHistory(): UploadRecord[] {
  const raw = readStorage(UPLOAD_HISTORY_KEY);
  if (!raw) return [];
  try {
    const parsed = z.array(uploadRecordSchema).max(MAX_HISTORY).safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : [];
  } catch {
    return [];
  }
}

export function addUploadRecord(
  history: readonly UploadRecord[],
  record: UploadRecord,
): UploadRecord[] {
  const next = [record, ...history].slice(0, MAX_HISTORY);
  writeStorage(UPLOAD_HISTORY_KEY, JSON.stringify(next));
  return next;
}
