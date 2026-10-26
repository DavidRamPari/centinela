import { QueryClientProvider, type QueryClient } from '@tanstack/react-query';
import type { i18n as I18n } from 'i18next';
import type { ReactNode } from 'react';
import { I18nextProvider } from 'react-i18next';
import { LiveSourceContext } from '../features/live/live-context';
import { defaultLiveSource, type LiveSource } from '../features/live/live-source';

interface ProvidersProps {
  i18n: I18n;
  queryClient: QueryClient;
  /** Live alert stream; defaults to EventSource on /api/stream when the browser has it. */
  liveSource?: LiveSource;
  children: ReactNode;
}

export function Providers({ i18n, queryClient, liveSource, children }: ProvidersProps) {
  return (
    <I18nextProvider i18n={i18n}>
      <QueryClientProvider client={queryClient}>
        <LiveSourceContext.Provider value={liveSource ?? defaultLiveSource()}>
          {children}
        </LiveSourceContext.Provider>
      </QueryClientProvider>
    </I18nextProvider>
  );
}
