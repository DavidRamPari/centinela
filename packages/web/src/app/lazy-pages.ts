import { lazy } from 'react';

// Every page is its own chunk (PLAN S3: no chunk above 500 kB).
export const OverviewPage = lazy(() => import('../pages/OverviewPage'));
export const AlertsPage = lazy(() => import('../pages/AlertsPage'));
export const AlertDetailPage = lazy(() => import('../pages/AlertDetailPage'));
export const EventsPage = lazy(() => import('../pages/EventsPage'));
export const AttackPage = lazy(() => import('../pages/AttackPage'));
export const RulesPage = lazy(() => import('../pages/RulesPage'));
export const RuleDetailPage = lazy(() => import('../pages/RuleDetailPage'));
export const IngestPage = lazy(() => import('../pages/IngestPage'));
