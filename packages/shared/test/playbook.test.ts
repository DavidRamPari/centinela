import { describe, expect, it } from 'vitest';
import {
  playbookQuerySchema,
  playbookResponseSchema,
  type PlaybookResponse,
} from '../src/index.js';

const valid: PlaybookResponse = {
  ruleId: '0022869c-49f7-4ff2-ba03-85ac42ddac58',
  lang: 'es',
  playbook: {
    summary: 'Resumen.',
    whatItDetects: 'Qué detecta.',
    whyItMatters: 'Por qué importa.',
    triageSteps: ['Revise el CommandLine.'],
    falsePositives: ['Scripts de inventario.'],
    responseSteps: ['Aísle el equipo.'],
    severityRationale: 'Nivel bajo.',
  },
  rule: { title: 'System Information Discovery', author: 'lazarg', url: null, license: 'DRL-1.1' },
  generated: {
    tool: 'content-pack/1',
    model: 'claude-opus-5-5',
    at: '2026-10-26T02:47:30+00:00',
    review: 'unreviewed',
    notice: 'AI-generated content.',
  },
};

describe('playbook schemas', () => {
  it('parses a valid playbook response and rejects an invalid one', () => {
    expect(playbookResponseSchema.parse(valid)).toEqual(valid);
    expect(playbookResponseSchema.safeParse({ ...valid, lang: 'fr' }).success).toBe(false);
    expect(
      playbookResponseSchema.safeParse({
        ...valid,
        playbook: { ...valid.playbook, triageSteps: [] },
      }).success,
    ).toBe(false);
    expect(
      playbookResponseSchema.safeParse({ ...valid, rule: { ...valid.rule, license: 'GPL' } })
        .success,
    ).toBe(false);
  });

  it('defaults the language to English and accepts only en and es', () => {
    expect(playbookQuerySchema.parse({})).toEqual({ lang: 'en' });
    expect(playbookQuerySchema.parse({ lang: 'es' })).toEqual({ lang: 'es' });
    expect(playbookQuerySchema.safeParse({ lang: 'ES' }).success).toBe(false);
  });
});
