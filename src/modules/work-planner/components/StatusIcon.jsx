import React from 'react';
import { getStatus } from '../lib/helpers';

export default function StatusIcon({ status, dark = false, size = 9 }) {
  const s = getStatus(status);
  if (!s) return null;
  return (
    <span
      title={s.label}
      style={{
        color: dark ? 'rgba(255,255,255,0.85)' : s.colour,
        fontSize: size,
        flexShrink: 0,
        lineHeight: 1,
      }}
    >
      {s.icon}
    </span>
  );
}
