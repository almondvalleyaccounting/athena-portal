import React, { useEffect, useMemo, useState } from 'react';
import { Routes, Route, Navigate, NavLink, useLocation, useSearchParams } from 'react-router-dom';
import { Landmark } from 'lucide-react';
import { supabase } from '../../lib/supabase';
import { fetchLatestRunPerService, fetchStaleClients } from './hmrcApi';
import AuthorisationsView from './AuthorisationsView';
import AllTaxesView from './AllTaxesView';
import BreakdownView from './BreakdownView';
import PayeTab from './PayeTab';
import ByTaxView from './ByTaxView';
import ClientSelector from './ClientSelector';
import RefreshButton from './RefreshButton';
import { font, dateTime, TAX_META } from './hmrcShared';

// HMRC — what the taxman's own records say about our clients.
//
// A scraper walks the HMRC agent services list and writes into a private
// `hmrc` schema; this module is the practice-facing side of it (sql/197 for the
// read surface). All four heads are scraped — PAYE, Corporation Tax, VAT and
// Self Assessment — each on its own run cadence, which is why the banner shows
// one line per service rather than a single "last scrape".
//
// THE SHAPE OF IT. There are three levels and one way through them:
//
//   level 0   All taxes — every client, one figure per tax head. The gateway.
//   level 1   click a figure and you land on that tax's tab for that client,
//             showing what the figure is made of: PAYE months, CT accounting
//             periods, VAT lines, SA years.
//   level 2   click a figure there and the transactions behind it open beneath.
//
// Clicking any figure on All taxes also SELECTS that client, and the selection
// then drives every other tab. One client selector sits above the tabs to change
// it; clear it and a tax tab falls back to ranking every client on that head.
//
// Breakdown is the client's whole position: all four heads at once, grouped by
// tax type, answering "what IS this balance made of" without going near a
// transaction. The Total column on All taxes is the link into it, because the
// total is the one figure that is not about a single head.
//
// One tab is housekeeping rather than money:
//   Not our clients  schemes HMRC still lets us act on with no active client
//                    behind them — authorisation to hand back, or a record to fix
// and the 64-8 check — whether HMRC's agent list and Athena's PAYE references
// agree — sits under PAYE, since PAYE references are all it checks.
//
// Every list is ACTIVE CLIENTS ONLY (sql/207). Former and archived clients are
// noise on an operational screen; "Not our clients" is where they belong.

const TABS = [
  { to: 'all',             label: 'All taxes' },
  { to: 'breakdown',       label: 'Breakdown',        client: true },
  { to: 'paye',            label: 'PAYE',             tax: true },
  { to: 'corporation-tax', label: 'Corporation Tax',  tax: true },
  { to: 'vat',             label: 'VAT',              tax: true },
  { to: 'self-assessment', label: 'Self Assessment',  tax: true },
  { to: 'authorisations',  label: 'Not our clients' },
];

