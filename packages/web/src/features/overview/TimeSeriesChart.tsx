import type { Bucket } from '@centinela/shared';
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Tooltip, XAxis, YAxis } from 'recharts';
import { useFormat } from '../../lib/format';

interface TimeSeriesChartProps {
  label: string;
  data: ReadonlyArray<{ t: string; count: number }>;
  bucket: Bucket;
  kind: 'area' | 'bar';
}

const axis = { stroke: 'var(--c-muted)', fontSize: 11, tickLine: false } as const;
const tooltipStyle = {
  background: 'var(--c-surface)',
  border: '1px solid var(--c-line)',
  color: 'var(--c-fg)',
  borderRadius: 6,
  fontSize: 12,
};

/**
 * Counts over time. The chart is decorative for screen readers; the same numbers are in a
 * visually hidden table (ARCHITECTURE §11: charts have text alternatives).
 */
export function TimeSeriesChart({ label, data, bucket, kind }: TimeSeriesChartProps) {
  const format = useFormat();
  const tick = (iso: string) =>
    bucket === '1d' ? (format.shortDateTime(iso).split(',')[0] ?? iso) : format.time(iso);
  const points = data.map((point) => ({ ...point }));
  const common = {
    data: points,
    responsive: true,
    style: { width: '100%', height: '100%' },
    margin: { top: 8, right: 8, bottom: 0, left: -16 },
  };
  const children = [
    <CartesianGrid key="grid" stroke="var(--c-line)" strokeDasharray="3 3" vertical={false} />,
    <XAxis key="x" dataKey="t" tickFormatter={tick} minTickGap={24} {...axis} />,
    <YAxis
      key="y"
      allowDecimals={false}
      width={48}
      tickFormatter={(value: number) => format.number(value)}
      {...axis}
    />,
    <Tooltip
      key="tooltip"
      contentStyle={tooltipStyle}
      labelFormatter={(value) => (typeof value === 'string' ? format.dateTime(value) : '')}
      formatter={(value) => [typeof value === 'number' ? format.number(value) : '', label]}
    />,
  ];
  return (
    <figure className="m-0">
      <div className="h-48" aria-hidden="true">
        {kind === 'area' ? (
          <AreaChart {...common}>
            {children}
            <Area
              type="monotone"
              dataKey="count"
              stroke="var(--c-accent)"
              fill="var(--c-accent)"
              fillOpacity={0.2}
              isAnimationActive={false}
            />
          </AreaChart>
        ) : (
          <BarChart {...common}>
            {children}
            <Bar dataKey="count" fill="var(--c-accent)" isAnimationActive={false} />
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
