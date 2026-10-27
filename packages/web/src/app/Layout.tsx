import { clsx } from 'clsx';
import {
  Activity,
  Bell,
  FileUp,
  Grid3x3,
  KeyRound,
  LayoutDashboard,
  Menu,
  ScrollText,
  X,
  type LucideIcon,
} from 'lucide-react';
import { Suspense, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, NavLink, Outlet, useLocation } from 'react-router';
import { Lockup } from '../components/brand/Wordmark';
import { HealthBadge } from '../components/ui/HealthBadge';
import { LanguageToggle } from '../components/ui/LanguageToggle';
import { LoadingState } from '../components/ui/States';
import { ThemeToggle } from '../components/ui/ThemeToggle';
import { ToastProvider } from '../components/ui/Toasts';
import { SessionMenu } from '../features/auth/SessionMenu';
import { LiveIndicator } from '../features/live/LiveIndicator';
import { LiveUpdates } from '../features/live/LiveUpdates';

type NavKey = 'overview' | 'alerts' | 'events' | 'attack' | 'rules' | 'ingest' | 'security';

const NAV_ITEMS: ReadonlyArray<{ to: string; key: NavKey; icon: LucideIcon }> = [
  { to: '/', key: 'overview', icon: LayoutDashboard },
  { to: '/alerts', key: 'alerts', icon: Bell },
  { to: '/events', key: 'events', icon: Activity },
  { to: '/attack', key: 'attack', icon: Grid3x3 },
  { to: '/rules', key: 'rules', icon: ScrollText },
  { to: '/ingest', key: 'ingest', icon: FileUp },
  { to: '/security', key: 'security', icon: KeyRound },
];

/**
 * Two zones (docs/decisions/S7b.md): a rail with the brand, the navigation and, grouped at
 * its foot, the system status, display preferences and account; and the workspace. The
 * rail is set off by a grey line. Under 1024 px the rail becomes a sheet opened from a top bar.
 * Toasts and live updates live here, inside the router, so toasts can link to pages.
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
  const location = useLocation();
  const [open, setOpen] = useState(false);
  const [openedAt, setOpenedAt] = useState(location.key);
  const menuButton = useRef<HTMLButtonElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const railId = useId();

  // Following a link closes the phone sheet (adjusting state during render).
  if (open && openedAt !== location.key) setOpen(false);

  useEffect(() => {
    if (open) closeButton.current?.focus();
  }, [open]);

  function close() {
    setOpen(false);
    menuButton.current?.focus();
  }

  return (
    <div className="min-h-screen lg:grid lg:grid-cols-[16rem_minmax(0,1fr)]">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-50 focus:rounded-control focus:bg-accent focus:px-3 focus:py-2 focus:font-semibold focus:text-accent-fg"
      >
        {t('app.skipToContent')}
      </a>

      <header className="flex h-14 border-b border-line items-center gap-3 px-3 lg:hidden">
        <button
          ref={menuButton}
          type="button"
          aria-expanded={open}
          aria-controls={railId}
          onClick={() => {
            setOpenedAt(location.key);
            setOpen(true);
          }}
          className="grid size-10 place-items-center rounded-control text-fg hover:bg-hover active:translate-y-px"
        >
          <Menu aria-hidden="true" strokeWidth={1.75} className="size-5" />
          <span className="sr-only">{t('app.openMenu')}</span>
        </button>
        <Link to="/" className="rounded-control">
          <Lockup />
        </Link>
      </header>

      {open ? (
        <div
          className="fixed inset-0 z-30 bg-black/70 lg:hidden"
          aria-hidden="true"
          onClick={close}
        />
      ) : null}
      {/* The wrapper runs the full page height, so the rail's edge line does too. */}
      <div className="contents lg:block lg:border-r lg:border-line">
        <aside
          id={railId}
          onKeyDown={(event) => {
            if (open && event.key === 'Escape') close();
          }}
          className={clsx(
            'flex-col bg-bg',
            open
              ? 'fixed inset-y-0 left-0 z-40 border-r border-line flex w-[min(18rem,85vw)] animate-sheet-in overflow-y-auto'
              : 'hidden',
            'lg:sticky lg:top-0 lg:flex lg:h-screen lg:w-auto lg:animate-none lg:overflow-y-auto lg:border-r-0',
          )}
        >
          <div className="flex items-center justify-between gap-2 px-5 pt-5 pb-6">
            <Link to="/" className="rounded-control">
              <Lockup />
            </Link>
            {open ? (
              <button
                ref={closeButton}
                type="button"
                onClick={close}
                className="grid size-10 place-items-center rounded-control text-fg hover:bg-hover lg:hidden"
                aria-label={t('app.closeMenu')}
              >
                <X aria-hidden="true" strokeWidth={1.75} className="size-5" />
              </button>
            ) : null}
          </div>
          <nav aria-label={t('app.mainNavigation')} className="px-3">
            <ul className="flex flex-col gap-0.5">
              {NAV_ITEMS.map(({ to, key, icon: Icon }) => (
                <li key={key}>
                  <NavLink
                    to={to}
                    end={to === '/'}
                    className={({ isActive }) =>
                      clsx(
                        'relative flex h-10 items-center gap-3 rounded-control px-3 transition-colors duration-100',
                        isActive
                          ? 'bg-hover font-semibold text-fg before:absolute before:inset-y-2 before:left-0 before:w-[3px] before:rounded-full before:bg-accent'
                          : 'text-muted hover:bg-hover hover:text-fg',
                      )
                    }
                  >
                    {({ isActive }) => (
                      <>
                        <Icon
                          aria-hidden="true"
                          strokeWidth={1.75}
                          className={clsx('size-[18px] shrink-0', isActive && 'text-accent-text')}
                        />
                        {t(`nav.${key}`)}
                      </>
                    )}
                  </NavLink>
                </li>
              ))}
            </ul>
          </nav>

          <div className="mt-auto flex flex-col gap-5 border-t border-line px-5 pt-5 pb-6">
            <RailGroup title={t('app.groups.system')}>
              <LiveIndicator />
              <HealthBadge />
            </RailGroup>
            <RailGroup title={t('app.groups.display')}>
              <LanguageToggle showLabel={false} />
              <ThemeToggle showLabel={false} />
            </RailGroup>
            <RailGroup title={t('app.groups.account')}>
              <SessionMenu />
            </RailGroup>
          </div>
        </aside>
      </div>

      <main id="main" className="min-w-0 px-4 pt-6 pb-16 sm:px-6 lg:px-8 lg:pt-8 xl:px-10">
        <div className="mx-auto max-w-[1480px]">
          <Suspense fallback={<LoadingState />}>
            <Outlet />
          </Suspense>
        </div>
      </main>
    </div>
  );
}

function RailGroup({ title, children }: { title: string; children: ReactNode }) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="flex flex-col gap-2">
      <h2 id={id} className="text-small text-muted">
        {title}
      </h2>
      {children}
    </section>
  );
}
