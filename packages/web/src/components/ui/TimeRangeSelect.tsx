import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  RANGE_PRESETS,
  fromLocalInput,
  toLocalInput,
  type RangePreset,
  type TimeRange,
} from '../../lib/time-range';
import { Button } from './Button';
import { SelectField, TextField } from './Fields';

interface TimeRangeSelectProps {
  value: TimeRange;
  onChange: (range: TimeRange) => void;
}

/** Preset ranges plus a custom from/to range entered in local time. */
export function TimeRangeSelect({ value, onChange }: TimeRangeSelectProps) {
  const { t } = useTranslation();
  const [custom, setCustom] = useState(value.kind === 'custom');
  const [from, setFrom] = useState(value.kind === 'custom' ? toLocalInput(value.from) : '');
  const [to, setTo] = useState(value.kind === 'custom' && value.to ? toLocalInput(value.to) : '');

  const selected = custom ? 'custom' : value.kind === 'preset' ? value.preset : 'custom';
  const fromIso = fromLocalInput(from);
  const toIso = fromLocalInput(to);
  const invalid = !fromIso || (toIso !== undefined && Date.parse(toIso) < Date.parse(fromIso));

  return (
    <div className="flex flex-wrap items-end gap-2">
      <SelectField
        label={t('timeRange.label')}
        value={selected}
        onChange={(event) => {
          const next = event.target.value;
          if (next === 'custom') {
            setCustom(true);
            return;
          }
          setCustom(false);
          onChange({ kind: 'preset', preset: next as RangePreset });
        }}
        options={[
          ...RANGE_PRESETS.map((preset) => ({
            value: preset,
            label: t(`timeRange.presets.${preset}`),
          })),
          { value: 'custom', label: t('timeRange.custom') },
        ]}
      />
      {custom ? (
        <>
          <TextField
            label={t('timeRange.from')}
            type="datetime-local"
            value={from}
            onChange={(event) => setFrom(event.target.value)}
          />
          <TextField
            label={t('timeRange.to')}
            type="datetime-local"
            value={to}
            onChange={(event) => setTo(event.target.value)}
          />
          <Button
            disabled={invalid}
            onClick={() => {
              if (fromIso) onChange({ kind: 'custom', from: fromIso, to: toIso });
            }}
          >
            {t('timeRange.apply')}
          </Button>
        </>
      ) : null}
    </div>
  );
}
