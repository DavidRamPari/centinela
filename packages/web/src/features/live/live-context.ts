import { createContext, useContext } from 'react';
import { noLiveSource, type LiveSource } from './live-source';

export type LiveStatus = 'connecting' | 'live' | 'reconnecting';

export const LiveSourceContext = createContext<LiveSource>(noLiveSource);
export const LiveStatusContext = createContext<LiveStatus>('connecting');

export function useLiveStatus(): LiveStatus {
  return useContext(LiveStatusContext);
}

/**
 * How long an alert that arrived live stays tinted in the lists before the tint fades
 * (S7b-17): long enough to find it, short enough not to look like a state.
 */
export const FRESH_ALERT_MS = 4000;

/** Ids of alerts that arrived live in the last `FRESH_ALERT_MS`. */
export const FreshAlertsContext = createContext<ReadonlySet<string>>(new Set());

export function useFreshAlerts(): ReadonlySet<string> {
  return useContext(FreshAlertsContext);
}
