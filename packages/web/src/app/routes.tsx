import type { RouteObject } from 'react-router';
import { NotFoundPage } from '../pages/NotFoundPage';
import { PlaceholderPage } from '../pages/PlaceholderPage';
import { Layout } from './Layout';

/** Route table shared by the browser router and the memory router used in tests. */
export const routes: RouteObject[] = [
  {
    path: '/',
    element: <Layout />,
    children: [
      { index: true, element: <PlaceholderPage page="overview" /> },
      { path: 'alerts', element: <PlaceholderPage page="alerts" /> },
      { path: 'events', element: <PlaceholderPage page="events" /> },
      { path: 'attack', element: <PlaceholderPage page="attack" /> },
      { path: 'rules', element: <PlaceholderPage page="rules" /> },
      { path: 'ingest', element: <PlaceholderPage page="ingest" /> },
      { path: '*', element: <NotFoundPage /> },
    ],
  },
];
