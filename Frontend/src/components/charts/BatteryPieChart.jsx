import React, { useMemo, useState } from 'react';

import { Pie, PieChart, Cell, ResponsiveContainer, Sector, Tooltip } from 'recharts';

import { PIE_COLORS } from '@/components/system/pieColors';

const DEFAULT_INNER_RADIUS = 60;
const DEFAULT_OUTER_RADIUS = 85;

function percent(value, total) {
  if (!total) return 0;
  return Math.round((value / total) * 100);
}

function renderActiveShape(props) {
  const { cx, cy, innerRadius, outerRadius, startAngle, endAngle, fill } = props;
  return (
    <g>
      <Sector
        cx={cx}
        cy={cy}
        innerRadius={innerRadius}
        outerRadius={outerRadius}
        startAngle={startAngle}
        endAngle={endAngle}
        fill={fill}
      />
    </g>
  );
}

function ChartTooltip({ active, payload, total }) {
  if (!active || !payload?.length) return null;
  const p = payload[0];
  const label = p?.name ?? p?.payload?.label;
  const value = typeof p?.value === 'number' ? p.value : Number(p?.value ?? 0);

  return (
    <div className="rounded-lg border border-border bg-card px-3 py-2 shadow-sm">
      <div className="text-sm font-medium text-foreground">{label}</div>
      <div className="text-xs text-muted-foreground">
        {value} ({percent(value, total)}%)
      </div>
    </div>
  );
}

export default function BatteryPieChart({ data, width, height }) {
  const safeData = useMemo(() => {
    if (Array.isArray(data) && data.length > 0) return data;
    return [
      { label: 'Healthy', value: 0, color: PIE_COLORS[0] },
      { label: 'Moderate', value: 0, color: PIE_COLORS[1] },
      { label: 'Low', value: 0, color: PIE_COLORS[2] },
    ];
  }, [data]);

  const [activeIndex, setActiveIndex] = useState(0);
  const total = useMemo(
    () => safeData.reduce((acc, d) => acc + (Number(d.value) || 0), 0),
    [safeData]
  );

  const resolvedWidth = Number(width);
  const resolvedHeight = Number(height);
  const size =
    Number.isFinite(resolvedWidth) && resolvedWidth > 0 && Number.isFinite(resolvedHeight) && resolvedHeight > 0
      ? Math.min(resolvedWidth, resolvedHeight)
      : null;

  const innerRadius = size ? Math.floor(size * 0.34) : DEFAULT_INNER_RADIUS;
  const outerRadius = size ? Math.floor(size * 0.48) : DEFAULT_OUTER_RADIUS;

  const pie = (
    <>
      <Pie
        data={safeData}
        dataKey="value"
        nameKey="label"
        cx="50%"
        cy="50%"
        innerRadius={innerRadius}
        outerRadius={outerRadius}
        stroke="none"
        activeIndex={activeIndex}
        activeShape={renderActiveShape}
        onMouseEnter={(_, idx) => setActiveIndex(idx)}
        onMouseLeave={() => setActiveIndex(0)}
      >
        {safeData.map((entry) => (
          <Cell key={entry.label} fill={entry.color} />
        ))}
      </Pie>
      <Tooltip content={<ChartTooltip total={total} />} />
    </>
  );

  if (resolvedWidth > 0 && resolvedHeight > 0) {
    return (
      <PieChart width={resolvedWidth} height={resolvedHeight}>
        {pie}
      </PieChart>
    );
  }

  return (
    <ResponsiveContainer width="100%" height="100%">
      <PieChart>{pie}</PieChart>
    </ResponsiveContainer>
  );
}
