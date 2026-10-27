import { MAX_NOTE_LENGTH, RESOLUTIONS, type Alert, type Resolution } from '@centinela/shared';
import { CheckCheck, RotateCcw } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useUpdateAlert } from '../../api/hooks';
import { Button } from '../../components/ui/Button';
import { SelectField, TextArea } from '../../components/ui/Fields';
import { useToasts } from '../../components/ui/toast-context';

/**
 * Lifecycle actions (ARCHITECTURE §7): acknowledge, close with a resolution, reopen. A
 * sentence first says where the alert stands and what the next step is.
 */
export function TriagePanel({ alert }: { alert: Alert }) {
  const { t } = useTranslation();
  const { push } = useToasts();
  const update = useUpdateAlert(alert.id);
  const [resolution, setResolution] = useState<Resolution | ''>('');
  const [note, setNote] = useState(alert.note ?? '');
  const [pending, setPending] = useState<'acknowledge' | 'close' | 'reopen' | null>(null);

  const notify = {
    onSuccess: () => push({ title: t('triage.updated') }),
    onError: () => push({ title: t('triage.failed') }),
    onSettled: () => setPending(null),
  };
  const noteValue = note.trim() === '' ? null : note;

  const guidance =
    alert.status === 'new'
      ? t('triage.guidance.new')
      : alert.status === 'acknowledged'
        ? t('triage.guidance.acknowledged')
        : t('triage.guidance.closed', {
            resolution: alert.resolution ? t(`resolutions.${alert.resolution}`) : '',
          });

  return (
    <section aria-labelledby="triage-title" className="flex flex-col gap-4">
      <div>
        <h3 id="triage-title" className="text-lead font-semibold text-fg">
          {t('triage.title')}
        </h3>
        <p className="mt-0.5 text-muted">{guidance}</p>
      </div>
      <TextArea
        id="triage-note"
        label={t('triage.note')}
        hint={t('triage.noteHint')}
        rows={2}
        maxLength={MAX_NOTE_LENGTH}
        value={note}
        onChange={(event) => setNote(event.target.value)}
      />
      {alert.status === 'closed' ? (
        <Button
          className="w-fit"
          icon={RotateCcw}
          loading={pending === 'reopen'}
          disabled={update.isPending}
          onClick={() => {
            setPending('reopen');
            update.mutate({ status: 'new', note: noteValue }, notify);
          }}
        >
          {t('triage.reopen')}
        </Button>
      ) : (
        <div className="flex flex-col gap-4">
          {alert.status === 'new' ? (
            <Button
              variant="primary"
              className="w-fit"
              icon={CheckCheck}
              loading={pending === 'acknowledge'}
              disabled={update.isPending}
              onClick={() => {
                setPending('acknowledge');
                update.mutate({ status: 'acknowledged', note: noteValue }, notify);
              }}
            >
              {t('triage.acknowledge')}
            </Button>
          ) : null}
          <div className="flex flex-wrap items-end gap-2">
            <SelectField
              label={t('triage.resolution')}
              className="min-w-[12rem] flex-1"
              value={resolution}
              onChange={(event) => setResolution(event.target.value as Resolution | '')}
              options={[
                { value: '', label: t('triage.chooseResolution') },
                ...RESOLUTIONS.map((value) => ({ value, label: t(`resolutions.${value}`) })),
              ]}
            />
            <Button
              loading={pending === 'close'}
              disabled={resolution === '' || update.isPending}
              onClick={() => {
                if (resolution !== '') {
                  setPending('close');
                  update.mutate({ status: 'closed', resolution, note: noteValue }, notify);
                }
              }}
            >
              {t('triage.close')}
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}
