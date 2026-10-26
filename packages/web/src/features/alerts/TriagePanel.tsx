import { MAX_NOTE_LENGTH, RESOLUTIONS, type Alert, type Resolution } from '@centinela/shared';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useUpdateAlert } from '../../api/hooks';
import { StatusBadge } from '../../components/ui/Badges';
import { Button } from '../../components/ui/Button';
import { Card } from '../../components/ui/Card';
import { SelectField, controlClass } from '../../components/ui/Fields';
import { useToasts } from '../../components/ui/toast-context';

/** Lifecycle actions (ARCHITECTURE §7): acknowledge, close with a resolution, reopen. */
export function TriagePanel({ alert }: { alert: Alert }) {
  const { t } = useTranslation();
  const { push } = useToasts();
  const update = useUpdateAlert(alert.id);
  const [resolution, setResolution] = useState<Resolution | ''>('');
  const [note, setNote] = useState(alert.note ?? '');

  const notify = {
    onSuccess: () => push({ title: t('triage.updated') }),
    onError: () => push({ title: t('triage.failed') }),
  };
  const noteValue = note.trim() === '' ? null : note;

  return (
    <Card title={t('triage.title')}>
      <div className="flex flex-col gap-3">
        <p className="flex flex-wrap items-center gap-2">
          <span className="text-muted">{t('triage.current')}</span>
          <StatusBadge status={alert.status} />
          {alert.resolution ? (
            <span className="text-fg">{t(`resolutions.${alert.resolution}`)}</span>
          ) : null}
        </p>
        <div className="flex flex-col gap-1">
          <label htmlFor="triage-note" className="text-xs font-medium text-muted">
            {t('triage.note')}
          </label>
          <textarea
            id="triage-note"
            className={controlClass}
            rows={3}
            maxLength={MAX_NOTE_LENGTH}
            value={note}
            onChange={(event) => setNote(event.target.value)}
          />
        </div>
        {alert.status === 'closed' ? (
          <Button
            disabled={update.isPending}
            onClick={() => update.mutate({ status: 'new', note: noteValue }, notify)}
          >
            {t('triage.reopen')}
          </Button>
        ) : (
          <>
            {alert.status === 'new' ? (
              <Button
                variant="primary"
                disabled={update.isPending}
                onClick={() => update.mutate({ status: 'acknowledged', note: noteValue }, notify)}
              >
                {t('triage.acknowledge')}
              </Button>
            ) : null}
            <div className="flex flex-wrap items-end gap-2 border-t border-line pt-3">
              <SelectField
                label={t('triage.resolution')}
                value={resolution}
                onChange={(event) => setResolution(event.target.value as Resolution | '')}
                options={[
                  { value: '', label: t('triage.chooseResolution') },
                  ...RESOLUTIONS.map((value) => ({ value, label: t(`resolutions.${value}`) })),
                ]}
              />
              <Button
                disabled={resolution === '' || update.isPending}
                onClick={() => {
                  if (resolution !== '') {
                    update.mutate({ status: 'closed', resolution, note: noteValue }, notify);
                  }
                }}
              >
                {t('triage.close')}
              </Button>
            </div>
          </>
        )}
      </div>
    </Card>
  );
}
