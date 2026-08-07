import React, { useMemo, useState } from 'react';
import { AlertTriangle, CheckCircle2, Clock, Search } from 'lucide-react';
import { supabase } from '../../../lib/supabase';
import { usePlanning } from '../PlanningModule';
import { loadClientBillings } from '../lib/queries';
import { computeClientProfitability, fmtGBP, fmtPct } from '../lib/projection';

// Pricing — the first decision page of the overhaul. Not another chart:
// it ends in an ACTION. Model the round here, pick the clients, and
// "Stage uplift" writes the exact same pending_* contract the Billing
// module's uplift pipeline reads (see PlanUpliftModal / the Change tab
// on /manage/billing) — staged rows appear there for review, client
// emails and the eventual QBO push. Planning proposes; Billing executes.

const font = "'Outfit', sans-serif";
const GREEN = '#059669', AMBER = '#d97706', RED = '#dc2626', GREY = '#94a3b8';

export default function PricingView() {
  const { clientBillings, clientOverrides, timesheetEntries, staffLines, staffProfiles, scenario } = usePlanning();

  // Local copy so staging can refresh without a whole-module reload.
  const [billings, setBillings] = useState(clientBillings);
  const [selected, setSelected] = useState(() => new Set());
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState('all'); // all | below_cost | low_margin | no_uplift | staged
  const [pct, setPct] = useState(() => Number(scenario?.fee_uplift_pct) || 5);
  const [roundUp, setRoundUp] = useState(true);
  const [effectiveAt, setEffectiveAt] = useState(() => {
    const d = new Date(); d.setMonth(d.getMonth() + 2); d.setDate(1);
    return d.toISOString().slice(0, 10);
  });
  const [reason, setReason] = useState(`Annual fee review ${new Date().getFullYear()}`);
  const [staging, setStaging] = useState(false);
  const [msg, setMsg] = useState(null);

  const profitability = useMemo(
    () => computeClientProfitability({ clientBillings: billings, clientOverrides, timesheetEntries, staffLines, staffProfiles, scenario }),
    [billings, clientOverrides, timesheetEntries, staffLines, staffProfiles, scenario]
  );
  const profByBillingId = useMemo(() => new Map(profitability.map((p) => [p.id, p])), [profitability]);

  // One pricing row per live_billing row, enriched with uplift history
  // pulled from the services jsonb (last_uplift_at / pending_* are
  // preserved across nightly pulls by qbo-pull).
  const rows = useMemo(() => billings.map((b) => {
    const services = Array.isArray(b.services) ? b.services : [];
    const lastUpliftAt = services.reduce((acc, s) => {
      const t = s?.last_uplift_at || s?.pending_uplift_staged_at && null;
      return t && (!acc || t > acc) ? t : acc;
    }, null);
    const hasPending = services.some((s) => s?.pending_monthly_amount != null);
    const prof = profByBillingId.get(b.id);
    const monthsSinceUplift = lastUpliftAt
      ? (Date.now() - new Date(lastUpliftAt).getTime()) / (30.44 * 24 * 36e5)
      : null;
    return {
      ...b,
      services,
      hasPending,
      lastUpliftAt,
      monthsSinceUplift,
      marginPct: prof ? prof.margin_pct : null,
      margin: prof ? prof.margin : null,
      hoursLtm: prof ? prof.hours_ltm : 0,
      effectiveRate: prof ? prof.effective_rate : null,
    };
  }).sort((a, b) => (a.marginPct ?? 1) - (b.marginPct ?? 1)), [billings, profByBillingId]);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter((r) => {
      if (q && !r.entity_name.toLowerCase().includes(q)) return false;
      if (filter === 'below_cost') return r.marginPct != null && r.marginPct < 0 && r.hoursLtm > 0;
      if (filter === 'low_margin') return r.marginPct != null && r.marginPct >= 0 && r.marginPct < 0.3 && r.hoursLtm > 0;
      if (filter === 'no_uplift') return !r.hasPending && (r.monthsSinceUplift == null || r.monthsSinceUplift >= 12);
      if (filter === 'staged') return r.hasPending;
      return true;
    });
  }, [rows, search, filter]);

  const counts = useMemo(() => ({
    below_cost: rows.filter((r) => r.marginPct != null && r.marginPct < 0 && r.hoursLtm > 0).length,
    low_margin: rows.filter((r) => r.marginPct != null && r.marginPct >= 0 && r.marginPct < 0.3 && r.hoursLtm > 0).length,
    no_uplift: rows.filter((r) => !r.hasPending && (r.monthsSinceUplift == null || r.monthsSinceUplift >= 12)).length,
    staged: rows.filter((r) => r.hasPending).length,
  }), [rows]);

  const proposeAmount = (current) => {
    let out = current * (1 + Number(pct) / 100);
    if (roundUp) out = Math.ceil(out * 2) / 2; // nearest £0.50 up, as Billing does
    return Math.round(out * 100) / 100;
  };

  const impact = useMemo(() => {
    let curr = 0, next = 0, lines = 0;
    for (const r of rows) {
      if (!selected.has(r.id)) continue;
      for (const s of r.services) {
        const amt = Number(s?.monthly_amount) || 0;
        if (amt <= 0) continue;
        curr += amt; next += proposeAmount(amt); lines++;
      }
    }
    return { curr, next, lines, deltaMonthly: next - curr, deltaAnnual: (next - curr) * 12 };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, selected, pct, roundUp]);

  const toggle = (id) => setSelected((prev) => {
    const n = new Set(prev);
    if (n.has(id)) n.delete(id); else n.add(id);
    return n;
  });
  const selectVisible = () => setSelected(new Set(visible.filter((r) => !r.hasPending).map((r) => r.id)));
  const clearSelection = () => setSelected(new Set());

  async function stageUplift() {
    const targets = rows.filter((r) => selected.has(r.id));
    if (targets.length === 0) return;
    if (!window.confirm(`Stage a ${pct}% uplift on ${targets.length} client${targets.length !== 1 ? 's' : ''}? They appear on Billing Review → Change for approval; nothing reaches QuickBooks or the client from here.`)) return;
    setStaging(true); setMsg(null);
    let ok = 0; const errs = [];
    for (const r of targets) {
      const services = r.services.map((s) => {
        const amt = Number(s?.monthly_amount) || 0;
        if (amt <= 0) return s;
        const proposed = proposeAmount(amt);
        if (proposed === amt) return s;
        return {
          ...s,
          pending_monthly_amount: proposed,
          pending_effective_at: effectiveAt,
          pending_uplift_reason: reason || null,
          pending_uplift_staged_at: new Date().toISOString(),
          pending_uplift_strategy: `planning:inflation:${pct}%`,
        };
      });
      const { error } = await supabase.from('live_billing').update({
        services,
        uplift_review_status: 'staged',
        uplift_reviewed_by: null,
        uplift_reviewed_at: null,
      }).eq('id', r.id);
      if (error) errs.push(`${r.entity_name}: ${error.message}`);
      else ok++;
    }
    try { setBillings(await loadClientBillings()); } catch { /* keep stale copy */ }
    setSelected(new Set());
    setStaging(false);
    setMsg(errs.length
      ? { tone: 'error', text: `Staged ${ok}; ${errs.length} failed — ${errs[0]}` }
      : { tone: 'ok', text: `Staged ${ok} client${ok !== 1 ? 's' : ''}. Review and release on Billing Review → Change.` });
  }

  const timeCoveredClients = rows.filter((r) => r.hoursLtm > 0).length;

  return (
    <div>
      {/* Costing honesty: with no time capture, margin-based pricing is
          opinion, not data. Say so once, loudly, rather than letting a
          column of "no time data" whisper it. */}
      {rows.length > 10 && timeCoveredClients < rows.length * 0.1 && (
        <div style={{ background: '#fffbeb', border: '1px solid #fcd34d', borderRadius: 10, padding: '12px 16px', marginBottom: 14, fontSize: 12.5, color: '#92400e', lineHeight: 1.6 }}>
          <b>Margins are blind right now:</b> the last twelve months hold time entries for only {timeCoveredClients} of {rows.length} clients,
          so the margin and £/hr columns are empty for nearly everyone. The uplift workflow works regardless — but pricing decisions can't
          be cost-informed until either the team logs time in Athena, or we cost clients from planned effort per service instead
          (a decision for the People phase of the planning overhaul).
        </div>
      )}
      {/* Round modeller */}
      <div style={{ ...card, display: 'flex', gap: 24, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <div>
          <h3 style={h3}>Model the round</h3>
          <p style={{ ...sub, maxWidth: 520 }}>
            Pick clients below, choose the percentage, and stage. Staged uplifts land on
            <b> Billing Review → Change</b> for approval, the client email and the QBO push — nothing
            is sent from this page.
          </p>
        </div>
        <Field label="Uplift %">
          <input type="number" step="0.5" value={pct} onChange={(e) => setPct(e.target.value)} style={{ ...input, width: 80 }} />
        </Field>
        <Field label="Effective from">
          <input type="date" value={effectiveAt} onChange={(e) => setEffectiveAt(e.target.value)} style={input} />
        </Field>
        <Field label="Reason">
          <input type="text" value={reason} onChange={(e) => setReason(e.target.value)} style={{ ...input, width: 220 }} />
        </Field>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: '#475569', paddingBottom: 8, cursor: 'pointer' }}>
          <input type="checkbox" checked={roundUp} onChange={(e) => setRoundUp(e.target.checked)} />
          Round up to £0.50
        </label>
      </div>

      {/* Impact + action */}
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', margin: '14px 0', flexWrap: 'wrap' }}>
        <div style={{ fontSize: 13, color: '#475569' }}>
          <b>{selected.size}</b> client{selected.size !== 1 ? 's' : ''} selected
          {selected.size > 0 && (
            <> · {fmtGBP(impact.curr)}/mo → <b style={{ color: GREEN }}>{fmtGBP(impact.next)}/mo</b>
            {' '}(+{fmtGBP(impact.deltaMonthly)}/mo, <b style={{ color: GREEN }}>+{fmtGBP(impact.deltaAnnual)}/yr</b>)</>
          )}
        </div>
        <div style={{ flex: 1 }} />
        <button onClick={selectVisible} style={btnOutline}>Select all shown</button>
        <button onClick={clearSelection} style={btnOutline}>Clear</button>
        <button onClick={stageUplift} disabled={staging || selected.size === 0}
          style={{ ...btnDark, opacity: staging || selected.size === 0 ? 0.5 : 1 }}>
          {staging ? 'Staging…' : `Stage ${pct}% uplift`}
        </button>
      </div>
      {msg && (
        <div style={{ fontSize: 12.5, padding: '8px 12px', borderRadius: 8, marginBottom: 12, background: msg.tone === 'ok' ? '#f0fdf4' : '#fef2f2', border: `1px solid ${msg.tone === 'ok' ? '#bbf7d0' : '#fecaca'}`, color: msg.tone === 'ok' ? '#166534' : '#991b1b' }}>
          {msg.text}
        </div>
      )}

      {/* Filters */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap', alignItems: 'center' }}>
        <FilterChip label={`All (${rows.length})`} active={filter === 'all'} onClick={() => setFilter('all')} />
        <FilterChip label={`Below cost (${counts.below_cost})`} active={filter === 'below_cost'} onClick={() => setFilter('below_cost')} colour={RED} />
        <FilterChip label={`Margin <30% (${counts.low_margin})`} active={filter === 'low_margin'} onClick={() => setFilter('low_margin')} colour={AMBER} />
        <FilterChip label={`No uplift 12mo+ (${counts.no_uplift})`} active={filter === 'no_uplift'} onClick={() => setFilter('no_uplift')} />
        <FilterChip label={`Already staged (${counts.staged})`} active={filter === 'staged'} onClick={() => setFilter('staged')} colour={GREEN} />
        <div style={{ flex: 1 }} />
        <div style={{ position: 'relative' }}>
          <Search size={13} style={{ position: 'absolute', left: 9, top: 9, color: GREY }} />
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search client…"
            style={{ ...input, paddingLeft: 28, width: 200 }} />
        </div>
      </div>

      {/* Client table */}
      <div style={{ ...card, padding: 0, overflow: 'hidden' }}>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', fontSize: 12.5, borderCollapse: 'collapse', minWidth: 860 }}>
            <thead>
              <tr style={{ background: '#f8fafc', color: '#64748b', fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.5 }}>
                <th style={{ ...th, width: 34 }} />
                <th style={{ ...th, textAlign: 'left' }}>Client</th>
                <th style={th}>Monthly fee</th>
                <th style={th}>Proposed</th>
                <th style={th}>Hours LTM</th>
                <th style={th}>£/hr effective</th>
                <th style={th}>Margin</th>
                <th style={th}>Last uplift</th>
                <th style={{ ...th, textAlign: 'center' }}>Status</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((r) => {
                const proposedRow = r.services.reduce((s, sv) => {
                  const amt = Number(sv?.monthly_amount) || 0;
                  return s + (amt > 0 ? proposeAmount(amt) : 0);
                }, 0);
                const marginColour = r.marginPct == null || r.hoursLtm === 0 ? GREY : r.marginPct < 0 ? RED : r.marginPct < 0.3 ? AMBER : GREEN;
                return (
                  <tr key={r.id} style={{ borderTop: '1px solid #f1f5f9', background: selected.has(r.id) ? '#eff6ff' : undefined, cursor: 'pointer' }}
                    onClick={() => !r.hasPending && toggle(r.id)}>
                    <td style={{ ...td, textAlign: 'center' }}>
                      <input type="checkbox" checked={selected.has(r.id)} disabled={r.hasPending} readOnly />
                    </td>
                    <td style={{ ...td, textAlign: 'left' }}>
                      {r.entity_name}
                      {r.template_linked
                        ? <span style={{ marginLeft: 6, fontSize: 8.5, fontWeight: 800, color: '#fff', background: GREEN, padding: '1px 5px', borderRadius: 4 }}>CONTRACTED</span>
                        : <span style={{ marginLeft: 6, fontSize: 8.5, fontWeight: 800, color: '#fff', background: AMBER, padding: '1px 5px', borderRadius: 4 }}>ESTIMATE</span>}
                    </td>
                    <td style={td}>{fmtGBP(r.monthly_net)}</td>
                    <td style={{ ...td, color: GREEN, fontWeight: 600 }}>{selected.has(r.id) ? fmtGBP(proposedRow) : '—'}</td>
                    <td style={td}>{r.hoursLtm > 0 ? r.hoursLtm.toFixed(1) : '—'}</td>
                    <td style={td}>{r.effectiveRate ? fmtGBP(r.effectiveRate) : '—'}</td>
                    <td style={{ ...td, color: marginColour, fontWeight: 700 }}>
                      {r.marginPct == null || r.hoursLtm === 0 ? 'no time data' : fmtPct(r.marginPct)}
                    </td>
                    <td style={{ ...td, color: '#64748b' }}>
                      {r.lastUpliftAt ? new Date(r.lastUpliftAt).toLocaleDateString('en-GB', { month: 'short', year: 'numeric' }) : 'never'}
                    </td>
                    <td style={{ ...td, textAlign: 'center' }}>
                      {r.hasPending
                        ? <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 10.5, fontWeight: 700, color: GREEN }}><CheckCircle2 size={12} /> staged</span>
                        : r.marginPct != null && r.marginPct < 0 && r.hoursLtm > 0
                          ? <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 10.5, fontWeight: 700, color: RED }}><AlertTriangle size={12} /> below cost</span>
                          : (r.monthsSinceUplift == null || r.monthsSinceUplift >= 12)
                            ? <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 10.5, fontWeight: 600, color: AMBER }}><Clock size={12} /> due</span>
                            : <span style={{ fontSize: 10.5, color: GREY }}>ok</span>}
                    </td>
                  </tr>
                );
              })}
              {visible.length === 0 && (
                <tr><td colSpan={9} style={{ ...td, textAlign: 'center', color: GREY, padding: 24 }}>Nothing matches this filter.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <p style={{ fontSize: 11.5, color: GREY, marginTop: 10, lineHeight: 1.6 }}>
        Margin = annual fee less cost-to-serve from the last twelve months of timesheets at fully-loaded staff rates
        (same maths as the Profitability tab). "No time data" means no hours were logged against the client — the fee
        may still be fine. Clients already staged are locked here until the round is released or rejected in Billing.
      </p>
    </div>
  );
}

