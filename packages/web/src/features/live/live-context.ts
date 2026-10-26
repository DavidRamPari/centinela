import { createContext, useContext } from 'react';
import { noLiveSource, type LiveSource } from './live-source';

export type LiveStatus = 'connecting' | 'live' | 'reconnecting';

export const LiveSourceContext = createContext<LiveSource>(noLiveSource);
export const LiveStatusContext = createContext<LiveStatus>('connecting');

export function useLiveStatus(): LiveStatus {
  return useContext(LiveStatusContext);
}
