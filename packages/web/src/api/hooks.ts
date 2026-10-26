/**
 * TanStack Query hooks over the typed client. Query keys start with the resource name so a
 * mutation or a live update can invalidate every view of that resource at once.
 */
import type {
  AlertBulkBody,
  AlertPatchBody,
  IngestQuery,
  Page,
  RulePatchBody,
} from '@centinela/shared';
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type InfiniteData,
} from '@tanstack/react-query';
import { api, type QueryParams } from './client';

export const queryKeys = {
  health: ['health'] as const,
  events: (params: QueryParams) => ['events', 'list', params] as const,
  event: (id: string) => ['events', 'detail', id] as const,
  alerts: (params: QueryParams) => ['alerts', 'list', params] as const,
  alert: (id: string) => ['alerts', 'detail', id] as const,
  rules: (params: QueryParams) => ['rules', 'list', params] as const,
  rule: (id: string) => ['rules', 'detail', id] as const,
  stats: (params: QueryParams) => ['stats', params] as const,
  attack: (params: QueryParams) => ['attack', params] as const,
};

/** Roots invalidated when alerts change (triage, live updates). */
export const ALERT_DEPENDENT_KEYS = [['alerts'], ['stats'], ['attack'], ['rules']] as const;

export function useHealth() {
  return useQuery({
    queryKey: queryKeys.health,
    queryFn: ({ signal }) => api.health(signal),
    refetchInterval: 30_000,
    retry: false,
  });
}

/** Flattens the pages of an infinite (keyset) query. */
export function flattenPages<T>(data: InfiniteData<Page<T>> | undefined): T[] {
  return data?.pages.flatMap((page) => page.items) ?? [];
}

function nextCursor<T>(page: Page<T>): string | undefined {
  return page.nextCursor ?? undefined;
}

export function useEventsList(params: QueryParams) {
  return useInfiniteQuery({
    queryKey: queryKeys.events(params),
    queryFn: ({ pageParam, signal }) => api.listEvents({ ...params, cursor: pageParam }, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: nextCursor,
  });
}

export function useEvent(id: string | undefined) {
  return useQuery({
    queryKey: queryKeys.event(id ?? ''),
    queryFn: ({ signal }) => api.getEvent(id ?? '', signal),
    enabled: id !== undefined,
  });
}

export function useAlertsList(params: QueryParams) {
  return useInfiniteQuery({
    queryKey: queryKeys.alerts(params),
    queryFn: ({ pageParam, signal }) => api.listAlerts({ ...params, cursor: pageParam }, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: nextCursor,
  });
}

/** One page of alerts (the overview's latest alerts). */
export function useAlertsPage(params: QueryParams) {
  return useQuery({
    queryKey: queryKeys.alerts(params),
    queryFn: ({ signal }) => api.listAlerts(params, signal),
  });
}

export function useAlert(id: string) {
  return useQuery({
    queryKey: queryKeys.alert(id),
    queryFn: ({ signal }) => api.getAlert(id, signal),
  });
}

function useInvalidateAlerts() {
  const queryClient = useQueryClient();
  return () =>
    Promise.all(
      ALERT_DEPENDENT_KEYS.map((queryKey) => queryClient.invalidateQueries({ queryKey })),
    );
}

export function useUpdateAlert(id: string) {
  const invalidate = useInvalidateAlerts();
  return useMutation({
    mutationFn: (body: AlertPatchBody) => api.updateAlert(id, body),
    onSuccess: invalidate,
  });
}

export function useBulkUpdateAlerts() {
  const invalidate = useInvalidateAlerts();
  return useMutation({
    mutationFn: (body: AlertBulkBody) => api.bulkUpdateAlerts(body),
    onSuccess: invalidate,
  });
}

export function useRulesList(params: QueryParams) {
  return useInfiniteQuery({
    queryKey: queryKeys.rules(params),
    queryFn: ({ pageParam, signal }) => api.listRules({ ...params, cursor: pageParam }, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: nextCursor,
  });
}

export function useRule(id: string) {
  return useQuery({
    queryKey: queryKeys.rule(id),
    queryFn: ({ signal }) => api.getRule(id, signal),
  });
}

export function useUpdateRule(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: RulePatchBody) => api.updateRule(id, body),
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: ['rules'] }),
        queryClient.invalidateQueries({ queryKey: ['attack'] }),
      ]),
  });
}

export function useOverviewStats(params: QueryParams) {
  return useQuery({
    queryKey: queryKeys.stats(params),
    queryFn: ({ signal }) => api.overviewStats(params, signal),
  });
}

export function useAttackMatrix(params: QueryParams) {
  return useQuery({
    queryKey: queryKeys.attack(params),
    queryFn: ({ signal }) => api.attackMatrix(params, signal),
  });
}

export function useUploadLog() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ query, text }: { query: IngestQuery; text: string }) =>
      api.uploadLog(query, text),
    onSuccess: () =>
      Promise.all(
        [['events'], ...ALERT_DEPENDENT_KEYS].map((queryKey) =>
          queryClient.invalidateQueries({ queryKey }),
        ),
      ),
  });
}
