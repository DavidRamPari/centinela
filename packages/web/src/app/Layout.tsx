import { clsx } from 'clsx';
import {
  Activity,
  Bell,
  FileUp,
  Grid3x3,
  KeyRound,
  LayoutDashboard,
  ScrollText,
  ShieldHalf,
} from 'lucide-react';
import { Suspense, type ComponentType, type SVGProps } from 'react';
import { useTranslation } from 'react-i18next';
import { NavLink, Outlet } from 'react-router';
import { HealthBadge } from '../components/ui/HealthBadge';
import { LanguageToggle } from '../components/ui/LanguageToggle';
import { LoadingState } from '../components/ui/States';
import { ThemeToggle } from '../components/ui/ThemeToggle';
import { ToastProvider } from '../components/ui/Toasts';
import { SessionMenu } from '../features/auth/SessionMenu';
import { LiveIndicator } from '../features/live/LiveIndicator';
import { LiveUpdates } from '../features/live/LiveUpdates';

type NavKey = 'overview' | 'alerts' | 'events' | 'attack' | 'rules' | 'ingest' | 'security';

const NAV_ITEMS: ReadonlyArray<{
  to: string;
  key: NavKey;
  icon: ComponentType<SVGProps<SVGSVGElement>>;
}> = [
  { to: '/', key: 'overview', icon: LayoutDashboard },
  { to: '/alerts', key: 'alerts', icon: Bell },
  { to: '/events', key: 'events', icon: Activity },
  { to: '/attack', key: 'attack', icon: Grid3x3 },
  { to: '/rules', key: 'rules', icon: ScrollText },
  { to: '/ingest', key: 'ingest', icon: FileUp },
  { to: '/security', key: 'security', icon: KeyRound },
];

/**
 * Sidebar layout: navigation on the left (top bar on small screens), page content on the
 * right. Toasts and live updates live here, inside the router, so toasts can link to pages.
 */
export function Layout() {
  return (
    <ToastProvider>
      <LiveUpdates>
        <Shell />
      </LiveUpdates>
    </ToastProvider>
  );
}

function Shell() {
  const { t } = useTranslation();
  return (
    <div className="flex min-h-screen flex-col md:flex-row">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-10 focus:rounded focus:bg-surface-2 focus:px-3 focus:py-2"
      >
        {t('app.skipToContent')}
      </a>
      <aside className="border-b border-line bg-surface md:sticky md:top-0 md:h-screen md:w-56 md:shrink-0 md:border-b-0 md:border-r">
        <div className="flex items-center gap-2 px-4 py-4">
          <ShieldHalf aria-hidden="true" className="size-6 text-accent" />
          <div>
            <p className="font-semibold text-fg">{t('app.name')}</p>
            <p className="text-xs text-muted">{t('app.tagline')}</p>
          </div>
        </div>
        <nav aria-label={t('app.mainNavigation')} className="px-2 pb-3">
          <ul className="flex gap-1 overflow-x-auto md:flex-col">
            {NAV_ITEMS.map(({ to, key, icon: Icon }) => (
              <li key={key}>
                <NavLink
                  to={to}
                  end={to === '/'}
                  className={({ isActive }) =>
                    clsx(
                      'flex items-center gap-2 whitespace-nowrap rounded-md px-3 py-2',
                      isActive
                        ? 'bg-surface-2 font-medium text-fg'
                        : 'text-muted hover:bg-surface-2 hover:text-fg',
                    )
                  }
                >
                  <Icon aria-hidden="true" className="size-4" />
                  {t(`nav.${key}`)}
                </NavLink>
              </li>
            ))}
          </ul>
        </nav>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex flex-wrap items-center justify-end gap-x-4 gap-y-2 border-b border-line px-4 py-2">
          <LiveIndicator />
          <HealthBadge />
          <ThemeToggle />
          <LanguageToggle />
          <SessionMenu />
        </header>
        <main id="main" className="min-w-0 flex-1 p-4 md:p-6">
          <Suspense fallback={<LoadingState />}>
            <Outlet />
          </Suspense>
        </main>
      </div>
    </div>
  );
}
