import { render } from '@testing-library/react';
import { RouterProvider, createMemoryRouter } from 'react-router';
import { Providers } from '../src/app/providers';
import { createQueryClient } from '../src/app/query-client';
import { routes } from '../src/app/routes';
import { authKeys } from '../src/features/auth/hooks';
import { MOCK_USERNAME, setMockSignedIn } from '../src/features/auth/mocks';
import type { LiveSource } from '../src/features/live/live-source';
import { createI18n, type Language } from '../src/i18n';

/**
 * How the app starts (S6):
 * - `signed-in` (default): the mock API has a session and the cache already holds it, so the
 *   dashboard renders at once, as after a sign-in.
 * - `fetch`: the mock API has a session; the auth gate fetches it first.
 * - `signed-out`: no session; protected pages redirect to the sign-in page.
 */
export type AuthStart = 'signed-in' | 'fetch' | 'signed-out';

export function renderApp({
  path = '/',
  language,
  liveSource,
  auth = 'signed-in',
}: { path?: string; language?: Language; liveSource?: LiveSource; auth?: AuthStart } = {}) {
  const i18n = createI18n(language);
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  const queryClient = createQueryClient();
  queryClient.setDefaultOptions({ queries: { retry: false, staleTime: 15_000 } });
  setMockSignedIn(auth !== 'signed-out');
  if (auth === 'signed-in') {
    queryClient.setQueryData(authKeys.session, {
      username: MOCK_USERNAME,
      expiresAt: new Date(Date.now() + 12 * 3_600_000).toISOString(),
    });
  }
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
