import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../../lib/supabase';
import { fmtGbpDetailed } from '../../lib/money';
import { font, ErrorBar, card, shortDate, TAX_META, TAX_ORDER } from './hmrcShared';

// The All taxes balance, cut by tax type instead of by client.
//
// All taxes answers "who owes". This answers "what IS this". £903k across four
// heads is not one thing: £463k of Corporation Tax sits in 73 unpaid accounting
// periods, £281k of VAT is mostly filed returns nobody has paid, £148k of PAYE
// is monthly bills plus £5.5k of penalties and interest, and £11k of Self
// Assessment sits behind £14.6k of credit HMRC is holding for the same people.
// Each of those needs a different conversation.
//
// DELIBERATELY NOT TRANSACTION LEVEL. Every figure here is an aggregate of the
// per-client views (sql/222), which are bounded at a few hundred rows. The
// detail views underneath run to thousands — v_hmrc_ct_periods alone is 1,876
// rows — and PostgREST truncates a large fetch SILENTLY at around a thousand,
// which is exactly how this module once under-reported the Corporation Tax book
// by £127,377. Transactions belong on a tax tab with a client chosen, where the
// query is naturally small. Nothing on this page fetches unbounded detail.
//
// Components never get forced to add up. Where HMRC's own parts do not sum to
// its own total, the gap gets its own line and says so.

const n = (v) => Number(v || 0);
const sum = (rows, k) => rows.reduce((s, r) => s + n(r[k]), 0);

export default function BreakdownView() {
  const navigate = useNavigate();
  const [paye, setPaye] = useState([]);
  const [ct, setCt] = useState([]);
  const [vat, setVat] = useState([]);
  const [sa, setSa] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    Promise.all([
      supabase.from('v_hmrc_paye_clients').select('*').limit(2000),
      supabase.from('v_hmrc_ct_by_client').select('*').limit(2000),
      supabase.from('v_hmrc_vat_by_client').select('*').limit(2000),
      supabase.from('v_hmrc_sa_by_client').select('*').limit(2000),
    ])
      .then(([p, c, v, s]) => {
        const bad = [p, c, v, s].find((r) => r.error);
        if (bad) setError(bad.error.message);
        setPaye(p.data || []); setCt(c.data || []);
        setVat(v.data || []);  setSa(s.data || []);
      })
      .catch((e) => setError(e.message || 'Could not load the breakdown'))
      .finally(() => setLoading(false));
  }, []);

  const heads = useMemo(() => buildHeads({ paye, ct, vat, sa }), [paye, ct, vat, sa]);
  const book = heads.reduce((s, h) => s + h.total, 0);

  const open = (taxKey, entityId) => navigate(`/hmrc/${taxKey}?entity=${entityId}`);

  return (
    <div>
      <ErrorBar message={error} />

      <p style={{ fontSize: 13, color: '#64748b', maxWidth: 900, marginTop: 0, marginBottom: 14, lineHeight: 1.55 }}>
        The same book as All taxes, grouped by tax type: what each head's balance is actually made of, how
        old it is and where it is concentrated. Click a client to open their detail for that tax.
      </p>

      {loading ? (
        <div style={{ color: '#94a3b8', fontSize: 13, padding: 24 }}>Reading all four heads…</div>
      ) : (
        <>
          <ShareBar heads={heads} book={book} />
          <div style={{ display: 'grid', gap: 12 }}>
            {heads.map((h) => <HeadCard key={h.key} head={h} book={book} onOpen={open} />)}
          </div>
        </>
      )}
    </div>
  );
}

// Where the book sits, in one line. Not a tile: the point is the proportions
// between the four heads, which no single number carries.
function ShareBar({ heads, book }) {
  if (book <= 0) return null;
  return (
    <div style={{ ...card, padding: '12px 14px', marginBottom: 12 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 13, fontWeight: 600, color: '#0f172a' }}>
          {fmtGbpDetailed(book)} owed to HMRC across the practice
        </span>
        <span style={{ fontSize: 11.5, color: '#94a3b8' }}>
          the same total the All taxes footer shows
        </span>
      </div>
      <div style={{ display: 'flex', height: 12, borderRadius: 999, overflow: 'hidden', background: '#f1f5f9' }}>
        {heads.filter((h) => h.total > 0).map((h) => (
          <div key={h.key} title={`${h.label} ${fmtGbpDetailed(h.total)}`}
               style={{ width: `${(h.total / book) * 100}%`, background: h.colour }} />
        ))}
      </div>
      <div style={{ display: 'flex', gap: 16, marginTop: 7, flexWrap: 'wrap' }}>
        {heads.map((h) => (
          <span key={h.key} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11.5, color: '#475569' }}>
            <span style={{ width: 8, height: 8, borderRadius: 2, background: h.colour }} />
            {h.label} <b style={{ color: '#0f172a' }}>{fmtGbpDetailed(h.total)}</b>
            <span style={{ color: '#94a3b8' }}>{book > 0 ? Math.round((h.total / book) * 100) : 0}%</span>
          </span>
        ))}
      </div>
    </div>
  );
}

