import { z } from 'zod';
import { levelSchema, licenseSchema, ruleTypeSchema, techniqueIdSchema } from './alerts.js';
import { logSourceSchema } from './events.js';

export const RULE_ORIGINS = ['sigmahq', 'centinela'] as const;
export const ruleOriginSchema = z.enum(RULE_ORIGINS);
export type RuleOrigin = z.infer<typeof ruleOriginSchema>;

export const ruleMetaSchema = z.object({
  /** Sigma id. `z.guid()` accepts any 8-4-4-4-12 hex id, as some community rules are not RFC 9562. */
  id: z.guid(),
  name: z.string().min(1).nullable(),
  title: z.string().min(1),
  description: z.string().nullable(),
  type: ruleTypeSchema,
  level: levelSchema,
  status: z.string().nullable(),
  author: z.string().nullable(),
  references: z.array(z.string()),
  date: z.string().nullable(),
  modified: z.string().nullable(),
  tags: z.array(z.string()),
  techniques: z.array(techniqueIdSchema),
  tactics: z.array(z.string().min(1)),
  logsource: logSourceSchema.nullable(),
  falsepositives: z.array(z.string()),
  origin: ruleOriginSchema,
  /** Repository-relative path, e.g. `rules/sigma/linux/builtin/lnx_shellshock.yml`. */
  path: z.string().min(1),
  url: z.url().nullable(),
  license: licenseSchema,
  supported: z.boolean(),
  unsupportedReason: z.string().nullable(),
  buildingBlock: z.boolean(),
  enabled: z.boolean(),
});
export type RuleMeta = z.infer<typeof ruleMetaSchema>;
