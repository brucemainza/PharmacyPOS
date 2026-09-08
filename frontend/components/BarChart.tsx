import { useState } from 'react';

type BarChartDatum = { label: string; value: number };

type Props = {
  data: BarChartDatum[];
  formatValue?: (value: number) => string;
  height?: number;
};

// A small, dependency-free SVG bar chart — this app has no charting library, and one bar
// chart doesn't justify adding one. Values are compared to the largest bar in the set, so
// the tallest bar always fills the chart regardless of the actual sales figures involved.
export default function BarChart({ data, formatValue, height = 220 }: Props) {
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const max = Math.max(1, ...data.map((d) => d.value));
  const barWidth = 100 / data.length;
  const format = formatValue || ((v: number) => v.toFixed(2));

  return (
    <div className="bar-chart" style={{ height }}>
      <div className="bar-chart-bars">
        {data.map((d, i) => {
          const pct = (d.value / max) * 100;
          return (
            <div
              key={d.label}
              className="bar-chart-col"
              style={{ width: `${barWidth}%` }}
              onMouseEnter={() => setHoverIndex(i)}
              onMouseLeave={() => setHoverIndex((h) => (h === i ? null : h))}
            >
              {hoverIndex === i && (
                <div className="bar-chart-tooltip">
                  <strong>{d.label}</strong>
                  <span>{format(d.value)}</span>
                </div>
              )}
              <div
                className={`bar-chart-bar ${d.value <= 0 ? 'bar-chart-bar-empty' : ''}`}
                style={{ height: `${d.value > 0 ? Math.max(pct, 2) : 0}%` }}
              />
              <span className="bar-chart-label">{d.label}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
