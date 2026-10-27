/**
 * Optimistic alert status changes (S7b-17): the new status shows at once in every cached
 * view of the alert (lists, the overview's page, the detail), and the cache goes back to
 * the snapshot if the server refuses the change. Pure helpers plus two cache operations.
 */
import type { Alert, AlertDetailResponse, Page, Resolution } from '@centinela/shared';
import type { InfiniteData, QueryClient, QueryKey } from '@tanstack/react-query';

export interface StatusChange {
  status: Alert['status'];
  resolution?: Resolution | null;
}

/** The alert after the change: closing sets the resolution, any other status clears it. */
export function withStatus(alert: Alert, change: StatusChange): Alert {
  return {
    ...alert,
    status: change.status,
    resolution: change.status === 'closed' ? (change.resolution ?? null) : null,
  };
}

type AlertPage = Page<Alert>;
/** An infinite list (the alerts page) or a single page (the overview). */
export type CachedAlertList = InfiniteData<AlertPage> | AlertPage;

function patchPage(page: AlertPage, ids: ReadonlySet<string>, change: StatusChange): AlertPage {
  return {
    ...page,
    items: page.items.map((alert) => (ids.has(alert.id) ? withStatus(alert, change) : alert)),
  };
}

/** The cached list with the change applied to the alerts in `ids`. */
export function patchAlertList(
  data: CachedAlertList,
  ids: ReadonlySet<string>,
  change: StatusChange,
): CachedAlertList {
  if ('pages' in data) {
    return { ...data, pages: data.pages.map((page) => patchPage(page, ids, change)) };
  }
  return patchPage(data, ids, change);
}

/** What the alert queries held before a change, to put back if the change fails. */
export type AlertSnapshot = ReadonlyArray<readonly [QueryKey, unknown]>;

/**
 * Applies the change to every cached view of these alerts and returns the snapshot.
 * Running fetches are cancelled first, so an answer from before the change cannot
 * overwrite it; the caller invalidates when the request settles.
 */
export async function applyStatusChange(
  queryClient: QueryClient,
  ids: readonly string[],
  change: StatusChange,
): Promise<AlertSnapshot> {
  await queryClient.cancelQueries({ queryKey: ['alerts'] });
  const snapshot = queryClient.getQueriesData({ queryKey: ['alerts'] });
  const set = new Set(ids);
  queryClient.setQueriesData<CachedAlertList>({ queryKey: ['alerts', 'list'] }, (data) =>
    data === undefined ? data : patchAlertList(data, set, change),
  );
  queryClient.setQueriesData<AlertDetailResponse>({ queryKey: ['alerts', 'detail'] }, (data) =>
    data !== undefined && set.has(data.alert.id)
      ? { ...data, alert: withStatus(data.alert, change) }
      : data,
  );
  return snapshot;
}

/** Puts the alert queries back as they were before the change. */
export function restoreAlerts(queryClient: QueryClient, snapshot: AlertSnapshot): void {
  for (const [queryKey, data] of snapshot) queryClient.setQueryData(queryKey, data);
}
