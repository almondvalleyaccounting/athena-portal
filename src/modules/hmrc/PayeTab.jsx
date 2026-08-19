import React, { useEffect, useMemo, useState } from 'react';
import { Routes, Route, Navigate, NavLink, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { fmtGbpDetailed } from '../../lib/money';
import { fetchSchemes } from './hmrcApi';
import ClientStatementView from './ClientStatementView';
import PaymentsView from './PaymentsView';
import DebtView from './DebtView';
import ReconcileView from './ReconcileView';
import { font, ErrorBar, LevelTrail, TIERS, Pill } from './hmrcShared';

// PAYE, all of it, on one tab.
//
// It used to be four: PAYE debt, Client statement, Payments and Balance
// analysis. Three of those were the same client's PAYE account read three ways,
// and the fourth — Balance analysis — was the statement again with the months
// grouped by tax year, which the statement's own date range already does. So:
//
//   Statement   the account itself, months down the side. Level 1.
//   Payments    the cash ledger and what HMRC set each payment against.
//   Chasing     every scheme ranked, with the triage that only PAYE carries.
//   64-8 Check  whether HMRC's agent list and Athena's PAYE references agree.
//               It was a top-level "Reconciliation" tab, which said nothing about
//               what it is for: every row is an authorisation we hold and cannot
//               place, or a reference we hold that HMRC will not honour. It
//               belongs here because PAYE references are the only thing it
//               checks, and it keeps the debt figures honest — a scheme Athena
//               has never heard of is debt missing from every total on the
//               module.
//
// Chasing and the 64-8 check work without a client — one is the list you pick
// from, the other is about schemes that have no client at all. Statement and
// Payments need somebody chosen; the selector above the tabs is where that
// happens, and it survives a move to the VAT tab and back.
//
// ONE CLIENT, MORE THAN ONE SCHEME. A company can hold several PAYE references
// over its life — Tapee ran a scheme, closed it on going dormant, then opened
// another — and HMRC keeps the dead one on the agent list with no cessation
// flag. So where a client has more than one, the schemes are offered rather than
// summed: a statement that blends two schemes is not a statement of either.

const SUBS = [
  { to: '',         label: 'Statement', needsClient: true },
  { to: 'payments', label: 'Payments',  needsClient: true },
  { to: 'chasing',  label: 'Chasing' },
  { to: '64-8',     label: '64-8 Check' },
];

const n = (v) => Number(v || 0);

export default function PayeTab({ clients = [] }) {
  const [params, setParams] = useSearchParams();
  const location = useLocation();
  const navigate = useNavigate();
  const [schemes, setSchemes] = useState([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  const entityId = params.get('entity') || '';
  const askedScheme = params.get('scheme') || '';

  useEffect(() => {
    fetchSchemes()
      .then(setSchemes)
      .catch((e) => setError(e.message || 'Could not load PAYE schemes'))
      .finally(() => setLoading(false));
  }, []);

  const mine = useMemo(
    () => schemes.filter((s) => s.entity_id === entityId),
    [schemes, entityId],
  );

  // A ?scheme= in the URL wins — that is what an old bookmark carries, and what
  // the scheme switch below sets. Otherwise the client's largest scheme.
  const payeRef = useMemo(() => {
    if (askedScheme && schemes.some((s) => s.paye_ref === askedScheme)) return askedScheme;
    return mine.length ? mine[0].paye_ref : '';
  }, [askedScheme, schemes, mine]);

  // A bookmark that names a scheme but no client still has to work: derive the
  // client from the scheme so the selector above shows the right name.
  useEffect(() => {
    if (!askedScheme || entityId || schemes.length === 0) return;
    const s = schemes.find((x) => x.paye_ref === askedScheme);
    if (!s?.entity_id) return;
    const next = new URLSearchParams(params);
    next.set('entity', s.entity_id);
    setParams(next, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [askedScheme, entityId, schemes]);

  const pickScheme = (ref) => {
    const next = new URLSearchParams(params);
    if (ref) next.set('scheme', ref); else next.delete('scheme');
    setParams(next, { replace: false });
  };

  const clearClient = () => {
    const next = new URLSearchParams(params);
    next.delete('entity'); next.delete('scheme');
    setParams(next, { replace: false });
  };

  const chosen = clients.find((c) => c.entity_id === entityId);
  const scheme = schemes.find((s) => s.paye_ref === payeRef);
  // Only the two parameters that identify what you are looking at. The chase
  // list uses ?detail= for its own panel, and dragging that between sub-tabs
  // would reopen it somewhere it makes no sense.
  const keep = (() => {
    const q = new URLSearchParams();
    if (entityId) q.set('entity', entityId);
    if (payeRef) q.set('scheme', payeRef);
    const s = q.toString();
    return s ? `?${s}` : '';
  })();
  const sub = location.pathname.split('/')[3] || '';

  return (
    <div>
      <ErrorBar message={error} />

      <LevelTrail
        level={entityId ? 1 : 0}
        taxKey="paye"
        clientName={chosen?.entity_name}
        onLevel0={() => navigate('/hmrc/all')}
        onClearClient={entityId ? clearClient : null}
      />

      <div style={{ display: 'flex', gap: 3, alignItems: 'center', flexWrap: 'wrap', marginBottom: 12 }}>
        {SUBS.map((s) => {
          const disabled = s.needsClient && !entityId;
          return (
            <NavLink
              key={s.to || 'statement'}
              to={`/hmrc/paye${s.to ? `/${s.to}` : ''}${keep}`}
              end={s.to === ''}
              title={disabled ? 'Pick a client above to see their PAYE account' : ''}
              style={({ isActive }) => ({
                padding: '5px 12px', fontSize: 12, textDecoration: 'none', borderRadius: 999,
                fontFamily: font,
                fontWeight: isActive ? 600 : 500,
                color: disabled ? '#cbd5e1' : isActive ? '#0f172a' : '#64748b',
                background: isActive ? '#f1f5f9' : 'transparent',
                border: `1px solid ${isActive ? '#cbd5e1' : 'transparent'}`,
                pointerEvents: disabled ? 'none' : undefined,
              })}
            >
              {s.label}
            </NavLink>
          );
        })}

        {/* Only shown when it is a real choice. */}
        {mine.length > 1 && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginLeft: 10 }}>
            <span style={{ fontSize: 11, color: '#c2410c', fontWeight: 600 }}>
              {mine.length} schemes —
            </span>
            {mine.map((s) => (
              <button
                key={s.paye_ref}
                onClick={() => pickScheme(s.paye_ref)}
                style={{
                  padding: '4px 9px', fontSize: 11, fontFamily: font, borderRadius: 999, cursor: 'pointer',
                  background: s.paye_ref === payeRef ? '#eff6ff' : '#fff',
                  border: `1px solid ${s.paye_ref === payeRef ? '#bfdbfe' : '#e5e7eb'}`,
                  color: '#0f172a', fontWeight: s.paye_ref === payeRef ? 600 : 400,
                }}
              >
                {s.paye_ref}
                {n(s.total_debt) > 0 && (
                  <span style={{ color: '#b91c1c', marginLeft: 5 }}>{fmtGbpDetailed(s.total_debt)}</span>
                )}
              </button>
            ))}
          </div>
        )}

        {scheme && mine.length === 1 && (
          <span style={{ fontSize: 11.5, color: '#94a3b8', marginLeft: 8 }}>
            {scheme.paye_ref}
            {scheme.chase_tier && (
              <Pill colour={TIERS[scheme.chase_tier].colour} bg={TIERS[scheme.chase_tier].bg}
                    title={TIERS[scheme.chase_tier].hint} style={{ fontSize: 9.5, marginLeft: 6 }}>
                {TIERS[scheme.chase_tier].short}
              </Pill>
            )}
          </span>
        )}
      </div>

      {/* Statement and Payments are about a client. Saying so beats an empty
          table that reads as "nothing owed". */}
      {SUBS.find((s) => (s.to || '') === sub)?.needsClient && !entityId ? (
        <div style={{
          background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12,
          padding: 30, textAlign: 'center', color: '#94a3b8', fontSize: 13,
        }}>
          Pick a client in the selector above to see their PAYE {sub === 'payments' ? 'payments' : 'account'},
          {' '}or use <b>Chasing</b> for every scheme at once.
        </div>
      ) : loading && entityId ? (
        <div style={{ color: '#94a3b8', fontSize: 13, padding: 24 }}>Loading PAYE schemes…</div>
      ) : (
        <Routes>
          <Route index element={<ClientStatementView payeRef={payeRef} scheme={scheme} />} />
          <Route path="payments" element={<PaymentsView payeRef={payeRef} entityName={chosen?.entity_name} />} />
          <Route path="chasing" element={<DebtView entityId={entityId} />} />
          {/* Deliberately NOT filtered to the selected client. The rows worth
              looking at are the ones with no Athena client behind them, and a
              client filter would drop exactly those. */}
          <Route path="64-8" element={<ReconcileView />} />
          <Route path="*" element={<Navigate to="/hmrc/paye" replace />} />
        </Routes>
      )}
    </div>
  );
}
