import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { tones, chipStyle, pillStyle } from '../../../lib/tokens';
import ViewTabs from '../components/ViewTabs';
import { listOnboardings, ONBOARDING_STATUSES, STEP_STATUSES, MILESTONE_COLUMNS, findMilestoneCell } from '../api';

const font = "'Outfit', sans-serif";

function statusMeta(value) {
  return ONBOARDING_STATUSES.find((s) => s.value === value) || ONBOARDING_STATUSES[0];
}

// Column groups, in order, derived from consecutive MILESTONE_COLUMNS entries
// sharing the same `group` — MILESTONE_COLUMNS is already authored in group order.
const COLUMN_GROUPS = (() => {
  const groups = [];
  for (const col of MILESTONE_COLUMNS) {
    const last = groups[groups.length - 1];
    if (last && last.name === col.group) last.columns.push(col);
    else groups.push({ name: col.group, columns: [col] });
  }
  return groups;
})();

function Cell({ step, groupStart }) {
  const tdStyle = { padding: 3, borderLeft: groupStart ? '1px solid #e5e7eb' : 'none' };

  if (!step) {
    // Client's template doesn't include this milestone at all.
    return <td style={tdStyle} title="Not part of this client's onboarding template" />;
  }
  const meta = STEP_STATUSES.find((s) => s.value === step.status) || STEP_STATUSES[0];
  const title = `${step.name}\n${meta.label}${step.requested_at ? ` · requested ${new Date(step.requested_at).toLocaleDateString('en-GB')}` : ''}`;

  let boxStyle;
  let glyph = '';
  if (step.status === 'na') {
    boxStyle = { background: tones.neutral.bg, border: `1px solid ${tones.neutral.border}`, color: tones.neutral.fg };
    glyph = '–';
  } else if (step.status === 'pending') {
    boxStyle = { background: '#fff', border: `1px dashed ${tones.neutral.border}` };
  } else {
    const t = tones[meta.tone] || tones.neutral;
    boxStyle = { background: t.solid, border: `1px solid ${t.solid}`, color: t.onSolid };
    if (step.status === 'complete') glyph = '✓';
    if (step.status === 'blocked') glyph = '!';
  }

  return (
    <td style={tdStyle} title={title}>
      <div style={{
        width: 26, height: 20, borderRadius: 5, display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontSize: 11, fontWeight: 700, ...boxStyle,
      }}>
        {glyph}
      </div>
    </td>
  );
}

