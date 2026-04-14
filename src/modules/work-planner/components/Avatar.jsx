import React from 'react';
import { teamColour, initials, staffName } from '../lib/helpers';

export default function Avatar({ id, staffMap, size = 22, customColour }) {
  const name = staffName(id, staffMap);
  const colour = customColour || teamColour(id);
  const ini = initials(name);

  return (
    <div
      title={name}
      style={{
        width: size,
        height: size,
        borderRadius: '50%',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: Math.max(7, size * 0.36),
        fontWeight: 600,
        color: '#fff',
        background: colour,
        flexShrink: 0,
        fontFamily: "'Outfit', sans-serif",
      }}
    >
      {ini}
    </div>
  );
}
