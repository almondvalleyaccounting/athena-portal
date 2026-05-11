import React from 'react';

export const FONT = "'Outfit', sans-serif";
export const SERIF = "'Playfair Display', serif";

export function Card({ children, style }) {
  return (
    <div style={{
      background: '#fff',
      border: '1px solid #e5e7eb',
      borderRadius: 14,
      padding: 20,
      ...style,
    }}>
      {children}
    </div>
  );
}

export function SectionTitle({ kicker, title, hint }) {
  return (
    <div style={{ marginBottom: 16 }}>
      {kicker && (
        <div style={{
          fontFamily: FONT, fontSize: 11, fontWeight: 700, letterSpacing: '0.08em',
          textTransform: 'uppercase', color: '#0e7fe0', marginBottom: 4,
        }}>{kicker}</div>
      )}
      <h2 style={{
        fontFamily: SERIF, fontSize: 22, fontWeight: 500, color: '#0f172a', margin: 0,
      }}>{title}</h2>
      {hint && (
        <p style={{ fontFamily: FONT, fontSize: 13, color: '#64748b', margin: '6px 0 0' }}>{hint}</p>
      )}
    </div>
  );
}

export function Stat({ label, value, sub, accent = '#0f172a' }) {
  return (
    <div style={{
      background: '#fff', border: '1px solid #e5e7eb', borderRadius: 14, padding: 18,
    }}>
      <div style={{ fontFamily: FONT, fontSize: 11, fontWeight: 700, letterSpacing: '0.06em',
        textTransform: 'uppercase', color: '#94a3b8', marginBottom: 6 }}>{label}</div>
      <div style={{ fontFamily: SERIF, fontSize: 30, fontWeight: 500, color: accent, lineHeight: 1 }}>{value}</div>
      {sub && <div style={{ fontFamily: FONT, fontSize: 12, color: '#64748b', marginTop: 6 }}>{sub}</div>}
    </div>
  );
}

export function Button({ children, onClick, variant = 'primary', disabled, style }) {
  const variants = {
    primary: { bg: '#0f172a', fg: '#fff' },
    accent:  { bg: '#0e7fe0', fg: '#fff' },
    ghost:   { bg: 'transparent', fg: '#0f172a', border: '1px solid #e5e7eb' },
    danger:  { bg: 'transparent', fg: '#dc2626', border: '1px solid #fee2e2' },
  };
  const v = variants[variant] || variants.primary;
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        background: disabled ? '#e5e7eb' : v.bg,
        color: disabled ? '#94a3b8' : v.fg,
        fontFamily: FONT,
        fontSize: 13,
        fontWeight: 600,
        border: v.border || 'none',
        borderRadius: 10,
        padding: '9px 16px',
        cursor: disabled ? 'not-allowed' : 'pointer',
        transition: 'all 0.15s',
        ...style,
      }}
    >{children}</button>
  );
}

export function Input(props) {
  return (
    <input
      {...props}
      style={{
        border: '1px solid #e5e7eb',
        borderRadius: 10,
        padding: '10px 12px',
        fontSize: 14,
        fontFamily: FONT,
        outline: 'none',
        width: '100%',
        ...props.style,
      }}
      onFocus={(e) => { e.target.style.borderColor = '#38bdf8'; props.onFocus?.(e); }}
      onBlur={(e) => { e.target.style.borderColor = '#e5e7eb'; props.onBlur?.(e); }}
    />
  );
}

export function Textarea(props) {
  return (
    <textarea
      {...props}
      style={{
        border: '1px solid #e5e7eb',
        borderRadius: 10,
        padding: '10px 12px',
        fontSize: 14,
        fontFamily: FONT,
        outline: 'none',
        width: '100%',
        resize: 'vertical',
        minHeight: 80,
        ...props.style,
      }}
    />
  );
}

export function Select(props) {
  return (
    <select
      {...props}
      style={{
        border: '1px solid #e5e7eb',
        borderRadius: 10,
        padding: '10px 12px',
        fontSize: 14,
        fontFamily: FONT,
        outline: 'none',
        background: '#fff',
        cursor: 'pointer',
        ...props.style,
      }}
    >{props.children}</select>
  );
}

export function Pill({ children, bg = '#f1f5f9', fg = '#475569' }) {
  return (
    <span style={{
      display: 'inline-block',
      fontFamily: FONT, fontSize: 11, fontWeight: 600, letterSpacing: '0.04em',
      textTransform: 'uppercase',
      background: bg, color: fg,
      padding: '3px 10px', borderRadius: 999,
    }}>{children}</span>
  );
}

export function ProgressBar({ value, max = 100, color = '#0e7fe0', height = 8 }) {
  const pct = Math.max(0, Math.min(100, (value / max) * 100));
  return (
    <div style={{
      width: '100%', height, background: '#f1f5f9', borderRadius: 999, overflow: 'hidden',
    }}>
      <div style={{
        width: `${pct}%`, height: '100%', background: color, borderRadius: 999,
        transition: 'width 0.3s ease',
      }} />
    </div>
  );
}

export function EmptyState({ icon, title, hint }) {
  return (
    <div style={{
      textAlign: 'center', padding: '60px 20px',
      border: '1px dashed #e5e7eb', borderRadius: 14, background: '#fafafa',
    }}>
      {icon && <div style={{ marginBottom: 12, color: '#cbd5e1' }}>{icon}</div>}
      <p style={{ fontFamily: FONT, fontSize: 15, fontWeight: 500, color: '#94a3b8', margin: 0 }}>{title}</p>
      {hint && <p style={{ fontFamily: FONT, fontSize: 13, color: '#cbd5e1', margin: '6px 0 0' }}>{hint}</p>}
    </div>
  );
}

export function LevelDot({ level, max = 5, size = 14, onClick, hoverable }) {
  return (
    <div style={{ display: 'flex', gap: 4 }}>
      {Array.from({ length: max }, (_, i) => {
        const filled = i < level;
        return (
          <div
            key={i}
            onClick={onClick ? () => onClick(i + 1) : undefined}
            style={{
              width: size, height: size, borderRadius: '50%',
              background: filled ? '#0f172a' : '#e5e7eb',
              cursor: onClick ? 'pointer' : 'default',
              transition: 'transform 0.1s',
            }}
            onMouseEnter={(e) => { if (hoverable) e.currentTarget.style.transform = 'scale(1.18)'; }}
            onMouseLeave={(e) => { if (hoverable) e.currentTarget.style.transform = 'scale(1)'; }}
          />
        );
      })}
    </div>
  );
}
