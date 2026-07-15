import React from 'react';
import { theme as t } from './theme';

/*
  "Behind the scenes" — our internal/staff work, aggregated by group so the
  client sees real movement (VAT registered, PAYE set up…) without internal
  step wording. The RPC only returns groups where work has actually started,
  so irrelevant groups (e.g. CIS for a non-CIS client) never appear.
*/

const GROUP_LABELS = [
  [/^onboarding$/i, { icon: '🤝', label: 'Getting you set up' }],
  [/^sa( — .+)?$/i, { icon: '👤', label: 'Self Assessment registration' }],
  [/^ct$/i, { icon: '🏛️', label: 'Corporation Tax registration' }],
  [/^vat( registration)?$/i, { icon: '🧾', label: 'VAT registration' }],
  [/^paye( registration)?$/i, { icon: '💷', label: 'PAYE & payroll setup' }],
  [/^cis$/i, { icon: '🏗️', label: 'CIS registration' }],
  [/^tax calc$/i, { icon: '🧮', label: 'Tax software setup' }],
  [/^inform direct$/i, { icon: '📇', label: 'Company records setup' }],
  [/^billing$/i, { icon: '💳', label: 'Billing setup' }],
];

function groupMeta(name) {
  for (const [re, meta] of GROUP_LABELS) {
    if (re.test(name)) {
      // Keep the director's name on layered SA groups ("SA — Jane Smith")
      const suffix = /^sa — (.+)$/i.exec(name);
      return suffix ? { ...meta, label: `Self Assessment — ${suffix[1]}` } : meta;
    }
  }
  return { icon: '⚙️', label: name };
}

function statusLine(g) {
  if (g.done >= g.total) return { text: 'All done', tone: 'done' };
  if (g.waiting_external > 0) {
    let text = 'With HMRC / third party';
    if (g.expected_days != null && g.waiting_since) {
      const due = new Date(g.waiting_since);
      due.setDate(due.getDate() + g.expected_days);
      text += due < new Date()
        ? ' — taking longer than usual, we’re chasing it'
        : ` — usually back by ${due.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}`;
    } else if (g.expected_days != null) {
      text += ` — usually ~${g.expected_days} days`;
    }
    return { text, tone: 'waiting' };
  }
  return { text: 'In progress', tone: 'active' };
}

export default function GroupsSection({ groups, delay = 0 }) {
  if (!groups?.length) return null;
  return (
    <div className="fade-up" style={{ marginTop: 24, animationDelay: `${delay}ms` }}>
      <div style={{ fontSize: 12, fontWeight: 700, color: t.faint, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 10 }}>
        Behind the scenes — no action needed
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(230px, 1fr))', gap: 10 }}>
        {groups.map((g) => {
          const meta = groupMeta(g.name);
          const st = statusLine(g);
          const done = g.done >= g.total;
          const pct = g.total > 0 ? Math.round((g.done / g.total) * 100) : 0;
          return (
            <div key={g.name} style={{
              border: `1px solid ${done ? '#bbf7d0' : t.border}`, borderRadius: 14,
              background: done ? '#f7fdf9' : '#fff', padding: '12px 14px',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontSize: 17 }}>{meta.icon}</span>
                <span style={{ fontSize: 13, fontWeight: 700, color: t.text, flex: 1 }}>{meta.label}</span>
                <span style={{ fontSize: 11.5, color: done ? t.successText : t.faint, fontWeight: 600, whiteSpace: 'nowrap' }}>
                  {done ? '✓' : `${g.done}/${g.total}`}
                </span>
              </div>
              <div style={{ marginTop: 8, height: 5, borderRadius: 999, background: '#eef2f6', overflow: 'hidden' }}>
                <div style={{
                  width: `${pct}%`, height: '100%', borderRadius: 999,
                  background: done ? t.success : t.teal, transition: 'width 0.6s cubic-bezier(0.2, 0.7, 0.3, 1)',
                }} />
              </div>
              <div style={{ marginTop: 7, fontSize: 11.5, color: st.tone === 'done' ? t.successText : st.tone === 'waiting' ? '#92400e' : t.muted }}>
                {st.tone === 'waiting' ? '⏳ ' : st.tone === 'done' ? '' : '🔧 '}{st.text}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
