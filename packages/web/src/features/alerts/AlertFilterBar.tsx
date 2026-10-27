import { ALERT_STATUSES, LEVELS } from '@centinela/shared';
import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../components/ui/Button';
import { TextField, ToggleChips } from '../../components/ui/Fields';
import { TimeRangeSelect } from '../../components/ui/TimeRangeSelect';
import { useParamUpdater } from '../../lib/search-params';
import { writeTimeRange } from '../../lib/time-range';
import { ALERT_TEXT_FILTERS, type AlertFilters, type AlertTextFilter } from './alert-filters';

/** Filters for the alerts list. Chips apply at once; text filters apply on submit. */
export function AlertFilterBar({ filters }: { filters: AlertFilters }) {
  const { t } = useTranslation();
  const update = useParamUpdater();
  const [text, setText] = useState(filters.text);

  function submit(event: FormEvent) {
    event.preventDefault();
    const updates: Partial<Record<AlertTextFilter, string>> = {};
    for (const key of ALERT_TEXT_FILTERS) updates[key] = text[key]?.trim() ?? '';
    update(updates);
  }

  return (
    <div className="mb-6 flex flex-col gap-4 border-b border-line pb-6">
      <div className="flex flex-wrap items-end gap-x-6 gap-y-4">
        <ToggleChips
          label={t('alerts.filters.status')}
          options={ALERT_STATUSES.map((value) => ({ value, label: t(`statuses.${value}`) }))}
          selected={filters.status}
          onChange={(status) => update({ status })}
        />
        <ToggleChips
          label={t('alerts.filters.level')}
          options={[...LEVELS].reverse().map((value) => ({ value, label: t(`levels.${value}`) }))}
          selected={filters.level}
          onChange={(level) => update({ level })}
        />
        <TimeRangeSelect
          value={filters.range}
          onChange={(range) => update((params) => writeTimeRange(params, range))}
        />
      </div>
      <form
        onSubmit={submit}
        aria-label={t('alerts.filters.form')}
        className="grid grid-cols-2 items-end gap-3 sm:grid-cols-3 lg:grid-cols-[repeat(5,minmax(0,1fr))_auto]"
      >
        {ALERT_TEXT_FILTERS.map((key) => (
          <TextField
            key={key}
            label={t(`alerts.filters.${key}`)}
            value={text[key] ?? ''}
            onChange={(event) => setText({ ...text, [key]: event.target.value })}
            spellCheck={false}
            autoComplete="off"
          />
        ))}
        <div className="col-span-2 flex gap-2 sm:col-span-1">
          <Button type="submit" variant="primary">
            {t('common.apply')}
          </Button>
          <Button
            variant="quiet"
            onClick={() => {
              setText({});
              update(() => new URLSearchParams());
            }}
          >
            {t('common.reset')}
          </Button>
        </div>
      </form>
    </div>
  );
}
