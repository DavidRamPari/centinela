/**
 * zod schemas for rule YAML (ARCHITECTURE §5.1, §6). Rule files are trusted repository
 * content, but they are still validated at the boundary: a file that does not have a
 * title, a GUID id and a level is reported as a load error, not half-loaded.
 */
import { levelSchema } from '@centinela/shared';
import { z } from 'zod';

/** A scalar list (or a single scalar) as strings; other entries are dropped. */
const textList = z
  .unknown()
  .optional()
  .transform((value): string[] => {
    if (value === undefined || value === null) return [];
    const list = Array.isArray(value) ? (value as unknown[]) : [value];
    return list
      .filter((item) => ['string', 'number', 'boolean'].includes(typeof item))
      .map((item) => String(item as string | number | boolean));
  });

/** Optional text; YAML may read dates or numbers as numbers. */
const optionalText = z
  .union([z.string(), z.number()])
  .nullish()
  .transform((value) => (value === undefined || value === null ? null : String(value)));

const logsourceSchema = z.object({
  product: z.string().min(1).optional(),
  service: z.string().min(1).optional(),
  category: z.string().min(1).optional(),
  definition: z.unknown().optional(),
});

export const ruleHeaderSchema = z.object({
  title: z.string().trim().min(1),
  id: z.guid(),
  name: z.string().trim().min(1).optional(),
  status: z.string().optional(),
  description: optionalText,
  author: optionalText,
  references: textList,
  date: optionalText,
  modified: optionalText,
  tags: textList,
  level: levelSchema,
  falsepositives: textList,
  logsource: logsourceSchema.optional(),
  detection: z.record(z.string(), z.unknown()).optional(),
  correlation: z.record(z.string(), z.unknown()).optional(),
});
export type RuleHeader = z.infer<typeof ruleHeaderSchema>;

export const correlationBlockSchema = z.object({
  type: z.string().min(1),
  rules: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]),
  'group-by': z.array(z.string().min(1)).optional(),
  timespan: z.string().optional(),
  /** Alias accepted for `timespan` (the name later versions of the specification use). */
  timeframe: z.string().optional(),
  condition: z.record(z.string(), z.union([z.number(), z.string()])).optional(),
  generate: z.boolean().optional(),
  aliases: z.unknown().optional(),
});
export type CorrelationBlock = z.infer<typeof correlationBlockSchema>;

/** First zod issue as `path: message`, for load errors and unsupported reasons. */
export function describeIssue(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) return 'invalid';
  const path = issue.path.length > 0 ? issue.path.join('.') : '(root)';
  return `${path}: ${issue.message}`;
}
