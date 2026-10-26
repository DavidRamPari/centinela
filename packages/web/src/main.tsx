import './zod-config';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider, createBrowserRouter } from 'react-router';
import { Providers } from './app/providers';
import { createQueryClient } from './app/query-client';
import { routes } from './app/routes';
import type { LiveSource } from './features/live/live-source';
import { createI18n } from './i18n';
import { applyTheme, initialTheme } from './lib/theme';
import './index.css';

/** With VITE_USE_MOCKS=true the API is served by MSW and the live stream is simulated. */
async function enableMocks(): Promise<LiveSource | undefined> {
  if (import.meta.env.VITE_USE_MOCKS !== 'true') return undefined;
  const { worker, mockLiveSource } = await import('./mocks/browser');
  await worker.start({ onUnhandledFrame: 'bypass' });
  return mockLiveSource;
}

async function main(): Promise<void> {
  applyTheme(initialTheme());
  const liveSource = await enableMocks();
  const container = document.getElementById('root');
  if (!container) throw new Error('#root element missing from index.html');
  const router = createBrowserRouter(routes);
  createRoot(container).render(
    <StrictMode>
      <Providers i18n={createI18n()} queryClient={createQueryClient()} liveSource={liveSource}>
        <RouterProvider router={router} />
      </Providers>
    </StrictMode>,
  );
}

void main();
