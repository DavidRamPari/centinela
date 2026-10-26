import { clsx } from 'clsx';
import {
  Activity,
  Bell,
  FileUp,
  Grid3x3,
  LayoutDashboard,
  ScrollText,
  ShieldHalf,
} from 'lucide-react';
import type { ComponentType, SVGProps } from 'react';
import { useTranslation } from 'react-i18next';
import { NavLink, Outlet } from 'react-router';
import { HealthBadge } from '../components/ui/HealthBadge';
import { LanguageToggle } from '../components/ui/LanguageToggle';

type NavKey = 'overview' | 'alerts' | 'events' | 'attack' | 'rules' | 'ingest';

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
];

/** Sidebar layout: navigation on the left (top bar on small screens), page content on the right. */
export function Layout() {
  const { t } = useTranslation();
  return (
    <div className="flex min-h-screen flex-col md:flex-row">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-10 focus:rounded focus:bg-slate-800 focus:px-3 focus:py-2"
      >
        {t('app.skipToContent')}
      </a>
      <aside className="border-b border-slate-800 bg-slate-900 md:w-56 md:shrink-0 md:border-b-0 md:border-r">
        <div className="flex items-center gap-2 px-4 py-4">
          <ShieldHalf aria-hidden="true" className="size-6 text-accent-400" />
          <div>
            <p className="font-semibold text-white">{t('app.name')}</p>
            <p className="text-xs text-slate-400">{t('app.tagline')}</p>
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
                        ? 'bg-slate-800 text-white'
                        : 'text-slate-300 hover:bg-slate-800/60 hover:text-white',
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
        <header className="flex items-center justify-end gap-4 border-b border-slate-800 px-4 py-2">
          <HealthBadge />
          <LanguageToggle />
        </header>
        <main id="main" className="flex-1 p-4 md:p-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
