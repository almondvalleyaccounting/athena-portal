import React, { useEffect, useState } from 'react';
import { Routes, Route, Navigate, NavLink } from 'react-router-dom';
import { Landmark } from 'lucide-react';
import { fetchLastRun } from './hmrcApi';
import DebtView from './DebtView';
import ReconcileView from './ReconcileView';
import AuthorisationsView from './AuthorisationsView';
import BalanceView from './BalanceView';
import ClientStatementView from './ClientStatementView';
import PaymentsView from './PaymentsView';
import { font, dateTime } from './hmrcShared';

// HMRC — what the taxman's own records say about our clients.
//
// A scraper walks the HMRC agent services list and writes into a private
// `hmrc` schema; this module is the practice-facing side of it (sql/197 for the
// read surface). PAYE is the only service scraped today, so the tabs are PAYE
// shaped, but the underlying tables carry a `service` discriminator and the
// intention is that VAT / CT / SA slot in beside it rather than replace it.
//
// Each tab answers a different question:
//   PAYE debt          who owes HMRC money, and what have we done about it
//   Client statement   one client's account: months down, opening → charges →
//                      credits → payments → closing, any date range. This is
//                      where a year-end PAYE creditor comes from.
//   Payments           the payment ledger, and what HMRC set each one against
//   Balance analysis   per-scheme, per-tax-year version of the same walk
//   Reconciliation     where the agent list and Athena disagree
//   Not our clients    schemes HMRC still lets us act on with no active client
//                      behind them — authorisation to hand back, or a record to fix
//
// Every list is ACTIVE CLIENTS ONLY (sql/207). Former and archived clients are
// noise on an operational screen; "Not our clients" is where they belong.

const TABS = [
  { to: '/hmrc/paye',           label: 'PAYE debt' },
  { to: '/hmrc/statement',      label: 'Client statement' },
  { to: '/hmrc/payments',       label: 'Payments' },
  { to: '/hmrc/balance',        label: 'Balance analysis' },
  { to: '/hmrc/reconciliation', label: 'Reconciliation' },
  // Renamed from "Authorisations", which said nothing about what it is for.
  // These are schemes HMRC still lets us act on that have no active client —
  // authorisation to hand back, or a client record to correct.
  { to: '/hmrc/authorisations', label: 'Not our clients' },
];

export default function HmrcModule() {
  const [run, setRun] = useState(null);
  const [runError, setRunError] = useState(false);

  useEffect(() => {
    fetchLastRun().then(setRun).catch(() => setRunError(true));
  }, []);

  return (
    <div style={{ padding: '20px 28px', fontFamily: font, maxWidth: 1420 }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 20, flexWrap: 'wrap' }}>
        <div>
          <h1 style={{ fontFamily: "'Playfair Display', serif", fontSize: 26, fontWeight: 500, color: '#0f172a', marginBottom: 2, display: 'flex', alignItems: 'center', gap: 9 }}>
            <Landmark size={22} style={{ color: '#64748b' }} /> HMRC
          </h1>
          <p style={{ fontSize: 13, color: '#64748b', maxWidth: 780, marginBottom: 14, lineHeight: 1.55 }}>
            What HMRC's own records show for our clients, pulled from the agent services list.
            Currently PAYE only — debt, arrears age, payment plans and the schemes where HMRC and
            Athena disagree.
          </p>
        </div>

        {/* Everything on these tabs is only as current as the last scrape, so
            say so where it cannot be missed. */}
        <RunBanner run={run} failed={runError} />
      </div>

      <div style={{ display: 'flex', gap: 2, borderBottom: '1px solid #e5e7eb', marginBottom: 18 }}>
        {TABS.map((t) => (
          <NavLink
            key={t.to}
            to={t.to}
            style={({ isActive }) => ({
              padding: '8px 15px', fontSize: 13, textDecoration: 'none',
              fontWeight: isActive ? 600 : 400,
              color: isActive ? '#0f172a' : '#94a3b8',
              borderBottom: isActive ? '2px solid #0e7fe0' : '2px solid transparent',
              marginBottom: -1,
            })}
          >
            {t.label}
          </NavLink>
        ))}
      </div>

      <Routes>
        <Route index element={<Navigate to="/hmrc/paye" replace />} />
        <Route path="paye" element={<DebtView />} />
        <Route path="statement" element={<ClientStatementView />} />
        <Route path="payments" element={<PaymentsView />} />
        {/* The Trend tab became the per-client statement. Keep old links alive. */}
        <Route path="trend" element={<Navigate to="/hmrc/statement" replace />} />
        <Route path="balance" element={<BalanceView />} />
        <Route path="reconciliation" element={<ReconcileView />} />
        <Route path="authorisations" element={<AuthorisationsView />} />
        <Route path="*" element={<Navigate to="/hmrc/paye" replace />} />
      </Routes>
    </div>
  );
}

function RunBanner({ run, failed }) {
  if (failed) {
    return (
      <div style={{ ...banner, borderColor: '#fecaca', background: '#fef2f2', color: '#b91c1c' }}>
        Could not read the scrape history.
      </div>
    );
  }
  if (!run) {
    return <div style={{ ...banner, color: '#94a3b8' }}>No scrape recorded yet.</div>;
  }

  const stale = run.finished_at
    ? (Date.now() - new Date(run.finished_at).getTime()) / 86400000 > 7
    : false;

  return (
    <div style={{
      ...banner,
      borderColor: stale ? '#fed7aa' : '#e5e7eb',
      background: stale ? '#fff7ed' : '#f8fafc',
    }}>
      <div style={{ fontSize: 10, fontWeight: 600, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: 0.4 }}>
        Last scrape · {run.service?.toUpperCase()} {run.tax_year}
      </div>
      <div style={{ fontSize: 13, fontWeight: 600, color: stale ? '#c2410c' : '#0f172a', marginTop: 3 }}>
        {dateTime(run.finished_at || run.started_at)}
        {stale && <span style={{ fontWeight: 500, fontSize: 11, marginLeft: 6 }}>— over a week old</span>}
      </div>
      <div style={{ fontSize: 11, color: '#64748b', marginTop: 3 }}>
        {run.clients_seen} scheme{run.clients_seen === 1 ? '' : 's'} seen · {run.clients_ok} read
        {run.clients_failed > 0 && (
          <span style={{ color: '#b91c1c', fontWeight: 600 }}> · {run.clients_failed} failed</span>
        )}
      </div>
    </div>
  );
}

const banner = {
  border: '1px solid #e5e7eb', borderRadius: 10, padding: '9px 13px',
  minWidth: 210, fontFamily: font,
};
