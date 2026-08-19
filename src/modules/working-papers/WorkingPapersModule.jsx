import React, { useEffect, useMemo, useState } from 'react';
import { Routes, Route, Navigate, NavLink, useSearchParams } from 'react-router-dom';
import { FileSpreadsheet, Search } from 'lucide-react';
import { fetchPayeReadiness } from './api';
import PayeWorkingPaper from './PayeWorkingPaper';
import NominalMapView from './NominalMapView';
import { font, card, th, thNum, td, tdNum, inputStyle, Pill, ErrorBar } from './wpShared';

/*
 * Working Papers.
 *
 * The reconciliations that have to hold before a set of accounts or a return
 * goes out, each one prepared from independent sources rather than from the
 * ledger explaining itself.
 *
 *   PAYE              HMRC · QuickBooks · BrightPay          (built)
 *   Corporation tax   HMRC · QuickBooks · TaxCalc            (next)
 *   Net wages         BrightPay · QuickBooks                 (after that)
 *
 * WHY A MODULE AND NOT A TAB ON HMRC. The HMRC module answers "what does the
 * taxman say", from one source. A working paper answers "do our three sources
 * agree", and its unit of work is a client-and-a-period rather than a tax head.
 * Putting it under HMRC would have made the HMRC scrape the primary source,
 * which is exactly the assumption a control check is supposed to avoid.
 */

const TABS = [
  { to: 'paye', label: 'PAYE', status: 'live' },
  { to: 'mapping', label: 'Nominal mapping', status: 'live' },
  { to: 'corporation-tax', label: 'Corporation Tax', status: 'planned' },
  { to: 'net-wages', label: 'Net wages', status: 'planned' },
];

const BLOCKER = {
  ready:                    { label: 'Ready', colour: '#15803d', bg: '#f0fdf4' },
  no_nominal_mapping:       { label: 'Needs nominals', colour: '#0e7fe0', bg: '#eff6ff' },
  no_brightpay_link:        { label: 'No BrightPay link', colour: '#7c3aed', bg: '#f5f3ff' },
  no_brightpay_periods:     { label: 'BrightPay not fed', colour: '#7c3aed', bg: '#f5f3ff' },
  no_qbo_connection:        { label: 'No QuickBooks', colour: '#c2410c', bg: '#fff7ed' },
  ambiguous_qbo_connection: { label: 'Two QuickBooks files', colour: '#b91c1c', bg: '#fef2f2' },
  no_paye_ref:              { label: 'No PAYE scheme', colour: '#64748b', bg: '#f1f5f9' },
};

/**
 * The client list.
 *
 * Ordered by how close a client is to having a paper, not alphabetically — the
 * useful question on opening this is "who can I do today", and 443 of 603 active
 * clients have no PAYE scheme at all and are correctly out of scope.
 */
