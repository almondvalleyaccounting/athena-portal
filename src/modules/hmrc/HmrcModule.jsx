import React, { useEffect, useState } from 'react';
import { Routes, Route, Navigate, NavLink } from 'react-router-dom';
import { Landmark } from 'lucide-react';
import { fetchLatestRunPerService } from './hmrcApi';
import DebtView from './DebtView';
import ReconcileView from './ReconcileView';
import AuthorisationsView from './AuthorisationsView';
import BalanceView from './BalanceView';
import ClientStatementView from './ClientStatementView';
import PaymentsView from './PaymentsView';
import AllTaxesView from './AllTaxesView';
import ClientTaxView from './ClientTaxView';
import { font, dateTime } from './hmrcShared';

// HMRC — what the taxman's own records say about our clients.
//
// A scraper walks the HMRC agent services list and writes into a private
// `hmrc` schema; this module is the practice-facing side of it (sql/197 for the
// read surface). All four heads are scraped now — PAYE, Corporation Tax, VAT and
// Self Assessment — each on its own run cadence, which is why the banner shows
// one line per service rather than a single "last scrape".
//
// Each tab answers a different question:
//   All taxes          practice-wide across all four heads — who is building debt
//   Client             one client: every tax head plus the whole money ledger
//   PAYE debt          who owes PAYE, and what have we done about it
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
  // Practice-wide first, then the client, then the PAYE detail surfaces.
  { to: '/hmrc/all',            label: 'All taxes' },
  { to: '/hmrc/client',         label: 'Client' },
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
  const [runs, setRuns] = useState([]);
  const [runError, setRunError] = useState(false);

  useEffect(() => {
    fetchLatestRunPerService().then(setRuns).catch(() => setRunError(true));
  }, []);

  return (
    <div style={{ padding: '20px 28px', fontFamily: font, maxWidth: 1420 }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 20, flexWrap: 'wrap' }}>
        <div>
          <h1 style={{ fontFamily: "'Playfair Display', serif", fontSize: 26, fontWeight: 500, color: '#0f172a', marginBottom: 2, display: 'flex', alignItems: 'center', gap: 9 }}>
            <Landmark size={22} style={{ color: '#64748b' }} /> HMRC
          </h1>
          <p style={{ fontSize: 13, color: '#64748b', maxWidth: 780, marginBottom: 14, lineHeight: 1.55 }}>
            What HMRC's own records show for our clients, pulled from the agent services list —
            PAYE, Corporation Tax, VAT and Self Assessment. Balances, how each one was arrived at,
            repayments out, and credit moved between tax heads.
          </p>
        </div>

        {/* Everything on these tabs is only as current as the last scrape, so
            say so where it cannot be missed. */}
        <RunBanner runs={runs} failed={runError} />
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
        <Route index element={<Navigate to="/hmrc/all" replace />} />
        <Route path="all" element={<AllTaxesView />} />
        <Route path="client" element={<ClientTaxView />} />
        <Route path="paye" element={<DebtView />} />
        <Route path="statement" element={<ClientStatementView />} />
        <Route path="payments" element={<PaymentsView />} />
        {/* The Trend tab became the per-client statement. Keep old links alive. */}
        <Route path="trend" element={<Navigate to="/hmrc/statement" replace />} />
        <Route path="balance" element={<BalanceView />} />
        <Route path="reconciliation" element={<ReconcileView />} />
        <Route path="authorisations" element={<AuthorisationsView />} />
        <Route path="*" element={<Navigate to="/hmrc/all" replace />} />
      </Routes>
    </div>
  );
}

// One line per tax head, because each is scraped on its own cadence and a figure
// is only as current as the run behind it.
function RunBanner({ runs, failed }) {
  if (failed) {
    return (
      <div style={{ ...banner, borderColor: '#fecaca', background: '#fef2f2', color: '#b91c1c' }}>
        Could not read the scrape history.
      </div>
    );
  }
  if (!runs || runs.length === 0) {
    return <div style={{ ...banner, color: '#94a3b8' }}>No scrape recorded yet.</div>;
  }

  const staleDays = (r) => {
    const at = r.finished_at || r.started_at;
    return at ? (Date.now() - new Date(at).getTime()) / 86400000 : null;
  };
  // Monthly is the intended sweep, so a month is the point at which a head is
  // out of date rather than merely not-just-run.
  const anyStale = runs.some((r) => (staleDays(r) ?? 0) > 31);

  return (
    <div style={{
      ...banner, minWidth: 300,
      borderColor: anyStale ? '#fed7aa' : '#e5e7eb',
      background: anyStale ? '#fff7ed' : '#f8fafc',
    }}>
      <div style={{ fontSize: 10, fontWeight: 600, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 3 }}>
        Last scrape by tax
      </div>
      {runs.map((r) => {
        const d = staleDays(r);
        const stale = (d ?? 0) > 31;
        return (
          <div key={r.service} style={{ display: 'flex', gap: 8, alignItems: 'baseline', fontSize: 11.5, lineHeight: 1.7 }}>
            <span style={{ minWidth: 96, fontWeight: 600, color: '#0f172a' }}>
              {(r.service || '').replace('-', ' ')}
            </span>
            <span style={{ color: stale ? '#c2410c' : '#64748b' }}>
              {dateTime(r.finished_at || r.started_at)}
            </span>
            <span style={{ color: '#94a3b8' }}>
              {r.clients_seen}
              {r.clients_failed > 0 && (
                <span style={{ color: '#b91c1c', fontWeight: 600 }}> · {r.clients_failed} failed</span>
              )}
            </span>
          </div>
        );
      })}
      {anyStale && (
        <div style={{ fontSize: 10.5, color: '#c2410c', marginTop: 3 }}>
          A tax head is over a month old — the sweep is meant to be monthly.
        </div>
      )}
    </div>
  );
}

const banner = {
  border: '1px solid #e5e7eb', borderRadius: 10, padding: '9px 13px',
  minWidth: 210, fontFamily: font,
};
