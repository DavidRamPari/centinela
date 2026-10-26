/**
 * Toast notifications in a polite live region. Used for live alerts (SSE) and actions.
 */
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
            role="status"
            className="pointer-events-auto rounded-lg border border-line bg-surface p-3 shadow-lg"
          >
            <div className="flex items-start gap-2">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  {toast.level ? <SeverityBadge level={toast.level} /> : null}
                  <p className="font-medium text-fg">{toast.title}</p>
                </div>
                {toast.description ? (
                  <p className="mt-1 break-words text-muted">{toast.description}</p>
                ) : null}
                {toast.href ? (
                  <Link to={toast.href} className="mt-1 inline-block text-accent hover:underline">
                    {toast.linkLabel ?? t('toasts.open')}
                  </Link>
                ) : null}
              </div>
              <button
                type="button"
                onClick={() => dismiss(toast.id)}
                className="rounded p-1 text-muted hover:text-fg"
                aria-label={t('toasts.dismiss')}
              >
                <X aria-hidden="true" className="size-4" />
              </button>
            </div>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
