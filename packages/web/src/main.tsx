import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider, createBrowserRouter } from 'react-router';
import { Providers } from './app/providers';
import { createQueryClient } from './app/query-client';
import { routes } from './app/routes';
import { createI18n } from './i18n';
import './index.css';

async function enableMocks(): Promise<void> {
  if (import.meta.env.VITE_USE_MOCKS !== 'true') return;
  const { worker } = await import('./mocks/browser');
  await worker.start({ onUnhandledFrame: 'bypass' });
}

async function main(): Promise<void> {
  await enableMocks();
  const container = document.getElementById('root');
  if (!container) throw new Error('#root element missing from index.html');
  const router = createBrowserRouter(routes);
  createRoot(container).render(
    <StrictMode>
      <Providers i18n={createI18n()} queryClient={createQueryClient()}>
        <RouterProvider router={router} />
      </Providers>
    </StrictMode>,
  );
}

void main();
