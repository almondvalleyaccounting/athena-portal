import React, { useMemo } from 'react';

/**
 * Pure-SVG radar / spider chart for skill levels.
 *
 * skills: [{ id, name, category }]
 * current: { [skillId]: number }
 * target:  { [skillId]: number }
 * maxLevel: scale max (default 5)
 */
export default function RadarChart({
  skills,
  current = {},
  target = {},
  maxLevel = 5,
  size = 460,
  showLegend = true,
}) {
  const cx = size / 2;
  const cy = size / 2;
  const radius = size / 2 - 80;
  const n = skills.length;

  const points = useMemo(() => {
    if (n === 0) return [];
    return skills.map((s, i) => {
      const angle = (Math.PI * 2 * i) / n - Math.PI / 2;
      return {
        skill: s,
        angle,
        x: cx + Math.cos(angle) * radius,
        y: cy + Math.sin(angle) * radius,
      };
    });
  }, [skills, n, cx, cy, radius]);

  const ringValues = Array.from({ length: maxLevel }, (_, i) => i + 1);

  const buildPath = (valueMap) =>
    points
      .map((p, i) => {
        const v = Math.max(0, Math.min(maxLevel, Number(valueMap[p.skill.id] ?? 0)));
        const r = (v / maxLevel) * radius;
        const x = cx + Math.cos(p.angle) * r;
        const y = cy + Math.sin(p.angle) * r;
        return `${i === 0 ? 'M' : 'L'} ${x.toFixed(2)} ${y.toFixed(2)}`;
      })
      .join(' ') + ' Z';

  if (n < 3) {
    return (
      <div style={{
        height: size, display: 'flex', alignItems: 'center', justifyContent: 'center',
        color: '#94a3b8', fontFamily: "'Outfit', sans-serif", fontSize: 13,
      }}>
        Need at least 3 skills to draw a radar chart.
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12 }}>
      <svg width={size} height={size} style={{ overflow: 'visible' }}>
        {/* concentric polygon rings */}
        {ringValues.map((v) => {
          const r = (v / maxLevel) * radius;
          const path = points
            .map((p, i) => {
              const x = cx + Math.cos(p.angle) * r;
              const y = cy + Math.sin(p.angle) * r;
              return `${i === 0 ? 'M' : 'L'} ${x.toFixed(2)} ${y.toFixed(2)}`;
            })
            .join(' ') + ' Z';
          return (
            <path
              key={v}
              d={path}
              fill="none"
              stroke="#e5e7eb"
              strokeWidth={v === maxLevel ? 1.4 : 1}
            />
          );
        })}

        {/* axes */}
        {points.map((p, i) => (
          <line
            key={i}
            x1={cx} y1={cy}
            x2={p.x} y2={p.y}
            stroke="#e5e7eb"
            strokeWidth={1}
          />
        ))}

        {/* target shape */}
        <path
          d={buildPath(target)}
          fill="rgba(56, 189, 248, 0.10)"
          stroke="#38bdf8"
          strokeWidth={1.6}
          strokeDasharray="4 4"
        />

        {/* current shape */}
        <path
          d={buildPath(current)}
          fill="rgba(15, 23, 42, 0.18)"
          stroke="#0f172a"
          strokeWidth={2}
        />

        {/* current points */}
        {points.map((p, i) => {
          const v = Math.max(0, Math.min(maxLevel, Number(current[p.skill.id] ?? 0)));
          const r = (v / maxLevel) * radius;
          const x = cx + Math.cos(p.angle) * r;
          const y = cy + Math.sin(p.angle) * r;
          return (
            <circle key={i} cx={x} cy={y} r={3.2} fill="#0f172a" />
          );
        })}

        {/* axis labels */}
        {points.map((p, i) => {
          const labelDist = radius + 20;
          const lx = cx + Math.cos(p.angle) * labelDist;
          const ly = cy + Math.sin(p.angle) * labelDist;
          const cosA = Math.cos(p.angle);
          let anchor = 'middle';
          if (cosA > 0.2) anchor = 'start';
          else if (cosA < -0.2) anchor = 'end';
          const label = p.skill.name.length > 22 ? p.skill.name.slice(0, 20) + '…' : p.skill.name;
          return (
            <text
              key={i}
              x={lx}
              y={ly}
              textAnchor={anchor}
              dominantBaseline="middle"
              style={{
                fontFamily: "'Outfit', sans-serif",
                fontSize: 11,
                fill: '#475569',
              }}
            >
              {label}
            </text>
          );
        })}
      </svg>

      {showLegend && (
        <div style={{ display: 'flex', gap: 20, fontFamily: "'Outfit', sans-serif", fontSize: 12, color: '#475569' }}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <span style={{ width: 14, height: 3, background: '#0f172a', display: 'inline-block', borderRadius: 2 }} />
            Current level
          </span>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <span style={{
              width: 14, height: 0, borderTop: '2px dashed #38bdf8', display: 'inline-block',
            }} />
            Target level
          </span>
        </div>
      )}
    </div>
  );
}
