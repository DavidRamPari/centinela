import { OUTCOMES, SOURCE_TYPES } from '@centinela/shared';
import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../components/ui/Button';
import { SelectField, TextField } from '../../components/ui/Fields';
import { TimeRangeSelect } from '../../components/ui/TimeRangeSelect';
import { useParamUpdater } from '../../lib/search-params';
import { writeTimeRange } from '../../lib/time-range';
import { EVENT_TEXT_FILTERS, type EventFilters, type EventTextFilter } from './event-filters';

/** Event search form. Selects apply at once; text fields apply on submit (Enter). */
export function EventFilterBar({ filters }: { filters: EventFilters }) {
  const { t } = useTranslation();
  const update = useParamUpdater();
  const [text, setText] = useState(filters.text);

  function submit(event: FormEvent) {
    event.preventDefault();
    const updates: Partial<Record<EventTextFilter, string>> = {};
    for (const key of EVENT_TEXT_FILTERS) updates[key] = text[key]?.trim() ?? '';
    update(updates);
  }

  return (
    <div className="mb-6 flex flex-col gap-4 border-b border-line pb-6">
      <div className="flex flex-wrap items-end gap-x-4 gap-y-4">
        <TimeRangeSelect
          value={filters.range}
          onChange={(range) => update((params) => writeTimeRange(params, range))}
        />
        <SelectField
          label={t('events.filters.source')}
          value={filters.source ?? ''}
          onChange={(event) => update({ source: event.target.value })}
          options={[
            { value: '', label: t('common.all') },
            ...SOURCE_TYPES.map((value) => ({ value, label: t(`sources.${value}`) })),
          ]}
        />
        <SelectField
          label={t('events.filters.outcome')}
          value={filters.outcome ?? ''}
          onChange={(event) => update({ outcome: event.target.value })}
          options={[
            { value: '', label: t('common.all') },
            ...OUTCOMES.map((value) => ({ value, label: t(`outcomes.${value}`) })),
          ]}
        />
      </div>
      <form
        role="search"
        aria-label={t('events.filters.form')}
        onSubmit={submit}
        className="grid grid-cols-2 items-end gap-3 lg:grid-cols-[repeat(5,minmax(0,1fr))_auto]"
      >
        {EVENT_TEXT_FILTERS.map((key) => (
          <TextField
            key={key}
            label={t(`events.filters.${key}`)}
            className={key === 'q' ? 'col-span-2 lg:col-span-1' : undefined}
            value={text[key] ?? ''}
            onChange={(event) => setText({ ...text, [key]: event.target.value })}
            spellCheck={false}
            autoComplete="off"
            maxLength={256}
          />
        ))}
        <div className="col-span-2 flex gap-2 sm:col-span-1">
          <Button type="submit" variant="primary">
            {t('common.search')}
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
