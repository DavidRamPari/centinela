/** Every page names itself and the product in the browser tab, in the selected language. */
import { act, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { mockDb } from '../src/mocks/handlers';
import { renderApp } from './render';

function firstAlert() {
  const alert = mockDb().alerts[0];
  if (!alert) throw new Error('fixture missing');
  return alert;
}

function firstRule() {
  const rule = mockDb().rules[0];
  if (!rule) throw new Error('fixture missing');
  return rule;
}

const cases: Array<{ name: string; path: () => string; en: () => string; es: () => string }> = [
  {
    name: 'overview',
    path: () => '/',
    en: () => 'Overview · Centinela',
    es: () => 'Resumen · Centinela',
  },
  {
    name: 'alerts',
    path: () => '/alerts',
    en: () => 'Alerts · Centinela',
    es: () => 'Alertas · Centinela',
  },
  {
    name: 'alert',
    path: () => `/alerts/${firstAlert().id}`,
    en: () => `${firstAlert().ruleTitle} · Centinela`,
    es: () => `${firstAlert().ruleTitle} · Centinela`,
  },
  {
    name: 'events',
    path: () => '/events',
    en: () => 'Events · Centinela',
    es: () => 'Eventos · Centinela',
  },
  {
    name: 'ATT&CK',
    path: () => '/attack',
    en: () => 'ATT&CK matrix · Centinela',
    es: () => 'Matriz ATT&CK · Centinela',
  },
  {
    name: 'rules',
    path: () => '/rules',
    en: () => 'Rules · Centinela',
    es: () => 'Reglas · Centinela',
  },
  {
    name: 'rule',
    path: () => `/rules/${firstRule().id}`,
    en: () => `${firstRule().title} · Centinela`,
    es: () => `${firstRule().title} · Centinela`,
  },
  {
    name: 'ingest',
    path: () => '/ingest',
    en: () => 'Ingest · Centinela',
    es: () => 'Ingesta · Centinela',
  },
  {
    name: 'security',
    path: () => '/security',
    en: () => 'Security · Centinela',
    es: () => 'Seguridad · Centinela',
  },
  {
    name: 'unknown',
    path: () => '/no-such-page',
    en: () => 'Page not found · Centinela',
    es: () => 'Página no encontrada · Centinela',
  },
  {
    name: 'missing alert',
    path: () => '/alerts/01930f6e-8a4b-7c2d-9e1f-0a1b2c3d4e5f',
    en: () => 'Alert not found · Centinela',
    es: () => 'Alerta no encontrada · Centinela',
  },
];

describe('browser tab titles', () => {
  for (const language of ['en', 'es'] as const) {
    it.each(cases)(`names the $name page in ${language}`, async (page) => {
      document.title = 'Centinela';
      renderApp({ path: page.path(), language });
      // The first page also loads its lazy chunk, which can take a moment in jsdom.
      await waitFor(() => expect(document.title).toBe(page[language]()), { timeout: 5000 });
    });
  }

  it('names the sign-in page', async () => {
    renderApp({ path: '/login', language: 'es', auth: 'signed-out' });
    await waitFor(() => expect(document.title).toBe('Iniciar sesión · Centinela'));
  });

  it('follows a language switch', async () => {
    const { i18n } = renderApp({ path: '/alerts', language: 'en' });
    await waitFor(() => expect(document.title).toBe('Alerts · Centinela'));
    await act(() => i18n.changeLanguage('es'));
    await waitFor(() => expect(document.title).toBe('Alertas · Centinela'));
    expect(screen.getByRole('heading', { level: 1, name: 'Alertas' })).toBeInTheDocument();
  });
});
