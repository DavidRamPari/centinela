// @vitest-environment node
import type { Alert, AlertDetailResponse, Page } from '@centinela/shared';
import { QueryClient, type InfiniteData } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import {
  applyStatusChange,
  patchAlertList,
  restoreAlerts,
  withStatus,
} from '../src/api/optimistic';
import { mockDb } from '../src/mocks/handlers';

function fixtures(): [Alert, Alert] {
  const [first, second] = mockDb().alerts;
  if (!first || !second) throw new Error('fixtures missing');
  return [
    { ...first, status: 'new', resolution: null },
    { ...second, status: 'closed', resolution: 'false_positive' },
  ];
}

describe('optimistic status changes', () => {
  it('sets a resolution only when closing', () => {
    const [open, closed] = fixtures();
    expect(withStatus(open, { status: 'closed', resolution: 'true_positive' })).toMatchObject({
      status: 'closed',
      resolution: 'true_positive',
    });
    expect(withStatus(closed, { status: 'new' })).toMatchObject({
      status: 'new',
      resolution: null,
    });
    expect(withStatus(open, { status: 'acknowledged', resolution: 'benign' }).resolution).toBe(
      null,
    );
  });

  it('patches only the listed alerts, in a single page or in every page of a list', () => {
    const [a, b] = fixtures();
    const page: Page<Alert> = { items: [a, b], nextCursor: null };
    const ids = new Set([a.id]);
    const single = patchAlertList(page, ids, { status: 'acknowledged' });
    expect('items' in single && single.items.map((alert) => alert.status)).toEqual([
      'acknowledged',
      'closed',
    ]);
    const infinite: InfiniteData<Page<Alert>> = {
      pages: [{ items: [b], nextCursor: 'x' }, page],
      pageParams: [undefined, 'x'],
    };
    const patched = patchAlertList(infinite, ids, { status: 'acknowledged' });
    expect('pages' in patched && patched.pages.map((p) => p.items.map((x) => x.status))).toEqual([
      ['closed'],
      ['acknowledged', 'closed'],
    ]);
    // The input is not mutated: the snapshot stays valid for a rollback.
    expect(a.status).toBe('new');
  });

  it('updates every cached view at once and restores the snapshot', async () => {
    const [a, b] = fixtures();
    const client = new QueryClient();
    const listKey = ['alerts', 'list', { status: ['new'] }];
    const detailKey = ['alerts', 'detail', a.id];
    const otherDetail = ['alerts', 'detail', b.id];
    const detail = (alert: Alert): AlertDetailResponse => ({ alert, rule: null, events: [] });
    client.setQueryData(listKey, { items: [a, b], nextCursor: null });
    client.setQueryData(detailKey, detail(a));
    client.setQueryData(otherDetail, detail(b));

    const snapshot = await applyStatusChange(client, [a.id], { status: 'acknowledged' });
    expect(client.getQueryData<Page<Alert>>(listKey)?.items[0]?.status).toBe('acknowledged');
    expect(client.getQueryData<AlertDetailResponse>(detailKey)?.alert.status).toBe('acknowledged');
    expect(client.getQueryData<AlertDetailResponse>(otherDetail)?.alert.status).toBe('closed');

    restoreAlerts(client, snapshot);
    expect(client.getQueryData<Page<Alert>>(listKey)?.items[0]?.status).toBe('new');
    expect(client.getQueryData<AlertDetailResponse>(detailKey)?.alert.status).toBe('new');
  });
});
