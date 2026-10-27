import type { Bucket } from '@centinela/shared';
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Tooltip, XAxis, YAxis } from 'recharts';
import { useFormat } from '../../lib/format';
import { yAxisWidth } from './axis';

interface TimeSeriesChartProps {
  label: string;
  data: ReadonlyArray<{ t: string; count: number }>;
  bucket: Bucket;
  kind: 'area' | 'bar';
  /** Series colour: events are neutral grey, alerts amber (docs/decisions/S7b.md, S7b-16). */
  series: 'events' | 'alerts';
}

const axis = {
  stroke: 'var(--c-line)',
  tick: { fill: 'var(--c-muted)', fontSize: 12 },
  tickLine: false,
} as const;
const tooltipStyle = {
  background: 'var(--c-raised)',
  border: '1px solid var(--c-line-strong)',
  color: 'var(--c-fg)',
  borderRadius: 6,
  fontSize: 13,
};

/**
 * Counts over time. The chart is decorative for screen readers; the same numbers are in a
 * visually hidden table (ARCHITECTURE §11: charts have text alternatives).
 */
export function TimeSeriesChart({ label, data, bucket, kind, series }: TimeSeriesChartProps) {
  const format = useFormat();
  const tick = (iso: string) =>
    bucket === '1d' ? (format.shortDateTime(iso).split(',')[0] ?? iso) : format.time(iso);
  const points = data.map((point) => ({ ...point }));
  const max = Math.max(0, ...data.map((point) => point.count));
  const color = series === 'events' ? 'var(--c-chart-events)' : 'var(--c-chart-alerts)';
  const common = {
    data: points,
    responsive: true,
    style: { width: '100%', height: '100%' },
    margin: { top: 8, right: 4, bottom: 0, left: 0 },
  };
  const children = [
    <CartesianGrid key="grid" stroke="var(--c-line)" vertical={false} />,
    <XAxis key="x" dataKey="t" tickFormatter={tick} minTickGap={28} {...axis} />,
    <YAxis
      key="y"
      allowDecimals={false}
      width={yAxisWidth([format.number(max), format.number(Math.ceil(max * 1.1))])}
      tickFormatter={(value: number) => format.number(value)}
      axisLine={false}
      {...axis}
    />,
    <Tooltip
      key="tooltip"
      contentStyle={tooltipStyle}
      labelStyle={{ color: 'var(--c-muted)' }}
      itemStyle={{ color: 'var(--c-fg)' }}
      cursor={kind === 'bar' ? { fill: 'var(--c-hover)' } : { stroke: 'var(--c-line-strong)' }}
      labelFormatter={(value) => (typeof value === 'string' ? format.dateTime(value) : '')}
      formatter={(value) => [typeof value === 'number' ? format.number(value) : '', label]}
    />,
  ];
  return (
    <figure className="m-0">
      <div className="h-44" aria-hidden="true">
        {kind === 'area' ? (
          <AreaChart {...common}>
            {children}
            <Area
              type="monotone"
              dataKey="count"
              stroke={color}
              strokeWidth={2}
              fill={color}
              fillOpacity={0.12}
              isAnimationActive={false}
            />
          </AreaChart>
        ) : (
          <BarChart {...common}>
            {children}
            <Bar dataKey="count" fill={color} radius={[2, 2, 0, 0]} isAnimationActive={false} />
          </BarChart>
        )}
      </div>
      <table className="sr-only">
        <caption>{label}</caption>
        <tbody>
          {data.map((point) => (
            <tr key={point.t}>
              <th scope="row">{format.dateTime(point.t)}</th>
              <td>{format.number(point.count)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}
