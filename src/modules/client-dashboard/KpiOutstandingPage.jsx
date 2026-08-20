import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { ClipboardList, ArrowRight, Check } from 'lucide-react';
import { supabase } from '../../lib/supabase';
import { OUTFIT, cardStyle, inputStyle } from './dashboardData';

/*
  KPI entry outstanding — /kpis/outstanding.

  Monthly entry gets remembered for about a fortnight. This is the screen that
  makes the gap visible across the whole practice rather than one client at a
  time: every client, every month in range, every entry KPI with no figure
  against it.

  Deliberately not a Work task yet. The list is the lighter thing and does not
  couple the KPI build to the Work module; if it turns out to be ignored, that
  is the moment to promote it to a real task with an owner and a due date.

  Grouped by month rather than by client, because the question people actually
  have is "is last month done", not "is Puddleduck done".
*/

const MONTH_LABEL = (iso) => {
  const d = new Date(`${String(iso).slice(0, 7)}-01T00:00:00`);
  return d.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
};

const monthKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
const addMonths = (key, n) => {
  const [y, m] = key.split('-').map(Number);
  const abs = y * 12 + (m - 1) + n;
  return `${Math.floor(abs / 12)}-${String((abs % 12) + 1).padStart(2, '0')}`;
};

export default function KpiOutstandingPage() {
  const navigate = useNavigate();
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [monthsBack, setMonthsBack] = useState(3);

  // Never asks about the month in progress — nobody has this month's figures on
  // the third, and a list that is permanently wrong gets ignored.
  const lastComplete = useMemo(() => addMonths(monthKey(new Date()), -1), []);
  const from = useMemo(() => addMonths(lastComplete, -(monthsBack - 1)), [lastComplete, monthsBack]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const { data, error: e } = await supabase.rpc('kpi_outstanding', {
        p_from: `${from}-01`, p_to: `${lastComplete}-01`,
      });
      if (e) throw e;
      setRows(data || []);
    } catch (e) { setError(String(e.message || e)); }
    setLoading(false);
  }, [from, lastComplete]);

  useEffect(() => { load(); }, [load]);

  // month → client → the KPIs still missing
  const grouped = useMemo(() => {
    const byMonth = new Map();
    for (const r of rows) {
      const mk = String(r.period).slice(0, 7);
      if (!byMonth.has(mk)) byMonth.set(mk, new Map());
      const clients = byMonth.get(mk);
      if (!clients.has(r.entity_id)) {
        clients.set(r.entity_id, { entity_id: r.entity_id, name: r.entity_name, sector: r.sector_label, items: [] });
      }
      clients.get(r.entity_id).items.push(r);
    }
    return [...byMonth.entries()]
      .sort((a, b) => b[0].localeCompare(a[0]))
      .map(([mk, clients]) => ({ month: mk, clients: [...clients.values()].sort((a, b) => a.name.localeCompare(b.name)) }));
  }, [rows]);

  return (
    <div style={{ maxWidth: 1080, margin: '0 auto', padding: '32px 24px 60px', fontFamily: OUTFIT }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, marginBottom: 18 }}>
        <ClipboardList size={26} style={{ color: '#38bdf8', marginTop: 4 }} />
        <div>
          <h1 style={{ fontFamily: "'Playfair Display', serif", fontSize: 28, fontWeight: 500, color: '#0f172a', margin: 0 }}>
            KPI entry outstanding
          </h1>
          <p style={{ fontSize: 13.5, color: '#64748b', margin: '4px 0 0', maxWidth: 760, lineHeight: 1.6 }}>
            Every client-month with a figure still missing. Only clients that have been put in a
            sector, or given a KPI of their own, appear here — nobody is chased for something they
            were never set up to record.
          </p>
        </div>
        <select
          value={monthsBack} onChange={(e) => setMonthsBack(Number(e.target.value))}
          style={{ ...inputStyle, marginLeft: 'auto', padding: '8px 11px', fontSize: 13 }}
        >
          <option value={1}>Last month</option>
          <option value={3}>Last 3 months</option>
          <option value={6}>Last 6 months</option>
          <option value={12}>Last 12 months</option>
        </select>
      </div>

      {error && (
        <div style={{ padding: '10px 14px', borderRadius: 10, fontSize: 13.5, backgroundColor: '#fef2f2', border: '1px solid #fecaca', color: '#991b1b', marginBottom: 14 }}>
          {error}
        </div>
      )}

      {loading && <p style={{ fontSize: 14, color: '#94a3b8' }}>Loading…</p>}

      {!loading && !error && grouped.length === 0 && (
        <div style={{ ...cardStyle, textAlign: 'center', padding: '48px 24px' }}>
          <Check size={26} style={{ color: '#22c55e', marginBottom: 10 }} />
          <div style={{ fontSize: 15.5, fontWeight: 700, color: '#0f172a', marginBottom: 5 }}>
            Nothing outstanding
          </div>
          <p style={{ fontSize: 13.5, color: '#64748b', margin: 0 }}>
            Every tracked client has its figures in for {monthsBack === 1 ? MONTH_LABEL(lastComplete) : 'the period shown'}.
          </p>
        </div>
      )}

      {grouped.map((g) => {
        const total = g.clients.reduce((s, c) => s + c.items.reduce((x, i) => x + i.missing, 0), 0);
        return (
          <div key={g.month} style={{ marginBottom: 22 }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 8 }}>
              <span style={{ fontSize: 15.5, fontWeight: 700, color: '#0f172a' }}>{MONTH_LABEL(g.month)}</span>
              <span style={{ fontSize: 12, color: '#94a3b8' }}>
                {g.clients.length} client{g.clients.length === 1 ? '' : 's'} · {total} figure{total === 1 ? '' : 's'} missing
              </span>
            </div>

            {g.clients.map((c) => (
              <div key={c.entity_id} style={{ ...cardStyle, padding: '12px 16px', marginBottom: 8 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                  <span style={{ fontSize: 14, fontWeight: 700, color: '#0f172a' }}>{c.name}</span>
                  {c.sector && <span style={chip}>{c.sector}</span>}
                  <button
                    onClick={() => navigate(`/client-dashboard?entity=${c.entity_id}&tab=kpis`)}
                    style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 5, border: '1px solid #e5e7eb', borderRadius: 8, padding: '6px 12px', background: '#fff', color: '#0369a1', fontFamily: OUTFIT, fontSize: 12.5, fontWeight: 600, cursor: 'pointer' }}
                  >
                    Enter them <ArrowRight size={13} />
                  </button>
                </div>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 7 }}>
                  {c.items.map((i) => (
                    <span key={i.definition_id} style={{ ...chip, color: '#b45309', backgroundColor: '#fffbeb', borderColor: '#fde68a' }}>
                      {i.kpi_label}
                      {i.expected > 1 && ` · ${i.missing} of ${i.expected}`}
                    </span>
                  ))}
                </div>
              </div>
            ))}
          </div>
        );
      })}
    </div>
  );
}

const chip = {
  fontSize: 11, fontWeight: 600, padding: '3px 9px', borderRadius: 999,
  border: '1px solid #e5e7eb', backgroundColor: '#f8fafc', color: '#64748b',
};