function ClientPicker({ rows, entityId, onPick, loading }) {
  const [q, setQ] = useState('');
  const [showOutOfScope, setShowOutOfScope] = useState(false);

  const ORDER = [
    'ready', 'no_brightpay_periods', 'no_brightpay_link', 'no_nominal_mapping',
    'ambiguous_qbo_connection', 'no_qbo_connection', 'no_paye_ref',
  ];

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return rows
      .filter((r) => showOutOfScope || r.blocker !== 'no_paye_ref')
      .filter((r) => !needle || (r.entity_name || '').toLowerCase().includes(needle))
      .sort((a, b) => ORDER.indexOf(a.blocker) - ORDER.indexOf(b.blocker)
        || (a.entity_name || '').localeCompare(b.entity_name || ''));
  }, [rows, q, showOutOfScope]); // eslint-disable-line react-hooks/exhaustive-deps

  const counts = useMemo(() => {
    const c = {};
    rows.forEach((r) => { c[r.blocker] = (c[r.blocker] || 0) + 1; });
    return c;
  }, [rows]);

  return (
    <div style={{ ...card, marginBottom: 14 }}>
      <div style={{ padding: '8px 10px', borderBottom: '1px solid #e5e7eb', display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <Search size={13} style={{ color: '#94a3b8' }} />
        <input
          value={q} onChange={(e) => setQ(e.target.value)}
          placeholder="Find a client…"
          style={{ ...inputStyle, border: 'none', flex: 1, minWidth: 160, padding: '2px 0' }}
        />
        {ORDER.filter((k) => counts[k]).map((k) => (
          <Pill key={k} colour={BLOCKER[k]?.colour} bg={BLOCKER[k]?.bg}>
            {counts[k]} {BLOCKER[k]?.label.toLowerCase()}
          </Pill>
        ))}
        <button
          onClick={() => setShowOutOfScope((v) => !v)}
          style={{
            padding: '4px 9px', fontSize: 11.5, fontFamily: font, cursor: 'pointer',
            border: '1px solid #e5e7eb', borderRadius: 7, background: '#fff', color: '#475569',
          }}
        >
          {showOutOfScope ? 'Hide clients with no PAYE scheme' : `Show the ${counts.no_paye_ref || 0} with no PAYE scheme`}
        </button>
      </div>
      <div style={{ maxHeight: 250, overflow: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead><tr style={{ background: '#f8fafc' }}>
            <th style={th}>Client</th>
            <th style={th}>PAYE ref</th>
            <th style={th}>QuickBooks</th>
            <th style={thNum}>Nominals</th>
            <th style={thNum}>BrightPay periods</th>
            <th style={th}>State</th>
          </tr></thead>
          <tbody>
            {loading && <tr><td style={{ ...td, color: '#94a3b8' }} colSpan={6}>Loading clients…</td></tr>}
            {!loading && !filtered.length && (
              <tr><td style={{ ...td, color: '#94a3b8' }} colSpan={6}>No client matches that.</td></tr>
            )}
            {filtered.map((r) => {
              const b = BLOCKER[r.blocker] || BLOCKER.no_paye_ref;
              const active = r.entity_id === entityId;
              return (
                <tr
                  key={r.entity_id}
                  onClick={() => onPick(r.entity_id)}
                  style={{
                    borderTop: '1px solid #f1f5f9', cursor: 'pointer',
                    background: active ? '#eff6ff' : undefined,
                  }}
                >
                  <td style={{ ...td, fontWeight: active ? 600 : 400 }}>{r.entity_name}</td>
                  <td style={{ ...td, fontSize: 12, color: '#64748b' }}>{r.paye_ref || '—'}</td>
                  <td style={{ ...td, fontSize: 12, color: '#64748b' }}>
                    {r.qbo_company || '—'}
                    {r.qbo_connections > 1 && (
                      <> <Pill colour="#b91c1c" bg="#fef2f2">{r.qbo_connections} files</Pill></>
                    )}
                  </td>
                  <td style={tdNum}>{r.paye_accounts_mapped || '—'}</td>
                  <td style={tdNum}>{r.brightpay_periods_held || '—'}</td>
                  <td style={td}><Pill colour={b.colour} bg={b.bg}>{b.label}</Pill></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Planned({ title, children }) {
  return (
    <div style={{ ...card, padding: '18px 20px', maxWidth: 820 }}>
      <h3 style={{ fontFamily: "'Playfair Display', serif", fontSize: 17, fontWeight: 500, color: '#0f172a', marginBottom: 8 }}>
        {title}
      </h3>
      <div style={{ fontSize: 13, color: '#475569', lineHeight: 1.65 }}>{children}</div>
    </div>
  );
}

export default function WorkingPapersModule() {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [params, setParams] = useSearchParams();

  const entityId = params.get('entity') || '';

  useEffect(() => {
    fetchPayeReadiness()
      .then(setRows)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  // The client travels with you between papers, the same way it does on HMRC —
  // moving from a client's PAYE paper to their nominal mapping and back is the
  // most common thing anyone will do here.
  const keep = useMemo(() => (entityId ? `?entity=${entityId}` : ''), [entityId]);

  const pick = (id) => {
    const next = new URLSearchParams(params);
    if (id && id !== entityId) next.set('entity', id); else next.delete('entity');
    setParams(next, { replace: false });
  };

  const entity = rows.find((r) => r.entity_id === entityId) || null;

  return (
    <div style={{ padding: '20px 28px', fontFamily: font, maxWidth: 1420 }}>
      <h1 style={{ fontFamily: "'Playfair Display', serif", fontSize: 26, fontWeight: 500, color: '#0f172a', marginBottom: 2, display: 'flex', alignItems: 'center', gap: 9 }}>
        <FileSpreadsheet size={22} style={{ color: '#64748b' }} /> Working Papers
      </h1>
      <p style={{ fontSize: 13, color: '#64748b', maxWidth: 860, marginBottom: 14, lineHeight: 1.55 }}>
        Reconciliations prepared from independent sources, so a balance is agreed rather than explained by
        the ledger that produced it. PAYE compares HMRC's own account, the client's QuickBooks and the
        payroll behind both.
      </p>

      <div style={{ display: 'flex', gap: 2, borderBottom: '1px solid #e5e7eb', marginBottom: 14, flexWrap: 'wrap' }}>
        {TABS.map((t) => (
          <NavLink
            key={t.to}
            to={`/working-papers/${t.to}${keep}`}
            style={({ isActive }) => ({
              padding: '8px 15px', fontSize: 13, textDecoration: 'none',
              fontWeight: isActive ? 600 : 400,
              color: isActive ? '#0f172a' : t.status === 'planned' ? '#cbd5e1' : '#94a3b8',
              borderBottom: isActive ? '2px solid #0e7fe0' : '2px solid transparent',
              marginBottom: -1, display: 'flex', alignItems: 'center', gap: 6,
            })}
          >
            {t.label}
            {t.status === 'planned' && <Pill colour="#94a3b8" bg="#f8fafc">planned</Pill>}
          </NavLink>
        ))}
      </div>

      <ErrorBar message={error} />

      <ClientPicker rows={rows} entityId={entityId} onPick={pick} loading={loading} />

      <Routes>
        <Route index element={<Navigate to={`/working-papers/paye${keep}`} replace />} />
        <Route path="paye" element={<PayeWorkingPaper entity={entity} />} />
        <Route path="mapping" element={<NominalMapView entity={entity} />} />
        <Route path="corporation-tax" element={
          <Planned title="Corporation tax — HMRC · QuickBooks · TaxCalc">
            <p style={{ marginBottom: 10 }}>
              Two of the three legs are already available. HMRC's corporation tax account is scraped
              (5,349 accounting periods and 8,356 transactions held), and the QuickBooks leg needs only the
              <em> Corporation tax</em> role mapped on the Nominal mapping tab — the same mechanism PAYE uses.
            </p>
            <p style={{ marginBottom: 10 }}>
              The missing leg is <strong>TaxCalc</strong>, and it is the one that decides the shape. TaxCalc
              holds the computation and the CT600 as filed, which is the only source that says what the
              charge <em>should</em> be rather than what someone posted or what HMRC has recorded. There is no
              API in use here yet, so the open question is whether it is read from an export, from the
              TaxCalc database, or by driving the application the way BrightPay is driven.
            </p>
            <p>
              The timing rules differ from PAYE's and are simpler: corporation tax follows the accounting
              period, so there is no tax-year panel. What it does need is period alignment — HMRC splits a
              long period into two accounting periods and the ledger almost never does.
            </p>
          </Planned>
        } />
        <Route path="net-wages" element={
          <Planned title="Net wages — BrightPay · QuickBooks">
            <p style={{ marginBottom: 10 }}>
              A two-way check: net pay per the payroll against the wages creditor in the ledger, with the
              bank payments in between. Map the <em>Net wages</em> and <em>Wages control</em> roles on the
              Nominal mapping tab and the QuickBooks leg is ready.
            </p>
            <p>
              This one is blocked on the same thing as PAYE's third leg — BrightPay figures per period in
              Athena. The journal runner posts the journal and records its total, but a total is not a
              gross-to-net analysis, so net pay has to be read from the payroll rather than inferred from
              the journal it produced.
            </p>
          </Planned>
        } />
        <Route path="*" element={<Navigate to="/working-papers/paye" replace />} />
      </Routes>
    </div>
  );
}
