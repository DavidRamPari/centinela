import { render } from '@testing-library/react';
import { RouterProvider, createMemoryRouter } from 'react-router';
import { Providers } from '../src/app/providers';
import { createQueryClient } from '../src/app/query-client';
import { routes } from '../src/app/routes';
import { createI18n, type Language } from '../src/i18n';

export function renderApp({ path = '/', language }: { path?: string; language?: Language } = {}) {
  const i18n = createI18n(language);
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  const queryClient = createQueryClient();
  queryClient.setDefaultOptions({ queries: { retry: false } });
  const view = render(
    <Providers i18n={i18n} queryClient={queryClient}>
      <RouterProvider router={router} />
    </Providers>,
  );
  return { ...view, i18n, router };
}
