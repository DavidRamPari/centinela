import { MAX_NOTE_LENGTH, RESOLUTIONS, type Alert, type Resolution } from '@centinela/shared';
import { CheckCheck, CircleAlert, LoaderCircle, RotateCcw } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useUpdateAlert } from '../../api/hooks';
import { Button } from '../../components/ui/Button';
import { SelectField, TextArea } from '../../components/ui/Fields';
import { useToasts } from '../../components/ui/toast-context';
import { describeError } from '../../lib/error-text';
import { useSingleFlight } from '../../lib/single-flight';

/**
 * Lifecycle actions (ARCHITECTURE §7): acknowledge, close with a resolution, reopen. A
 * sentence first says where the alert stands and what the next step is.
 *
 * A change shows at once (S7b-17): the page switches to the new status while the request
 * runs, the actions wait, and if the server refuses, the alert goes back to its previous
 * status and the panel says why, keeping the note that was typed.
 */
export function TriagePanel({ alert }: { alert: Alert }) {
  const { t } = useTranslation();
  const { push } = useToasts();
  const update = useUpdateAlert(alert.id);
  const flight = useSingleFlight();
  const [resolution, setResolution] = useState<Resolution | ''>('');
  const [note, setNote] = useState(alert.note ?? '');
  // A note saved by the server (this panel or someone else) replaces the draft.
  const [savedNote, setSavedNote] = useState(alert.note);
  const [failure, setFailure] = useState<string | null>(null);
  if (savedNote !== alert.note) {
    setSavedNote(alert.note);
    setNote(alert.note ?? '');
  }
  const noteValue = note.trim() === '' ? null : note;

  function change(
    body: { status: 'new' | 'acknowledged' } | { status: 'closed'; resolution: Resolution },
  ) {
    const previous = alert.status;
    setFailure(null);
    flight.run(() =>
      update.mutateAsync(
        { ...body, note: noteValue },
        {
          onSuccess: () => {
            if (body.status === 'closed') setResolution('');
            push({ title: t('triage.updated') });
          },
          onError: (error) =>
            setFailure(
              t('triage.rolledBack', {
                status: t(`statuses.${previous}`),
                action: describeError(t, error).action,
              }),
            ),
        },
      ),
    );
  }

  const guidance =
    alert.status === 'new'
      ? t('triage.guidance.new')
      : alert.status === 'acknowledged'
        ? t('triage.guidance.acknowledged')
        : t('triage.guidance.closed', {
            resolution: alert.resolution ? t(`resolutions.${alert.resolution}`) : '',
          });

  return (
    <section aria-labelledby="triage-title" aria-busy={flight.busy || undefined}>
      <div className="flex flex-col gap-4">
        <div>
          <h3 id="triage-title" className="text-lead font-semibold text-fg">
            {t('triage.title')}
          </h3>
          <p className="mt-0.5 text-muted">{guidance}</p>
        </div>
        {failure ? (
          <div role="alert" className="flex items-start gap-2 border-l-2 border-danger py-1 pl-3">
            <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-danger" />
            <div className="flex min-w-0 flex-col gap-0.5">
              <p className="font-semibold text-fg">{t('triage.failed')}</p>
              <p className="text-muted">{failure}</p>
            </div>
          </div>
        ) : null}
        <TextArea
          id="triage-note"
          label={t('triage.note')}
          hint={t('triage.noteHint')}
          rows={2}
          maxLength={MAX_NOTE_LENGTH}
          value={note}
          readOnly={flight.busy}
          onChange={(event) => setNote(event.target.value)}
        />
        {alert.status === 'closed' ? (
          <Button
            className="w-fit"
            icon={RotateCcw}
            disabled={flight.busy}
            onClick={() => change({ status: 'new' })}
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
                disabled={flight.busy}
                onClick={() => change({ status: 'acknowledged' })}
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
                disabled={resolution === '' || flight.busy}
                onClick={() => {
                  if (resolution !== '') change({ status: 'closed', resolution });
                }}
              >
                {t('triage.close')}
              </Button>
            </div>
          </div>
        )}
        {/* The new status is already on the page; this line says it is still being saved. */}
        <p role="status" className="flex min-h-[1lh] items-center gap-2 text-small text-muted">
          {flight.busy ? (
            <>
              <LoaderCircle aria-hidden="true" className="size-3.5 animate-spin" />
              {t('triage.saving')}
            </>
          ) : null}
        </p>
      </div>
    </section>
  );
}
