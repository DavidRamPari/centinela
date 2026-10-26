import type { RouteObject } from 'react-router';
import { NotFoundPage } from '../pages/NotFoundPage';
import { Layout } from './Layout';
import {
  AlertDetailPage,
  AlertsPage,
  AttackPage,
  EventsPage,
  IngestPage,
  OverviewPage,
  RuleDetailPage,
  RulesPage,
} from './lazy-pages';

/** Route table shared by the browser router and the memory router used in tests. */
export const routes: RouteObject[] = [
  {
    path: '/',
    element: <Layout />,
    children: [
      { index: true, element: <OverviewPage /> },
      { path: 'alerts', element: <AlertsPage /> },
      { path: 'alerts/:id', element: <AlertDetailPage /> },
      { path: 'events', element: <EventsPage /> },
      { path: 'attack', element: <AttackPage /> },
      { path: 'rules', element: <RulesPage /> },
      { path: 'rules/:id', element: <RuleDetailPage /> },
      { path: 'ingest', element: <IngestPage /> },
      { path: '*', element: <NotFoundPage /> },
    ],
  },
];