export default function HmrcModule() {
  const [runs, setRuns] = useState([]);
  const [stale, setStale] = useState([]);
  const [runError, setRunError] = useState(false);
  const [clients, setClients] = useState([]);
  const [clientsLoading, setClientsLoading] = useState(true);
  const [clientsError, setClientsError] = useState('');
  const [params, setParams] = useSearchParams();
  const location = useLocation();

  const entityId = params.get('entity') || '';

  useEffect(() => {
    fetchLatestRunPerService().then(setRuns).catch(() => setRunError(true));
    // Silent on failure: the staleness line is a health note, not the reason
    // anyone opened this page.
    fetchStaleClients().then(setStale).catch(() => {});
    // One client list for the whole module, so the selector is instant and every
    // tab agrees on who exists and what they owe.
    // 323 rows today. The explicit limit is the module rule rather than a
    // guess: PostgREST caps a fetch at around a thousand and truncates SILENTLY,
    // so every list here says out loud how much it expects.
    supabase.from('v_hmrc_client_totals').select('*').limit(2000)
      .then(({ data, error: e }) => {
        if (e) setClientsError(e.message); else setClients(data || []);
      })
      .then(() => setClientsLoading(false));
  }, []);

  // Which tax tab we are on, if any — the selector needs it to show the right
  // balance beside each name.
  const segment = location.pathname.split('/')[2] || 'all';
  // Breakdown is one client across four heads; the tax tabs are one client on
  // one head. Both are driven by the same selection, so both carry the picker.
  const onClientTab = Boolean(TAX_META[segment]) || segment === 'breakdown';

  const pick = (id) => {
    const next = new URLSearchParams(params);
    if (id) next.set('entity', id); else next.delete('entity');
    // Selecting a client is a navigation, not a filter tweak — it should be
    // possible to go back to the list you came from.
    setParams(next, { replace: false });
  };

  // The entity travels with you between tabs. Without this, clicking "VAT" from
  // a client's PAYE page would silently drop them and show the whole practice.
  const keep = useMemo(() => {
    const q = new URLSearchParams();
    if (entityId) q.set('entity', entityId);
    const s = q.toString();
    return s ? `?${s}` : '';
  }, [entityId]);

  const chosen = clients.find((c) => c.entity_id === entityId);

  return (
    <div style={{ padding: '20px 28px', fontFamily: font, maxWidth: 1420 }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 20, flexWrap: 'wrap' }}>
        <div>
          <h1 style={{ fontFamily: "'Playfair Display', serif", fontSize: 26, fontWeight: 500, color: '#0f172a', marginBottom: 2, display: 'flex', alignItems: 'center', gap: 9 }}>
            <Landmark size={22} style={{ color: '#64748b' }} /> HMRC
          </h1>
          <p style={{ fontSize: 13, color: '#64748b', maxWidth: 780, marginBottom: 14, lineHeight: 1.55 }}>
            What HMRC's own records show for our clients, pulled from the agent services list —
            PAYE, Corporation Tax, VAT and Self Assessment. Start on All taxes, click a balance to
            see what makes it up, click again for the transactions underneath.
          </p>
        </div>

        {/* Everything on these tabs is only as current as the last scrape, so
            say so where it cannot be missed. */}
        <RunBanner runs={runs} stale={stale} failed={runError} />
      </div>

      <div style={{ display: 'flex', gap: 2, borderBottom: '1px solid #e5e7eb', marginBottom: 12, flexWrap: 'wrap' }}>
        {TABS.map((t) => (
          <NavLink
            key={t.to}
            to={`/hmrc/${t.to}${t.tax || t.client || t.to === 'all' ? keep : ''}`}
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

      {/* One selector, four tabs. Only shown where it does something. */}
      {onClientTab && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 12 }}>
          <ClientSelector clients={clients} entityId={entityId} onPick={pick} taxKey={segment} />
          {/* Asks for all four taxes at once: the RPC knows which references
              exist and says which it could not ask about, so there is nothing to
              choose here. It used to live on the Client tab, which is gone. */}
          {entityId && <RefreshButton entityId={entityId} />}
          {chosen ? (
            <span style={{ fontSize: 11.5, color: '#94a3b8' }}>
              Showing {chosen.entity_name} across every tax tab until you clear them.
            </span>
          ) : (
            <span style={{ fontSize: 11.5, color: '#94a3b8' }}>
              {segment === 'breakdown'
                ? 'No client picked — Breakdown is one client across all four heads.'
                : `No client picked — this tab is ranking every client on ${TAX_META[segment]?.label}.`}
            </span>
          )}
        </div>
      )}

      <Routes>
        <Route index element={<Navigate to="/hmrc/all" replace />} />
        <Route path="all" element={<AllTaxesView clients={clients} loading={clientsLoading} error={clientsError} />} />
        <Route path="breakdown" element={<BreakdownView clients={clients} />} />
        <Route path="paye/*" element={<PayeTab clients={clients} />} />
        <Route path="corporation-tax"  element={<ByTaxView tax="corporation-tax" clients={clients} />} />
        <Route path="vat"              element={<ByTaxView tax="vat" clients={clients} />} />
        <Route path="self-assessment"  element={<ByTaxView tax="self-assessment" clients={clients} />} />
        <Route path="authorisations" element={<AuthorisationsView />} />
        {/* Tabs that were folded into others. Old links, and anything bookmarked,
            still land somewhere sensible rather than on a 404 or silently on
            All taxes. */}
        <Route path="by-tax" element={<ByTaxRedirect />} />
        <Route path="client" element={<KeepQuery to="/hmrc/paye" fallback="/hmrc/breakdown" />} />
        <Route path="statement" element={<KeepQuery to="/hmrc/paye" />} />
        <Route path="payments" element={<KeepQuery to="/hmrc/paye/payments" />} />
        <Route path="trend" element={<Navigate to="/hmrc/paye" replace />} />
        {/* Balance analysis said the same thing as the PAYE statement, one tax
            year at a time. Removed rather than kept in parallel. */}
        <Route path="balance" element={<KeepQuery to="/hmrc/paye" />} />
        {/* Reconciliation was never about money — it is whether our 64-8
            authorisation and Athena's PAYE references agree with HMRC's own
            agent list. Renamed for what it is, and moved under PAYE, which is
            the only head whose references it checks. */}
        <Route path="reconciliation" element={<Navigate to="/hmrc/paye/64-8" replace />} />
        <Route path="*" element={<Navigate to="/hmrc/all" replace />} />
      </Routes>
    </div>
  );
}

