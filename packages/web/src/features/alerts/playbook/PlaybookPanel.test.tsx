import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { currentSearch, renderApp } from '../../../../test/render';
import { server } from '../../../../test/setup';
import { mockDb } from '../../../mocks/handlers';
import { MOCK_HOSTILE_STEP, MOCK_RULE_WITHOUT_PLAYBOOK } from './mock';

function sigmaAlert() {
  const db = mockDb();
  const alert = db.alerts.find((a) => {
    const rule = db.rules.find((r) => r.id === a.ruleId);
    return rule?.origin === 'sigmahq' && rule.path !== MOCK_RULE_WITHOUT_PLAYBOOK;
  });
  if (!alert) throw new Error('the mock database has no SigmaHQ alert');
  return alert;
}

function centinelaAlert() {
  const alert = mockDb().alerts.find((a) => a.license === 'MIT');
  if (!alert) throw new Error('the mock database has no Centinela alert');
  return alert;
}

async function playbookCard(title: string): Promise<HTMLElement> {
  return (await screen.findByRole('heading', { name: title })).closest('section') as HTMLElement;
}

describe('PlaybookPanel', () => {
  it('shows the playbook of the alert rule with the AI label and the DRL attribution', async () => {
    const alert = sigmaAlert();
    renderApp({ path: `/alerts/${alert.id}`, language: 'en' });
    const card = await playbookCard('Playbook');
    const note = await within(card).findByRole('note');
    expect(note).toHaveTextContent('AI-generated — review before use');
    expect(
      within(card).getByText(
        `The rule "${alert.ruleTitle}" matched. Confirm whether the activity was expected.`,
      ),
    ).toBeInTheDocument();
    for (const heading of [
      'What it detects',
      'Why it matters',
      'Triage steps',
      'False positives',
      'Response steps',
      'Why this level',
    ]) {
      expect(within(card).getByRole('heading', { name: heading })).toBeInTheDocument();
    }
    expect(within(card).getAllByRole('list')).toHaveLength(3);
    // Attribution required by DRL 1.1: the rule (linked), its author and the license.
    const ruleLink = within(card).getByRole('link', { name: new RegExp(alert.ruleTitle) });
    expect(ruleLink).toHaveAttribute('href', alert.ruleUrl ?? '');
    expect(within(card).getByText(alert.author ?? '')).toBeInTheDocument();
    expect(
      within(card).getByRole('link', { name: /Detection Rule License \(DRL\) 1\.1/ }),
    ).toBeInTheDocument();
    expect(within(card).getByText('Not reviewed yet')).toBeInTheDocument();
  });

  it('shows the Spanish playbook in Spanish and follows the language toggle', async () => {
    const alert = sigmaAlert();
    const { i18n } = renderApp({ path: `/alerts/${alert.id}`, language: 'es' });
    const card = await playbookCard('Guía de respuesta');
    expect(await within(card).findByRole('note')).toHaveTextContent(
      'Generada con IA — revísala antes de usarla',
    );
    expect(
      within(card).getByRole('heading', { name: 'Pasos de clasificación' }),
    ).toBeInTheDocument();
    expect(within(card).getByText(/Confirma si la actividad era esperada/)).toBeInTheDocument();
    await i18n.changeLanguage('en');
    expect(
      await within(await playbookCard('Playbook')).findByText(
        /Confirm whether the activity was expected/,
      ),
    ).toBeInTheDocument();
  });

  it('shows an empty state for rules without a playbook', async () => {
    renderApp({ path: `/alerts/${centinelaAlert().id}`, language: 'en' });
    const card = await playbookCard('Playbook');
    // Centinela's own rules: playbooks come later, and the panel says so calmly.
    expect(
      await within(card).findByText("Playbooks for Centinela's own rules are on the way"),
    ).toBeInTheDocument();
    expect(within(card).queryByRole('note')).not.toBeInTheDocument();
    expect(within(card).queryByRole('alert')).not.toBeInTheDocument();

    const rule = mockDb().rules.find((r) => r.path === MOCK_RULE_WITHOUT_PLAYBOOK);
    renderApp({ path: `/rules/${rule?.id ?? ''}`, language: 'es' });
    expect(await screen.findByText('Esta regla no tiene guía de respuesta')).toBeInTheDocument();
    expect(screen.getByText(/El paquete de contenido no tiene guía/)).toBeInTheDocument();
  });

  it('renders playbook text as text, never as HTML', async () => {
    const { container } = renderApp({ path: `/alerts/${sigmaAlert().id}`, language: 'en' });
    expect(await screen.findByText(MOCK_HOSTILE_STEP)).toBeInTheDocument();
    expect(container.querySelector('img')).toBeNull();
  });

  it('shows an error with a retry button when the playbook cannot be loaded', async () => {
    server.use(http.get('/api/rules/:id/playbook', () => new Response('boom', { status: 500 })));
    renderApp({ path: `/alerts/${sigmaAlert().id}`, language: 'en' });
    const card = await playbookCard('Playbook');
    const error = await within(card).findByRole('alert');
    expect(error).toHaveTextContent('500');

    server.resetHandlers();
    await userEvent.setup().click(within(error).getByRole('button', { name: 'Try again' }));
    expect(await within(card).findByRole('note')).toBeInTheDocument();
  });

  it('shows the playbook on the rule detail page and asks for the UI language', async () => {
    const alert = sigmaAlert();
    const languages: string[] = [];
    server.use(
      http.get('/api/rules/:id/playbook', ({ request }) => {
        languages.push(new URL(request.url).searchParams.get('lang') ?? '');
        return HttpResponse.json(
          {
            type: 'about:blank',
            title: 'Not Found',
            status: 404,
            detail: 'No playbook for this rule',
          },
          { status: 404, headers: { 'Content-Type': 'application/problem+json' } },
        );
      }),
    );
    const { router } = renderApp({ path: `/rules/${alert.ruleId}`, language: 'es' });
    expect(await screen.findByText('Esta regla no tiene guía de respuesta')).toBeInTheDocument();
    expect(languages).toEqual(['es']);
    expect(currentSearch(router).toString()).toBe('');
  });
});
