/**
 * Content-pack playbooks (session S7): `GET /api/rules/:id/playbook?lang=en|es`. Playbooks
 * are AI-generated from SigmaHQ rules (DRL 1.1), so the response always carries the rule's
 * attribution and the generator's notice; the dashboard shows both.
 */
import { z } from 'zod';
import { licenseSchema } from './alerts.js';

export const PLAYBOOK_LANGUAGES = ['en', 'es'] as const;
export const playbookLanguageSchema = z.enum(PLAYBOOK_LANGUAGES);
export type PlaybookLanguage = z.infer<typeof playbookLanguageSchema>;

export const playbookQuerySchema = z.object({ lang: playbookLanguageSchema.default('en') });
export type PlaybookQuery = z.infer<typeof playbookQuerySchema>;

const text = z.string().min(1).max(4000);
const textList = z.array(text).min(1).max(20);

export const playbookSchema = z.object({
  summary: text,
  whatItDetects: text,
  whyItMatters: text,
  triageSteps: textList,
  falsePositives: textList,
  responseSteps: textList,
  severityRationale: text,
});
export type Playbook = z.infer<typeof playbookSchema>;

export const playbookResponseSchema = z.object({
  ruleId: z.guid(),
  lang: playbookLanguageSchema,
  playbook: playbookSchema,
  /** Attribution of the rule the playbook was written from. */
  rule: z.object({
    title: z.string(),
    author: z.string().nullable(),
    url: z.string().nullable(),
    license: licenseSchema,
  }),
  generated: z.object({
    tool: z.string(),
    model: z.string(),
    at: z.string(),
    /** `unreviewed` until a person checks the content. */
    review: z.string(),
    notice: z.string(),
  }),
});
export type PlaybookResponse = z.infer<typeof playbookResponseSchema>;