function HeadCard({ head, book, onOpen }) {
  const partsTotal = head.parts.reduce((s, p) => s + p.value, 0);
  const residual = Math.round((head.total - partsTotal) * 100) / 100;

  return (
    <div style={{ ...card, borderLeft: `3px solid ${head.colour}` }}>
      <div style={{ padding: '11px 14px', borderBottom: '1px solid #f1f5f9', display: 'flex',
                    alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 14, fontWeight: 700, color: '#0f172a' }}>{head.label}</span>
        <span style={{ fontSize: 16, fontWeight: 700, color: head.total > 0 ? '#b91c1c' : '#059669',
                       fontVariantNumeric: 'tabular-nums' }}>
          {fmtGbpDetailed(head.total)}
        </span>
        <span style={{ fontSize: 11.5, color: '#94a3b8' }}>
          {book > 0 ? `${Math.round((head.total / book) * 100)}% of the book · ` : ''}
          {head.owingClients} of {head.clients} clients carrying a balance
        </span>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(260px, 1.1fr) minmax(200px, 0.8fr) minmax(240px, 1fr)',
                    gap: 0 }}>
        {/* What it is made of */}
        <Pane title="What the balance is made of">
          <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
            <tbody>
              {head.parts.map((p) => (
                <tr key={p.label}>
                  <td style={{ padding: '3px 10px 3px 0', color: '#64748b' }} title={p.hint || ''}>{p.label}</td>
                  <td style={{ padding: '3px 0', textAlign: 'right', fontVariantNumeric: 'tabular-nums',
                               color: p.value < 0 ? '#059669' : '#0f172a' }}>
                    {fmtGbpDetailed(p.value)}
                  </td>
                </tr>
              ))}
              {residual !== 0 && (
                <tr>
                  <td style={{ padding: '3px 10px 3px 0', color: '#b45309' }}
                      title="HMRC's own parts do not add to its own total. Shown rather than absorbed, because absorbing it would make a wrong figure look tidy.">
                    {head.residualLabel}
                  </td>
                  <td style={{ padding: '3px 0', textAlign: 'right', fontVariantNumeric: 'tabular-nums', color: '#b45309' }}>
                    {fmtGbpDetailed(residual)}
                  </td>
                </tr>
              )}
              <tr style={{ borderTop: '1px solid #cbd5e1', fontWeight: 700 }}>
                <td style={{ padding: '5px 10px 3px 0' }}>Balance</td>
                <td style={{ padding: '5px 0 3px', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                  {fmtGbpDetailed(head.total)}
                </td>
              </tr>
            </tbody>
          </table>
          {head.note && (
            <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 8, lineHeight: 1.5 }}>{head.note}</div>
          )}
        </Pane>

        {/* Counts and age */}
        <Pane title="Shape of it">
          <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
            <tbody>
              {head.facts.map((f) => (
                <tr key={f.label}>
                  <td style={{ padding: '3px 10px 3px 0', color: '#64748b' }} title={f.hint || ''}>{f.label}</td>
                  <td style={{ padding: '3px 0', textAlign: 'right', fontWeight: 600,
                               color: f.colour || '#0f172a', fontVariantNumeric: 'tabular-nums' }}>
                    {f.value}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Pane>

        {/* Concentration */}
        <Pane title="Where it is concentrated" last>
          {head.top.length === 0 ? (
            <div style={{ fontSize: 12, color: '#94a3b8' }}>Nothing owing on this head.</div>
          ) : (
            <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
              <tbody>
                {head.top.map((t) => (
                  <tr key={t.entity_id || t.name}>
                    <td style={{ padding: '3px 10px 3px 0' }}>
                      <button
                        onClick={() => t.entity_id && onOpen(head.key, t.entity_id)}
                        disabled={!t.entity_id}
                        title={t.entity_id ? `Open ${t.name} on ${head.label}` : 'Not matched to an Athena client'}
                        style={{
                          background: 'none', border: 'none', padding: 0, textAlign: 'left',
                          fontFamily: font, fontSize: 12, color: t.entity_id ? '#0f172a' : '#94a3b8',
                          cursor: t.entity_id ? 'pointer' : 'default',
                          textDecoration: t.entity_id ? 'underline' : 'none',
                          textDecorationStyle: 'dotted', textDecorationColor: '#cbd5e1',
                        }}
                      >
                        {t.name}
                      </button>
                    </td>
                    <td style={{ padding: '3px 0', textAlign: 'right', fontVariantNumeric: 'tabular-nums', color: '#b91c1c' }}>
                      {fmtGbpDetailed(t.total)}
                    </td>
                  </tr>
                ))}
                {head.topShare > 0 && (
                  <tr>
                    <td colSpan={2} style={{ paddingTop: 7, fontSize: 11, color: '#94a3b8', lineHeight: 1.5 }}>
                      These {head.top.length} carry {head.topShare}% of the {head.label} balance.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          )}
        </Pane>
      </div>
    </div>
  );
}

function Pane({ title, children, last }) {
  return (
    <div style={{ padding: '11px 14px', borderRight: last ? 'none' : '1px solid #f1f5f9', minWidth: 0 }}>
      <div style={{ fontSize: 10, fontWeight: 700, color: '#94a3b8', textTransform: 'uppercase',
                    letterSpacing: 0.4, marginBottom: 7 }}>
        {title}
      </div>
      {children}
    </div>
  );
}

// ── the four heads, each built from its own per-client view ─────────
function buildHeads({ paye, ct, vat, sa }) {
  const top = (rows, nameKey, valueKey, total) => {
    const owing = rows.filter((r) => n(r[valueKey]) > 0)
      .sort((a, b) => n(b[valueKey]) - n(a[valueKey])).slice(0, 5)
      .map((r) => ({ entity_id: r.entity_id, name: r[nameKey] || '—', total: n(r[valueKey]) }));
    const share = total > 0 ? Math.round((owing.reduce((s, r) => s + r.total, 0) / total) * 100) : 0;
    return { top: owing, topShare: share };
  };

  const oldest = (rows, key) => {
    const ds = rows.map((r) => r[key]).filter(Boolean).sort();
    return ds.length ? shortDate(ds[0]) : '—';
  };

  // PAYE. HMRC's own total_debt splits exactly into the monthly bills and the
  // "additional" charges — penalties, interest and specified charges — which is
  // the only split that matters: one is late payroll, the other is a fine.
  const payeTotal = sum(paye, 'total_debt');
  const payeHead = {
    key: 'paye',
    ...TAX_META.paye,
    total: payeTotal,
    clients: paye.length,
    owingClients: paye.filter((r) => n(r.total_debt) > 0).length,
    residualLabel: 'Not split by HMRC',
    parts: [
      { label: 'Monthly PAYE bills unpaid', value: sum(paye, 'overdue_monthly'),
        hint: 'Ordinary payroll months past their 22nd' },
      { label: 'Penalties, interest and specified charges', value: sum(paye, 'overdue_additional'),
        hint: 'HMRC charges that are not a payroll month' },
    ],
    facts: [
      { label: 'In arrears from an earlier year', value: paye.filter((r) => r.chase_tier === 1).length, colour: '#b91c1c',
        hint: 'Owes from a previous tax year and is not on a plan — the ones to chase' },
      { label: 'Behind on this year only', value: paye.filter((r) => r.chase_tier === 2).length, colour: '#c2410c' },
      { label: 'On a payment plan', value: paye.filter((r) => r.chase_tier === 3).length, colour: '#0369a1',
        hint: 'Time-to-pay agreed with HMRC — monitor, do not chase' },
      { label: 'Interest still accruing', value: fmtGbpDetailed(sum(paye, 'accruing_interest')), colour: '#c2410c',
        hint: 'Adds to the debt every day it is not settled' },
      { label: 'Penalty charges', value: fmtGbpDetailed(sum(paye, 'penalties')) },
      { label: 'Oldest overdue item', value: oldest(paye.filter((r) => n(r.total_debt) > 0), 'oldest_due_date') },
    ],
    note: 'PAYE is HMRC\'s overdue figure, so a month charged but not yet due is not in it. The month a '
        + 'year end falls in is — see the client statement on the PAYE tab.',
    ...top(paye, 'entity_name', 'total_debt', payeTotal),
  };

  // Corporation Tax. Tax charged less what has been paid or moved elsewhere;
  // HMRC's own adjustments column is the residual.
  const ctTotal = sum(ct, 'total');
  const ctHead = {
    key: 'corporation-tax',
    ...TAX_META['corporation-tax'],
    total: ctTotal,
    clients: ct.length,
    owingClients: ct.filter((r) => n(r.total) > 0).length,
    residualLabel: 'Adjustments HMRC applied',
    parts: [
      { label: 'Tax charged, all periods', value: sum(ct, 'tax_amount') },
      { label: 'Interest', value: sum(ct, 'interest') },
      { label: 'Penalties', value: sum(ct, 'penalties') },
      { label: 'Less paid', value: sum(ct, 'paid'), hint: 'Cash the client has paid against those periods' },
      { label: 'Less repaid or reallocated', value: sum(ct, 'moved'),
        hint: 'Refunded to the client, or credit moved to another period or tax' },
    ],
    facts: [
      { label: 'Accounting periods held', value: sum(ct, 'periods') },
      { label: 'Periods still unpaid', value: sum(ct, 'unpaid_periods'), colour: '#b91c1c' },
      { label: 'Oldest unpaid period', value: oldest(ct.filter((r) => n(r.total) > 0), 'oldest_unpaid') },
      { label: 'Periods HMRC would not parse', value: ct.filter((r) => r.unreadable).length,
        colour: ct.some((r) => r.unreadable) ? '#b45309' : '#94a3b8',
        hint: 'Treat their figures as unknown rather than zero' },
    ],
    note: 'Charges cover every period HMRC holds, back years included — which is why the gross figures are '
        + 'large and only the net matters.',
    ...top(ct, 'name', 'total', ctTotal),
  };

  // VAT. The split that changes what you do: a return filed and not paid is a
  // collection problem; an assessment is a filing problem, and paying it does
  // not make it go away.
  const vatTotal = sum(vat, 'total');
  const vatAssessed = sum(vat, 'assessed_value');
  const vatHead = {
    key: 'vat',
    ...TAX_META.vat,
    total: vatTotal,
    clients: vat.length,
    owingClients: vat.filter((r) => n(r.total) > 0).length,
    residualLabel: 'Unattributed',
    parts: [
      { label: 'Returns filed and unpaid', value: Math.round((vatTotal - vatAssessed) * 100) / 100,
        hint: 'A collection problem: the figure is agreed, the money has not moved' },
      { label: 'Assessed by HMRC, no return filed', value: vatAssessed,
        hint: 'A filing problem: HMRC has estimated it. Paying the assessment does not file the return' },
    ],
    facts: [
      { label: 'Lines outstanding', value: sum(vat, 'lines') },
      { label: 'Of those, overdue', value: sum(vat, 'overdue_lines'), colour: '#b91c1c' },
      { label: 'Assessments standing', value: sum(vat, 'assessed_lines'), colour: '#c2410c' },
      { label: 'Oldest unpaid period', value: oldest(vat.filter((r) => n(r.total) > 0), 'oldest_unpaid') },
    ],
    ...top(vat, 'name', 'total', vatTotal),
  };

  // Self Assessment. The head where the interesting number is not the debt: HMRC
  // is holding more credit for these clients than they owe, which is the CIS
  // pattern — credit built on PAYE and never asked for back.
  const saTotal = sum(sa, 'total');
  const saHead = {
    key: 'self-assessment',
    ...TAX_META['self-assessment'],
    total: saTotal,
    clients: sa.length,
    owingClients: sa.filter((r) => n(r.total) > 0).length,
    residualLabel: 'Not attributed on HMRC\'s statement',
    parts: [
      { label: 'Tax', value: sum(sa, 'tax_amount') },
      { label: 'Surcharges', value: sum(sa, 'surcharges') },
      { label: 'Interest', value: sum(sa, 'interest') },
      { label: 'Penalties', value: sum(sa, 'penalties') },
    ],
    facts: [
      { label: 'Credit HMRC is holding', value: fmtGbpDetailed(sum(sa, 'credit')), colour: '#0369a1',
        hint: 'Available for repayment or reallocation — not netted off the debt above' },
      { label: 'Repaid out to clients', value: fmtGbpDetailed(sum(sa, 'repaid')), colour: '#059669' },
      { label: 'Credit moved in from another tax', value: fmtGbpDetailed(sum(sa, 'credit_in')), colour: '#7c3aed',
        hint: 'The CIS pattern: credit built up on PAYE, moved across to settle Self Assessment' },
      { label: 'No statement available', value: sa.filter((r) => r.no_statement).length,
        colour: sa.some((r) => r.no_statement) ? '#b45309' : '#94a3b8',
        hint: 'HMRC would not show it, so a zero is unknown rather than nil' },
    ],
    note: 'Credit held is shown beside the debt, never netted against it — they belong to different clients.',
    ...top(sa, 'name', 'total', saTotal),
  };

  const byKey = { paye: payeHead, 'corporation-tax': ctHead, vat: vatHead, 'self-assessment': saHead };
  return TAX_ORDER.map((k) => byKey[k]);
}
