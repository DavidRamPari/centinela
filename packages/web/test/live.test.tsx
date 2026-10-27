import { act, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { backoffDelay } from '../src/features/live/live-source';
import { mockDb } from '../src/mocks/handlers';
import { createFakeLiveSource } from './live-fake';
import { renderApp } from './render';

afterEach(() => {
  vi.useRealTimers();
});

function newAlert() {
  const template = mockDb().alerts.find(
    (a) => a.ruleTitle === 'SSH brute force followed by a successful login',
  );
  if (!template) throw new Error('fixture missing');
  const now = new Date().toISOString();
  const alert = {
    ...template,
    id: '019a1b2c-3d4e-7f00-8a00-0000000000aa',
    status: 'new' as const,
    resolution: null,
    firstSeen: now,
    lastSeen: now,
    createdAt: now,
    updatedAt: now,
    ruleTitle: 'Live brute force alert',
  };
  return alert;
}

describe('live updates (SSE)', () => {
  it('shows a toast and refreshes the alerts list when an alert is created', async () => {
    const live = createFakeLiveSource();
    renderApp({ path: '/alerts', language: 'en', liveSource: live.source });
    const table = await screen.findByRole('table', { name: /Alerts, newest first/ });
    act(() => live.open());
    expect(await screen.findByText('Live updates on')).toBeInTheDocument();

    const alert = newAlert();
    mockDb().alerts.unshift(alert); // the server stored it before publishing
    act(() => live.emit('alert.created', alert));

    const region = screen.getByRole('region', { name: 'Notifications' });
    expect(await within(region).findByText('New alert')).toBeInTheDocument();
    expect(within(region).getByText('Live brute force alert')).toBeInTheDocument();
    expect(within(region).getByRole('link', { name: 'Open alert' })).toHaveAttribute(
      'href',
      `/alerts/${alert.id}`,
    );
    await waitFor(() =>
      expect(within(table).getByText('Live brute force alert')).toBeInTheDocument(),
    );
  });

  it('ignores malformed messages and alert.updated does not toast', async () => {
    const live = createFakeLiveSource();
    renderApp({ path: '/alerts', language: 'en', liveSource: live.source });
    await screen.findByRole('table', { name: /Alerts, newest first/ });
    act(() => {
      live.open();
      live.emit('alert.created', 'not json');
      live.emit('alert.created', JSON.stringify({ id: '<script>' }));
      live.emit('alert.updated', newAlert());
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(
      within(screen.getByRole('region', { name: 'Notifications' })).queryAllByRole('status'),
    ).toHaveLength(0);
  });

  it('reconnects with backoff after an error', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const live = createFakeLiveSource();
    renderApp({ path: '/', language: 'en', liveSource: live.source });
    act(() => live.open());
    act(() => live.fail());
    expect(await screen.findByText('Reconnecting live updates…')).toBeInTheDocument();
    expect(live.connections).toHaveLength(1);
    await act(() => vi.advanceTimersByTimeAsync(1000));
    expect(live.connections).toHaveLength(2);
    act(() => live.open());
    expect(await screen.findByText('Live updates on')).toBeInTheDocument();
  });

  it('backs off exponentially up to 30 seconds', () => {
    expect([1, 2, 3, 4, 5, 6, 10].map(backoffDelay)).toEqual([
      1000, 2000, 4000, 8000, 16000, 30000, 30000,
    ]);
  });
});