export default function BoardView() {
  const navigate = useNavigate();
  const [rows, setRows] = useState(null);
  const [error, setError] = useState(null);
  const [filter, setFilter] = useState('open'); // open | complete | all | archived
  const [search, setSearch] = useState('');

  useEffect(() => {
    let cancelled = false;
    listOnboardings()
      .then((data) => { if (!cancelled) setRows(data); })
      .catch((e) => { if (!cancelled) setError(e.message); });
    return () => { cancelled = true; };
  }, []);

  const filtered = useMemo(() => {
    if (!rows) return [];
    return rows.filter((r) => {
      const archived = Boolean(r.archived_at);
      if (filter === 'archived' ? !archived : archived) return false;
      if (filter === 'open' && !['active', 'on_hold', 'issues'].includes(r.status)) return false;
      if (filter === 'complete' && r.status !== 'complete') return false;
      if (search && !r.entity?.name?.toLowerCase().includes(search.toLowerCase())) return false;
      return true;
    });
  }, [rows, filter, search]);

  const nameColStyle = {
    position: 'sticky', left: 0, background: '#fff', zIndex: 2,
    padding: '10px 14px', textAlign: 'left', borderRight: `1px solid #e5e7eb`,
  };

  return (
    <div style={{ padding: '24px 28px', fontFamily: font }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 18, flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 22, fontWeight: 700, color: '#0f172a' }}>Onboarding</h1>
          <p style={{ margin: '4px 0 0', fontSize: 13, color: '#64748b' }}>
            Every client's onboarding, by significant milestone, at a glance
          </p>
        </div>
        <ViewTabs active="Board" />
      </div>

      <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap', alignItems: 'center' }}>
        {[['open', 'Open'], ['complete', 'Complete'], ['all', 'All'], ['archived', 'Archived']].map(([v, label]) => (
          <button key={v} onClick={() => setFilter(v)} style={pillStyle({ tone: 'info', active: filter === v })}>
            {label}
          </button>
        ))}
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search client…"
          style={{
            marginLeft: 'auto', padding: '7px 12px', fontSize: 13, fontFamily: font,
            border: '1px solid #cbd5e1', borderRadius: 8, minWidth: 220, background: '#fff',
          }}
        />
      </div>

      {error && <div style={{ color: tones.danger.fg, fontSize: 13 }}>Failed to load: {error}</div>}
      {!rows && !error && <div style={{ color: '#64748b', fontSize: 13 }}>Loading…</div>}

      {rows && filtered.length === 0 && (
        <div style={{
          background: '#fff', border: '1px dashed #cbd5e1', borderRadius: 12,
          padding: '40px 20px', textAlign: 'center', color: '#64748b', fontSize: 14,
        }}>
          No onboardings here yet.
        </div>
      )}

      {rows && filtered.length > 0 && (
        <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, overflow: 'auto', maxHeight: 'calc(100vh - 220px)' }}>
          <table style={{ borderCollapse: 'collapse', fontSize: 12, width: '100%' }}>
            <thead>
              <tr>
                <th style={{ ...nameColStyle, position: 'sticky', top: 0, left: 0, zIndex: 3, background: '#fff' }} />
                {COLUMN_GROUPS.map((g) => (
                  <th
                    key={g.name}
                    colSpan={g.columns.length}
                    style={{
                      position: 'sticky', top: 0, zIndex: 1, background: '#f8fafc',
                      padding: '6px 4px', fontSize: 10, fontWeight: 700, color: '#64748b',
                      textTransform: 'uppercase', letterSpacing: 0.4, borderBottom: '1px solid #e5e7eb',
                      borderLeft: '1px solid #e5e7eb', textAlign: 'center',
                    }}
                  >
                    {g.name}
                  </th>
                ))}
              </tr>
              <tr>
                <th style={{ ...nameColStyle, position: 'sticky', top: 26, zIndex: 3, borderBottom: '1px solid #e5e7eb' }}>Client</th>
                {MILESTONE_COLUMNS.map((col, i) => {
                  const isGroupStart = i === 0 || MILESTONE_COLUMNS[i - 1].group !== col.group;
                  return (
                    <th
                      key={col.key}
                      title={col.label}
                      style={{
                        position: 'sticky', top: 26, zIndex: 1, background: '#fff',
                        padding: '6px 3px', fontSize: 9.5, fontWeight: 600, color: '#94a3b8',
                        borderBottom: '1px solid #e5e7eb', borderLeft: isGroupStart ? '1px solid #e5e7eb' : 'none',
                        writingMode: 'vertical-rl', transform: 'rotate(180deg)', height: 90, whiteSpace: 'nowrap',
                      }}
                    >
                      {col.label}
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {filtered.map((r) => {
                const meta = statusMeta(r.status);
                return (
                  <tr key={r.id} style={{ cursor: 'pointer' }} onClick={() => navigate(`/onboarding/${r.id}`)}>
                    <td style={{ ...nameColStyle, borderBottom: '1px solid #f1f5f9' }}>
                      <div style={{ fontSize: 13, fontWeight: 600, color: '#0f172a' }}>{r.entity?.name || '—'}</div>
                      <div style={{ marginTop: 3, display: 'flex', alignItems: 'center', gap: 6 }}>
                        <span style={chipStyle(meta.tone)}>{meta.label}</span>
                        <span style={{ fontSize: 10.5, color: '#94a3b8' }}>{r.template?.name || ''}</span>
                      </div>
                    </td>
                    {MILESTONE_COLUMNS.map((col, i) => {
                      const isGroupStart = i === 0 || MILESTONE_COLUMNS[i - 1].group !== col.group;
                      const step = findMilestoneCell(r.steps, col);
                      return <Cell key={col.key} step={step} groupStart={isGroupStart} />;
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
