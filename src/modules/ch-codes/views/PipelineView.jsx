import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AlertTriangle, PhoneCall, Ban } from 'lucide-react';
import { chipStyle, pillStyle } from '../../../lib/tokens';
import { listChCodeRequests, CH_CODE_STATUSES, daysSince } from '../api';

const font = "'Outfit', sans-serif";

function statusMeta(value) {
  return CH_CODE_STATUSES.find((s) => s.value === value) || CH_CODE_STATUSES[0];
}

export default function PipelineView() {
  const navigate = useNavigate();
  const [rows, setRows] = useState(null);
  const [error, setError] = useState(null);
  const [filter, setFilter] = useState('open'); // open | done | all
  const [search, setSearch] = useState('');

  useEffect(() => {
    let cancelled = false;
    listChCodeRequests()
      .then((data) => { if (!cancelled) setRows(data); })
      .catch((e) => { if (!cancelled) setError(e.message); });
    return () => { cancelled = true; };
  }, []);

  const filtered = useMemo(() => {
    if (!rows) return [];
    return rows.filter((r) => {
      if (filter === 'open' && ['entered_on_bm', 'stalled'].includes(r.status)) return false;
      if (filter === 'done' && r.status !== 'entered_on_bm') return false;
      if (search) {
        const q = search.toLowerCase();
        if (!r.person?.name?.toLowerCase().includes(q) && !r.entity?.name?.toLowerCase().includes(q)) return false;
      }
      return true;
    });
  }, [rows, filter, search]);

  const counts = useMemo(() => {
    if (!rows) return { open: 0, callNeeded: 0, escalated: 0 };
    return {
      open: rows.filter((r) => !['entered_on_bm', 'stalled'].includes(r.status)).length,
      callNeeded: rows.filter((r) => r.escalation_status === 'call_needed').length,
      escalated: rows.filter((r) => r.escalation_status === 'escalated_tracy').length,
    };
  }, [rows]);

  return (
    <div style={{ padding: '24px 28px', fontFamily: font }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 18, flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 22, fontWeight: 700, color: '#0f172a' }}>Companies House personal codes</h1>
          <p style={{ margin: '4px 0 0', fontSize: 13, color: '#64748b' }}>
            Chasing directors &amp; PSCs for their CH identity-verification code, ahead of Confirmation Statement filing
          </p>
        </div>
        <div style={{ display: 'flex', gap: 10 }}>
          {counts.callNeeded > 0 && (
            <span style={{ ...chipStyle('danger'), display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 12 }}>
              <PhoneCall size={11} /> {counts.callNeeded} need a call
            </span>
          )}
          {counts.escalated > 0 && (
            <span style={{ ...chipStyle('danger'), display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 12 }}>
              <AlertTriangle size={11} /> {counts.escalated} escalated to Tracy
            </span>
          )}
        </div>
      </div>

      <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap', alignItems: 'center' }}>
        {[['open', 'Open'], ['done', 'Entered on BM'], ['all', 'All']].map(([v, label]) => (
          <button key={v} onClick={() => setFilter(v)} style={pillStyle({ tone: 'info', active: filter === v })}>
            {label}
          </button>
        ))}
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search person or company…"
          style={{ marginLeft: 'auto', padding: '7px 12px', fontSize: 13, fontFamily: font, border: '1px solid #cbd5e1', borderRadius: 8, minWidth: 220, background: '#fff' }}
        />
      </div>

      {error && <div style={{ color: '#b91c1c', fontSize: 13 }}>Failed to load: {error}</div>}
      {!rows && !error && <div style={{ color: '#64748b', fontSize: 13 }}>Loading…</div>}

      {rows && filtered.length === 0 && (
        <div style={{ background: '#fff', border: '1px dashed #cbd5e1', borderRadius: 12, padding: '40px 20px', textAlign: 'center', color: '#64748b', fontSize: 14 }}>
          Nothing here. The daily chaser seeds new requests automatically for directors/PSCs without a code on file.
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {filtered.map((r) => {
          const meta = statusMeta(r.status);
          const age = daysSince(r.requested_at);
          return (
            <div
              key={r.id}
              onClick={() => navigate(`/ch-codes/${r.id}`)}
              style={{
                display: 'grid', gridTemplateColumns: 'minmax(180px, 2fr) 150px 100px minmax(140px, 1fr) 110px',
                gap: 14, alignItems: 'center', background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12,
                padding: '14px 18px', cursor: 'pointer',
              }}
            >
              <div>
                <div style={{ fontSize: 14.5, fontWeight: 600, color: '#0f172a' }}>{r.person?.name || '—'}</div>
                <div style={{ fontSize: 12, color: '#94a3b8', marginTop: 2 }}>{r.entity?.name || '—'}</div>
              </div>
              <span style={{ ...chipStyle(meta.tone), justifySelf: 'start' }}>{meta.label}</span>
              <div style={{ fontSize: 12, color: '#64748b' }}>{r.decision ? (r.decision === 'paid' ? '💳 Paid' : '🙋 Self') : '—'}</div>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {r.escalation_status === 'call_needed' && (
                  <span style={{ ...chipStyle('danger'), display: 'inline-flex', alignItems: 'center', gap: 4 }}><PhoneCall size={10} /> call needed</span>
                )}
                {r.escalation_status === 'escalated_tracy' && (
                  <span style={{ ...chipStyle('danger'), display: 'inline-flex', alignItems: 'center', gap: 4 }}><AlertTriangle size={10} /> escalated</span>
                )}
                {r.status === 'stalled' && (
                  <span style={{ ...chipStyle('neutral'), display: 'inline-flex', alignItems: 'center', gap: 4 }}><Ban size={10} /> stalled</span>
                )}
                {!r.person?.email && !['entered_on_bm', 'stalled'].includes(r.status) && (
                  <span style={chipStyle('warning')}>no email</span>
                )}
              </div>
              <div style={{ fontSize: 12, color: '#64748b', textAlign: 'right' }}>
                {age != null ? `${age}d since offer` : ''}
                {r.chase_count > 0 ? <div>{r.chase_count} chase{r.chase_count === 1 ? '' : 's'}</div> : null}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
