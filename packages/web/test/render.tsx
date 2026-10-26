import { render } from '@testing-library/react';
import { RouterProvider, createMemoryRouter } from 'react-router';
import { Providers } from '../src/app/providers';
import { createQueryClient } from '../src/app/query-client';
import { routes } from '../src/app/routes';
import type { LiveSource } from '../src/features/live/live-source';
import { createI18n, type Language } from '../src/i18n';

export function renderApp({
  path = '/',
  language,
  liveSource,
}: { path?: string; language?: Language; liveSource?: LiveSource } = {}) {
  const i18n = createI18n(language);
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  const queryClient = createQueryClient();
  queryClient.setDefaultOptions({ queries: { retry: false, staleTime: 15_000 } });
  const view = render(
    <Providers i18n={i18n} queryClient={queryClient} liveSource={liveSource}>
      <RouterProvider router={router} />
    </Providers>,
  );
  return { ...view, i18n, router, queryClient };
}

/** Search params of the router's current location. */
export function currentSearch(router: {
  state: { location: { search: string } };
}): URLSearchParams {
  return new URLSearchParams(router.state.location.search);
}