// One line per tax head, because each is scraped on its own cadence and a figure
// is only as current as the run behind it.
function RunBanner({ runs, stale = [], failed }) {
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
        const isStale = (d ?? 0) > 31;
        return (
          <div key={r.service} style={{ display: 'flex', gap: 8, alignItems: 'baseline', fontSize: 11.5, lineHeight: 1.7 }}>
            <span style={{ minWidth: 96, fontWeight: 600, color: '#0f172a' }}>
              {(r.service || '').replace('-', ' ')}
            </span>
            <span style={{ color: isStale ? '#c2410c' : '#64748b' }}>
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

      <StaleLine stale={stale} />
    </div>
  );
}

// A client whose scrape failed keeps their previous figures rather than
// vanishing, which is right but silent. This is the only place that says so.
function StaleLine({ stale }) {
  const [open, setOpen] = useState(false);
  if (!stale || stale.length === 0) {
    return (
      <div style={{ fontSize: 10.5, color: '#94a3b8', marginTop: 5, borderTop: '1px solid #eef2f6', paddingTop: 4 }}>
        Every client current with the latest scrape of their taxes.
      </div>
    );
  }
  return (
    <div style={{ marginTop: 5, borderTop: '1px solid #eef2f6', paddingTop: 4 }}>
      <button
        onClick={() => setOpen(!open)}
        title="These clients' figures come from an earlier scrape — the most recent one produced nothing for them"
        style={{
          background: 'none', border: 'none', padding: 0, cursor: 'pointer', fontFamily: font,
          fontSize: 10.5, fontWeight: 600, color: '#c2410c',
          textDecoration: 'underline', textDecorationStyle: 'dotted',
        }}
      >
        {stale.length} client{stale.length === 1 ? '' : 's'} on stale data{open ? ' —' : ' +'}
      </button>
      {open && (
        <div style={{ marginTop: 3 }}>
          {stale.map((s) => (
            <div key={`${s.entity_id}-${s.tax}`} style={{ fontSize: 10.5, color: '#78350f', lineHeight: 1.6 }}>
              {s.entity_name}
              <span style={{ color: '#94a3b8' }}> · {(s.tax || '').replace('-', ' ')} · {s.runs_behind} behind</span>
            </div>
          ))}
          <div style={{ fontSize: 10, color: '#94a3b8', marginTop: 3, maxWidth: 280, lineHeight: 1.45 }}>
            Their last scrape produced no data, so earlier figures are still showing. Either it failed or
            they genuinely have nothing — HMRC gives us no per-client reason.
          </div>
        </div>
      )}
    </div>
  );
}

const banner = {
  border: '1px solid #e5e7eb', borderRadius: 10, padding: '9px 13px',
  minWidth: 210, fontFamily: font,
};

// /hmrc/by-tax?tax=vat was the single combined tab. Send those links to the tax's
// own tab rather than 404ing them or silently landing on Corporation Tax.
function ByTaxRedirect() {
  const [params] = useSearchParams();
  const asked = params.get('tax');
  const known = ['corporation-tax', 'vat', 'self-assessment'];
  return <Navigate to={`/hmrc/${known.includes(asked) ? asked : 'corporation-tax'}`} replace />;
}

// Redirect that carries the query string with it. A bookmarked
// /hmrc/statement?scheme=120/RB57081 has to arrive on the PAYE tab still
// pointing at that scheme, or the redirect is just a polite 404.
function KeepQuery({ to, fallback }) {
  const [params] = useSearchParams();
  const q = params.toString();
  if (!q && fallback) return <Navigate to={fallback} replace />;
  return <Navigate to={q ? `${to}?${q}` : to} replace />;
}
