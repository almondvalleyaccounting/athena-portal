import React, { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { AlertTriangle, Download, ExternalLink, Search } from 'lucide-react';
import { fmtGbp, fmtGbpDetailed } from '../../lib/money';
import { downloadCSV } from '../../lib/exportUtils';
import { useAuth } from '../../shell/AppShell';
import { fetchSchemes, saveReview } from './hmrcApi';
import SchemeDetailPanel from './SchemeDetailPanel';
import {
  font, TIERS, REVIEW_STATUSES, Pill, Stat, Chip, BlurInput, ErrorBar,
  ageLabel, shortDate, th, td, thNum, tdNum, card, inputStyle,
} from './hmrcShared';

// The working list: every PAYE scheme HMRC shows us as agent for, ordered so
// the ones that need chasing are at the top, and marked up as they are worked.
//
// Default view is deliberately narrow — active clients, in arrears, not yet
// triaged. That is the day's work. Everything else is a filter away.

export default function DebtView() {
  const { profile } = useAuth();
  const [params, setParams] = useSearchParams();

  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [tierFilter, setTierFilter] = useState('owing');   // 'owing' | '1' | '2' | '3' | 'clear' | 'all'
  const [statusFilter, setStatusFilter] = useState('open'); // 'open' | <status> | 'all'
  const [search, setSearch] = useState('');

  const selectedRef = params.get('scheme');

  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  async function load() {
    setLoading(true);
    try {
      setRows(await fetchSchemes());
      setError('');
    } catch (e) {
      setError(e.message || 'Could not load HMRC data');
    } finally {
      setLoading(false);
    }
  }

  // Optimistic — the list is long and a round trip per keystroke-free change
  // would make triage feel sticky. On failure we reload from the source.
  async function update(row, patch) {
    setRows((prev) => prev.map((r) => (r.paye_ref === row.paye_ref ? { ...r, ...patch } : r)));
    try {
      await saveReview({
        payeRef: row.paye_ref,
        status: patch.review_status,
        notes: patch.review_notes,
        staffId: profile?.id,
      });
      setError('');
    } catch (e) {
      setError(e.message || 'Could not save');
      load();
    }
  }

  // v_hmrc_paye_clients is active clients only (sql/207) — former and archived
  // schemes never reach this list. They are dealt with on the "Not our clients"
  // tab, which exists for exactly that. No standing selector needed.
  const byStanding = rows;

  const matchesTier = (r) => {
    if (tierFilter === 'all') return true;
    if (tierFilter === 'owing') return r.chase_tier <= 3;
    if (tierFilter === 'clear') return r.chase_tier === 4;
    return String(r.chase_tier) === tierFilter;
  };

  const matchesStatus = (r) => {
    if (statusFilter === 'all') return true;
    // "Open" is the pile that still needs a human: everything not signed off.
    if (statusFilter === 'open') return !['resolved', 'ignore'].includes(r.review_status);
    return r.review_status === statusFilter;
  };

  const matchesSearch = (r) => {
    if (!search.trim()) return true;
    const q = search.trim().toLowerCase();
    return [r.entity_name, r.hmrc_name, r.paye_ref, r.your_reference, r.accounts_office_ref]
      .some((v) => (v || '').toLowerCase().includes(q));
  };

  const filtered = useMemo(
    () => byStanding.filter((r) => matchesTier(r) && matchesStatus(r) && matchesSearch(r)),
    [byStanding, tierFilter, statusFilter, search],
  );

  // Headlines describe the standing filter in force, not the row filters — the
  // total owed should not move when you flip between chase tiers.
  const owing = byStanding.filter((r) => r.chase_tier <= 3);
  const stats = {
    debt: owing.reduce((s, r) => s + Number(r.total_debt || 0), 0),
    schemes: owing.length,
    interest: owing.reduce((s, r) => s + Number(r.accruing_interest || 0), 0),
    arrears: byStanding.filter((r) => r.chase_tier === 1).length,
    untouched: owing.filter((r) => r.review_status === 'pending').length,
  };

  const tierCounts = {
    owing: owing.length,
    1: byStanding.filter((r) => r.chase_tier === 1).length,
    2: byStanding.filter((r) => r.chase_tier === 2).length,
    3: byStanding.filter((r) => r.chase_tier === 3).length,
    clear: byStanding.filter((r) => r.chase_tier === 4).length,
    all: byStanding.length,
  };

  const selected = selectedRef ? rows.find((r) => r.paye_ref === selectedRef) : null;

  const openScheme = (ref) => {
    const next = new URLSearchParams(params);
    next.set('scheme', ref);
    setParams(next, { replace: false });
  };
  const closeScheme = () => {
    const next = new URLSearchParams(params);
    next.delete('scheme');
    setParams(next, { replace: true });
  };

  const exportCsv = () => {
    downloadCSV(
      `hmrc-paye-debt-${new Date().toISOString().slice(0, 10)}.csv`,
      ['Client', 'HMRC name', 'PAYE ref', 'Accounts Office ref', 'Chase tier',
       'Total owed', 'Accruing interest', 'Overdue items', 'Oldest arrears year', 'Days overdue',
       'Payment plan', 'Employment Allowance', 'Status', 'Notes'],
      filtered.map((r) => [
        r.entity_name || '', r.hmrc_name || '', r.paye_ref || '', r.accounts_office_ref || '',
        (TIERS[r.chase_tier] || {}).label || '',
        Number(r.total_debt || 0).toFixed(2), Number(r.accruing_interest || 0).toFixed(2),
        r.overdue_items ?? 0, r.oldest_overdue_year || '', r.days_oldest_overdue ?? '',
        r.payment_plan ? 'Yes' : 'No', r.claiming_ea ? 'Yes' : 'No',
        REVIEW_STATUSES.find((s) => s.value === r.review_status)?.label || r.review_status,
        r.review_notes || '',
      ]),
    );
  };

  return (
    <div>
      <ErrorBar message={error} />

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 10, marginBottom: 16 }}>
        <Stat label="Owed to HMRC" value={fmtGbp(stats.debt)} colour="#b91c1c" big
              hint={`Across ${stats.schemes} scheme${stats.schemes === 1 ? '' : 's'} with a balance`} />
        <Stat label="Accruing interest" value={fmtGbp(stats.interest)} colour="#c2410c"
              hint="Interest still building on unpaid charges" />
        <Stat label="In arrears" value={stats.arrears} colour="#b91c1c"
              hint="Owe from an earlier tax year, no payment plan" />
        <Stat label="Not looked at" value={stats.untouched} colour="#f59e0b"
              hint="Schemes with a balance and no triage status yet" />
        <Stat label="Clear" value={tierCounts.clear} colour="#059669"
              hint="Nothing owed at the last scrape" />
      </div>

      {/* Filters */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <Chip value="owing" label="Owing" count={tierCounts.owing} active={tierFilter} onClick={setTierFilter} />
        <Chip value="1" label={TIERS[1].label} count={tierCounts[1]} active={tierFilter} onClick={setTierFilter} colour={TIERS[1].colour} />
        <Chip value="2" label={TIERS[2].label} count={tierCounts[2]} active={tierFilter} onClick={setTierFilter} colour={TIERS[2].colour} />
        <Chip value="3" label={TIERS[3].label} count={tierCounts[3]} active={tierFilter} onClick={setTierFilter} colour={TIERS[3].colour} />
        <Chip value="clear" label="Clear" count={tierCounts.clear} active={tierFilter} onClick={setTierFilter} colour={TIERS[4].colour} />
        <Chip value="all" label="All schemes" count={tierCounts.all} active={tierFilter} onClick={setTierFilter} />
      </div>

      <div style={{ display: 'flex', gap: 6, marginBottom: 14, flexWrap: 'wrap', alignItems: 'center' }}>
        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} style={{ ...inputStyle, width: 'auto' }}>
          <option value="open">Open — not signed off</option>
          {REVIEW_STATUSES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
          <option value="all">Any status</option>
        </select>

        <div style={{ position: 'relative', minWidth: 220 }}>
          <Search size={13} style={{ position: 'absolute', left: 9, top: 8, color: '#94a3b8' }} />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Name, PAYE ref, Accounts Office ref…"
            style={{ ...inputStyle, paddingLeft: 27 }}
          />
        </div>

        <div style={{ flex: 1 }} />

        <button
          onClick={exportCsv}
          disabled={filtered.length === 0}
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 5, padding: '6px 12px',
            fontSize: 12, fontFamily: font, color: '#475569', background: '#fff',
            border: '1px solid #e5e7eb', borderRadius: 8,
            cursor: filtered.length ? 'pointer' : 'default', opacity: filtered.length ? 1 : 0.5,
          }}
        >
          <Download size={12} /> Export
        </button>
      </div>

      {loading ? (
        <div style={{ color: '#94a3b8', fontSize: 13, padding: 24 }}>Loading HMRC positions…</div>
      ) : (
        <div style={card}>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', fontSize: 13, borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ background: '#f8fafc', fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.5, color: '#64748b' }}>
                  <th style={th}>Client</th>
                  <th style={th}>PAYE ref</th>
                  <th style={thNum}>Owed</th>
                  <th style={thNum}>Interest</th>
                  <th style={th}>Oldest arrears</th>
                  <th style={{ ...th, textAlign: 'center' }}>Items</th>
                  <th style={th}>Flags</th>
                  <th style={th}>Status</th>
                  <th style={th}>Notes</th>
                  <th style={th} />
                </tr>
              </thead>
              <tbody>
                {filtered.length === 0 && (
                  <tr>
                    <td colSpan={10} style={{ padding: 30, textAlign: 'center', color: '#94a3b8' }}>
                      {rows.length === 0
                        ? 'No HMRC data yet — the scrape has not populated anything this module can read.'
                        : 'Nothing matches these filters.'}
                    </td>
                  </tr>
                )}
                {filtered.map((r) => {
                  const tier = TIERS[r.chase_tier] || TIERS[4];
                  const st = REVIEW_STATUSES.find((s) => s.value === r.review_status) || REVIEW_STATUSES[0];
                  return (
                    <tr key={r.paye_ref} style={{ borderTop: '1px solid #f1f5f9' }}>
                      <td style={td}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                          {r.chase_tier === 1 && (
                            <AlertTriangle size={12} style={{ color: tier.colour, flexShrink: 0 }} />
                          )}
                          <button
                            onClick={() => openScheme(r.paye_ref)}
                            style={{
                              background: 'none', border: 'none', padding: 0, cursor: 'pointer',
                              fontFamily: font, fontSize: 13, fontWeight: 500, color: '#0f172a', textAlign: 'left',
                            }}
                            title="Open the full HMRC position for this scheme"
                          >
                            {r.entity_name || r.hmrc_name}
                          </button>
                        </div>
                        {r.entity_name && r.hmrc_name && r.entity_name !== r.hmrc_name && (
                          <div style={{ fontSize: 10, color: '#94a3b8', marginTop: 1 }}>HMRC: {r.hmrc_name}</div>
                        )}
                      </td>
                      <td style={{ ...td, fontSize: 12, color: '#64748b', whiteSpace: 'nowrap' }}>{r.paye_ref}</td>
                      <td style={{ ...tdNum, fontWeight: r.total_debt > 0 ? 600 : 400, color: r.total_debt > 0 ? '#b91c1c' : '#94a3b8' }}>
                        {r.total_debt > 0 ? fmtGbpDetailed(r.total_debt) : '—'}
                      </td>
                      <td style={{ ...tdNum, color: r.accruing_interest > 0 ? '#c2410c' : '#cbd5e1' }}>
                        {r.accruing_interest > 0 ? fmtGbpDetailed(r.accruing_interest) : '—'}
                      </td>
                      <td style={{ ...td, fontSize: 12, color: '#64748b', whiteSpace: 'nowrap' }}>
                        {r.oldest_due_date ? (
                          <span title={`Oldest unpaid charge was due ${shortDate(r.oldest_due_date)} (${r.oldest_overdue_year})`}>
                            {ageLabel(r.days_oldest_overdue)}
                            <span style={{ color: '#cbd5e1', marginLeft: 5 }}>{r.oldest_overdue_year}</span>
                          </span>
                        ) : '—'}
                      </td>
                      <td style={{ ...td, textAlign: 'center', fontSize: 12, color: '#64748b' }}>
                        {r.overdue_items || '—'}
                        {r.penalty_items > 0 && (
                          <span style={{ color: '#b91c1c', fontWeight: 600 }} title={`${r.penalty_items} penalty charge(s)`}>
                            {' '}· {r.penalty_items}P
                          </span>
                        )}
                      </td>
                      <td style={{ ...td, whiteSpace: 'nowrap' }}>
                        <div style={{ display: 'flex', gap: 3 }}>
                          {r.payment_plan && <Pill colour="#0369a1" bg="#f0f9ff" title="Time-to-pay arrangement in place" style={{ fontSize: 10 }}>Plan</Pill>}
                          {r.variable_dd && <Pill colour="#059669" bg="#f0fdf4" title="Paying by variable direct debit" style={{ fontSize: 10 }}>DD</Pill>}
                          {r.claiming_ea && <Pill colour="#7c3aed" bg="#faf5ff" title="Employment Allowance claimed" style={{ fontSize: 10 }}>EA</Pill>}
                        </div>
                      </td>
                      <td style={td}>
                        <select
                          value={r.review_status || 'pending'}
                          onChange={(e) => update(r, { review_status: e.target.value })}
                          style={{ ...inputStyle, width: 'auto', color: st.colour, fontWeight: 500, background: st.bg, border: `1px solid ${st.colour}33` }}
                        >
                          {REVIEW_STATUSES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
                        </select>
                      </td>
                      <td style={{ ...td, minWidth: 170 }}>
                        <BlurInput
                          value={r.review_notes}
                          onChange={(v) => update(r, { review_notes: v })}
                          placeholder="What have we done?"
                        />
                      </td>
                      <td style={{ ...td, whiteSpace: 'nowrap' }}>
                        {r.entity_id && (
                          <a
                            href={`/clients/${r.entity_id}`}
                            target="_blank"
                            rel="noreferrer"
                            style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 12, color: '#64748b', textDecoration: 'none' }}
                          >
                            Client <ExternalLink size={11} />
                          </a>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {selected && <SchemeDetailPanel scheme={selected} onClose={closeScheme} />}
    </div>
  );
}
