import React from 'react';
import { colors, fontStack, H2 } from '../components/ui';

export default function FindingsView({ findings }) {
  const errs = findings.filter(f => f.severity === 'error');
  const warns = findings.filter(f => f.severity === 'warn');
  const infos = findings.filter(f => f.severity === 'info');
  return (
    <div>
      <H2>Findings ({findings.length})</H2>
      {findings.length === 0 ? (
        <div style={{
          padding: 16, background: '#ecfdf5', color: '#065f46',
          borderRadius: 8, fontSize: 13, border: '1px solid #a7f3d0',
        }}>
          ✓ No findings — model integrity OK.
        </div>
      ) : (
        <>
          <Group title="Errors" rows={errs} color={colors.red} />
          <Group title="Warnings" rows={warns} color={colors.amber} />
          <Group title="Info" rows={infos} color={colors.muted} />
        </>
      )}
    </div>
  );
}

function Group({ title, rows, color }) {
  if (rows.length === 0) return null;
  return (
    <div style={{ marginBottom: 18 }}>
      <h3 style={{ fontFamily: fontStack, fontSize: 13, fontWeight: 600, color, margin: '0 0 6px' }}>
        {title} ({rows.length})
      </h3>
      <ul style={{ paddingLeft: 18, margin: 0, fontSize: 13, color: colors.inkSoft }}>
        {rows.slice(0, 50).map((f, i) => (
          <li key={i}>
            <code style={{ fontSize: 11, color: colors.muted }}>{f.code}</code>{' '}
            {f.period != null && <span style={{ color: colors.muted }}>t={f.period}</span>}{' '}
            {f.message}
          </li>
        ))}
        {rows.length > 50 && <li style={{ color: colors.muted }}>… {rows.length - 50} more</li>}
      </ul>
    </div>
  );
}
