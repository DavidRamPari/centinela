/**
 * Subscribes to the live source while the app is mounted: new alerts raise a toast, every
 * change refreshes the alert views, and after a reconnect the lists are refetched because
 * changes may have been missed while disconnected.
 */
import { alertSchema } from '@centinela/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { ALERT_DEPENDENT_KEYS } from '../../api/hooks';
import { useToasts } from '../../components/ui/toast-context';
import { LiveSourceContext, LiveStatusContext, type LiveStatus } from './live-context';
import { backoffDelay } from './live-source';

export function LiveUpdates({ children }: { children: ReactNode }) {
  const source = useContext(LiveSourceContext);
  const queryClient = useQueryClient();
  const { push } = useToasts();
  const { t } = useTranslation();
  const [status, setStatus] = useState<LiveStatus>('connecting');
  // Latest callbacks without reconnecting when they change identity.
  const latest = useRef({ push, t });
  useEffect(() => {
    latest.current = { push, t };
  });

  useEffect(() => {
    let connection: { close: () => void } | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let failures = 0;
    let everOpened = false;
    let stopped = false;

    const refresh = () => {
      for (const queryKey of ALERT_DEPENDENT_KEYS) {
        void queryClient.invalidateQueries({ queryKey });
      }
    };

    const connect = () => {
      connection = source({
        onOpen: () => {
          if (everOpened && failures > 0) refresh();
          everOpened = true;
          failures = 0;
          setStatus('live');
        },
        onMessage: (type, data) => {
          let parsed: unknown;
          try {
            parsed = JSON.parse(data);
          } catch {
            return;
          }
          const alert = alertSchema.safeParse(parsed);
          if (!alert.success) return;
          refresh();
          if (type === 'alert.created') {
            latest.current.push({
              title: latest.current.t('live.newAlert'),
              description: alert.data.ruleTitle,
              level: alert.data.level,
              href: `/alerts/${alert.data.id}`,
              linkLabel: latest.current.t('live.openAlert'),
            });
          }
        },
        onError: () => {
          connection?.close();
          if (stopped) return;
          failures += 1;
          setStatus('reconnecting');
          timer = setTimeout(connect, backoffDelay(failures));
        },
      });
    };

    connect();
    return () => {
      stopped = true;
      clearTimeout(timer);
      connection?.close();
    };
  }, [source, queryClient]);

  return <LiveStatusContext.Provider value={status}>{children}</LiveStatusContext.Provider>;
}