function Field({ label, children }) {
  return (
    <div>
      <div style={{ fontSize: 10, fontWeight: 600, color: '#64748b', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 4 }}>{label}</div>
      {children}
    </div>
  );
}

function FilterChip({ label, active, onClick, colour }) {
  return (
    <button onClick={onClick} style={{
      padding: '5px 12px', fontSize: 12, fontWeight: 600, borderRadius: 999, cursor: 'pointer', fontFamily: font,
      background: active ? (colour || '#0f172a') : '#fff',
      color: active ? '#fff' : (colour || '#475569'),
      border: `1px solid ${active ? (colour || '#0f172a') : '#e5e7eb'}`,
    }}>{label}</button>
  );
}

const card = { background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, padding: 20 };
const h3 = { fontFamily: "'Playfair Display', serif", fontSize: 16, fontWeight: 500, color: '#0f172a', margin: 0 };
const sub = { fontSize: 12, color: '#64748b', margin: '6px 0 0', lineHeight: 1.6 };
const th = { padding: '9px 12px', textAlign: 'right', fontWeight: 600 };
const td = { padding: '7px 12px', textAlign: 'right', color: '#0f172a', fontVariantNumeric: 'tabular-nums' };
const input = { padding: '7px 10px', fontSize: 13, fontFamily: font, border: '1px solid #e5e7eb', borderRadius: 7, background: '#fff', color: '#0f172a', outline: 'none', boxSizing: 'border-box' };
const btnDark = { display: 'inline-flex', alignItems: 'center', gap: 5, padding: '8px 14px', fontSize: 13, fontWeight: 600, background: '#0f172a', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontFamily: font };
const btnOutline = { display: 'inline-flex', alignItems: 'center', gap: 5, padding: '8px 14px', fontSize: 13, fontWeight: 600, background: '#fff', color: '#0f172a', border: '1px solid #e5e7eb', borderRadius: 8, cursor: 'pointer', fontFamily: font };
