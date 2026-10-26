import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { HOSTILE } from '../src/mocks/fixtures/build';
import { mockDb } from '../src/mocks/handlers';
import { renderApp } from './render';

/** No element was created from log content: only the app's own markup exists. */
function expectNoInjectedElements(container: HTMLElement) {
  expect(container.querySelector('script')).toBeNull();
  expect(container.querySelector('img')).toBeNull();
  expect(container.querySelector('[onerror]')).toBeNull();
}

describe('attacker-controlled strings render as text', () => {
  it('in the events table and the event drawer', async () => {
    const event = mockDb().events.find((e) => e.message.includes(HOSTILE.script));
    if (!event) throw new Error('fixture missing');
    const { container } = renderApp({ path: `/events?q=script&event=${event.id}`, language: 'en' });
    const dialog = await screen.findByRole('dialog', { name: 'Event detail' });
    expect(await within(dialog).findByText(event.message)).toBeInTheDocument();
    expect(within(dialog).getAllByText(`q=${HOSTILE.script}`).length).toBeGreaterThan(0);
    expect(within(dialog).getAllByText(HOSTILE.img).length).toBeGreaterThan(0);
    const table = await screen.findByRole('table', { name: /Events, newest first/ });
    expect(within(table).getByText(event.message)).toBeInTheDocument();
    expectNoInjectedElements(container);
  });

  it('in alert entities and the alert timeline', async () => {
    const alert = mockDb().alerts.find((a) => a.entities.users.includes(HOSTILE.img));
    if (!alert) throw new Error('fixture missing');
    const { container } = renderApp({ path: `/alerts/${alert.id}`, language: 'en' });
    expect(await screen.findByRole('link', { name: HOSTILE.img })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: HOSTILE.sqli })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: HOSTILE.script })).toBeInTheDocument();
    expect(
      screen.getAllByText((text) => text.includes(`Failed password for ${HOSTILE.script} from`))
        .length,
    ).toBe(1);
    expectNoInjectedElements(container);
  });

  it('in an 8,192-character line without breaking the layout', async () => {
    const event = mockDb().events.find((e) => e.message.length === 8192);
    if (!event) throw new Error('fixture missing');
    renderApp({ path: `/events?event=${event.id}`, language: 'en' });
    const dialog = await screen.findByRole('dialog', { name: 'Event detail' });
    expect(await within(dialog).findByText('Length: 8,192 characters')).toBeInTheDocument();
    const raw = within(dialog).getByLabelText('Raw message');
    expect(raw.textContent).toHaveLength(8192);
    expect(raw.className).toContain('break-all');
  });

  it('in the SQL injection payload of an event', async () => {
    const { container } = renderApp({ path: '/events?q=OR+1%3D1', language: 'en' });
    const table = await screen.findByRole('table', { name: /Events, newest first/ });
    expect(
      within(table).getByText((text) => text.includes(`id=1${HOSTILE.sqli}`)),
    ).toBeInTheDocument();
    expectNoInjectedElements(container);
  });
});
