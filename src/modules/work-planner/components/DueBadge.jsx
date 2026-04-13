import React from 'react';
import { dueBadge } from '../lib/helpers';

export default function DueBadge({ date }) {
  const badge = dueBadge(date);
  if (!badge) return null;
  return (
    <span
      style={{
        fontSize: 9,
        fontWeight: 500,
        padding: '1px 4px',
        borderRadius: 3,
        background: badge.bg,
        color: badge.colour,
        whiteSpace: 'nowrap',
      }}
    >
      {badge.text}
    </span>
  );
}
