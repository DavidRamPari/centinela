/**
 * Mock playbooks for MSW (tests and `VITE_USE_MOCKS=true`). The real content pack is 15 MB,
 * too much for the mock bundle, so each SigmaHQ rule of the mock database gets a short
 * playbook built from its metadata. Centinela's rules and one SigmaHQ rule have none, as in
 * the real pack (ten vendored rules have no content). One step holds a hostile string to
 * prove the panel renders playbooks as text.
 */
import type { PlaybookLanguage, PlaybookResponse, RuleMeta } from '@centinela/shared';

/** SigmaHQ rule of the mock database without a playbook. */
export const MOCK_RULE_WITHOUT_PLAYBOOK = 'rules/sigma/linux/builtin/lnx_buffer_overflows.yml';

export const MOCK_HOSTILE_STEP = '<img src=x onerror="alert(1)"> Check the parent process.';

const TEXT = {
  en: {
    summary: (title: string) =>
      `The rule "${title}" matched. Confirm whether the activity was expected.`,
    detects: (description: string) => description,
    matters: 'Unexpected activity of this kind often precedes privilege escalation or persistence.',
    triage: [
      'Review the full event and the fields the rule uses.',
      MOCK_HOSTILE_STEP,
      'Look for related alerts on the same host within 15 minutes.',
    ],
    response: [
      'Confirm with the system owner.',
      'Contain the host if the activity is not explained.',
    ],
    severity: (level: string) => `Level ${level} reflects how specific the rule is.`,
    noFalsePositives: 'Administrative activity.',
  },
  es: {
    summary: (title: string) =>
      `La regla "${title}" coincidió. Confirma si la actividad era esperada.`,
    detects: (description: string) => description,
    matters:
      'Una actividad inesperada de este tipo suele preceder a una escalada de privilegios o a persistencia.',
    triage: [
      'Revisa el evento completo y los campos que usa la regla.',
      MOCK_HOSTILE_STEP,
      'Busca alertas relacionadas en el mismo host en 15 minutos.',
    ],
    response: [
      'Confirma con el responsable del sistema.',
      'Contén el equipo si la actividad no tiene explicación.',
    ],
    severity: (level: string) => `El nivel ${level} refleja lo específica que es la regla.`,
    noFalsePositives: 'Actividad administrativa.',
  },
} as const;

export function mockPlaybook(rule: RuleMeta, lang: PlaybookLanguage): PlaybookResponse | null {
  if (rule.origin !== 'sigmahq' || rule.path === MOCK_RULE_WITHOUT_PLAYBOOK) return null;
  const text = TEXT[lang];
  return {
    ruleId: rule.id,
    lang,
    playbook: {
      summary: text.summary(rule.title),
      whatItDetects: text.detects(rule.description ?? rule.title),
      whyItMatters: text.matters,
      triageSteps: [...text.triage],
      falsePositives:
        rule.falsepositives.length > 0 ? rule.falsepositives : [text.noFalsePositives],
      responseSteps: [...text.response],
      severityRationale: text.severity(rule.level),
    },
    rule: { title: rule.title, author: rule.author, url: rule.url, license: rule.license },
    generated: {
      tool: 'content-pack/1',
      model: 'claude-opus-5-5',
      at: '2026-10-26T02:47:30+00:00',
      review: 'unreviewed',
      notice: 'AI-generated content. Review it before relying on it.',
    },
  };
}
