/**
 * Toast notifications in a polite live region. Used for live alerts (SSE) and actions; a
 * failed action's toast is an alert, announced at once.
 */
import { clsx } from 'clsx';
import { X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { SeverityBadge } from './Badges';
import { TOAST_TIMEOUT_MS, ToastContext, type Toast } from './toast-context';

const MAX_TOASTS = 4;

export function ToastProvider({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  const dismiss = useCallback((id: number) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
    clearTimeout(timers.current.get(id));
    timers.current.delete(id);
  }, []);

  const push = useCallback(
    (toast: Omit<Toast, 'id'>) => {
      const id = nextId.current++;
      setToasts((current) => [...current, { ...toast, id }].slice(-MAX_TOASTS));
      timers.current.set(
        id,
        setTimeout(() => dismiss(id), TOAST_TIMEOUT_MS),
      );
    },
    [dismiss],
  );

  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const timer of pending.values()) clearTimeout(timer);
    };
  }, []);

  const api = useMemo(() => ({ push }), [push]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div
        role="region"
        aria-label={t('toasts.region')}
        className="pointer-events-none fixed bottom-4 right-4 z-50 flex w-[min(24rem,calc(100vw-2rem))] flex-col gap-2"
      >
        {toasts.map((toast) => (
          <div
            key={toast.id}
            role={toast.tone === 'error' ? 'alert' : 'status'}
            className={clsx(
              'pointer-events-auto animate-toast-in rounded-panel border border-line-strong bg-raised py-3 pl-4 pr-2',
              toast.tone === 'error' && 'border-l-4 border-l-danger',
            )}
          >
            <div className="flex items-start gap-2">
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <p className="font-semibold text-fg">{toast.title}</p>
                  {toast.level ? <SeverityBadge level={toast.level} /> : null}
                </div>
                {toast.description ? (
                  <p className="break-words text-muted">{toast.description}</p>
                ) : null}
                {toast.href ? (
                  <Link
                    to={toast.href}
                    className="w-fit font-semibold text-link underline decoration-line-strong underline-offset-3 hover:decoration-link"
                  >
                    {toast.linkLabel ?? t('toasts.open')}
                  </Link>
                ) : null}
              </div>
              <button
                type="button"
                onClick={() => dismiss(toast.id)}
                className="grid size-8 shrink-0 place-items-center rounded-control text-muted transition-colors duration-100 hover:bg-hover hover:text-fg active:translate-y-px active:bg-pressed"
                aria-label={t('toasts.dismiss')}
              >
                <X aria-hidden="true" strokeWidth={1.75} className="size-4" />
              </button>
            </div>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
