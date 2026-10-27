import { Suspense } from 'react';
import type { RouteObject } from 'react-router';
import { LoadingState } from '../components/ui/States';
import { RequireAuth } from '../features/auth/RequireAuth';
import { NotFoundPage } from '../pages/NotFoundPage';
import { Layout } from './Layout';
import {
  AlertDetailPage,
  AlertsPage,
  AttackPage,
  EventsPage,
  IngestPage,
  LoginPage,
  OverviewPage,
  RuleDetailPage,
  RulesPage,
  SecurityPage,
} from './lazy-pages';

/**
 * Route table shared by the browser router and the memory router used in tests. The sign-in
 * page is public; every other page is behind the session gate (S6).
 */
export const routes: RouteObject[] = [
  {
    path: '/login',
    element: (
      <Suspense fallback={<LoadingState />}>
        <LoginPage />
      </Suspense>
    ),
  },
  {
    path: '/',
    element: (
      <RequireAuth>
        <Layout />
      </RequireAuth>
    ),
    children: [
      { index: true, element: <OverviewPage /> },
      { path: 'alerts', element: <AlertsPage /> },
      { path: 'alerts/:id', element: <AlertDetailPage /> },
      { path: 'events', element: <EventsPage /> },
      { path: 'attack', element: <AttackPage /> },
      { path: 'rules', element: <RulesPage /> },
      { path: 'rules/:id', element: <RuleDetailPage /> },
      { path: 'ingest', element: <IngestPage /> },
      { path: 'security', element: <SecurityPage /> },
      { path: '*', element: <NotFoundPage /> },
    ],
  },
];
