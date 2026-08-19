import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { ExternalLink } from 'lucide-react';
import { supabase } from '../../lib/supabase';
import { fmtGbpDetailed } from '../../lib/money';
import { font, ErrorBar, card, shortDate, ageLabel, TAX_META, TAX_ORDER, TIERS, Pill } from './hmrcShared';

// One client, all four tax heads, grouped by tax type.
//
// All taxes says a client owes £68,252. This says what that IS: £2,658 of PAYE
// that is two months of payroll plus a penalty, £41,000 of Corporation Tax
// spread over three unpaid accounting periods, £24,594 of VAT of which £4,799 is
// an assessment because a return was never filed. Those are three different
// conversations, and the single total hides all of them.
//
// The Total column on All taxes is the way in. Every other figure there opens a
// single head; the total is the only one that is about the client rather than a
// tax, so it opens this.
//
// DELIBERATELY NOT TRANSACTION LEVEL. The question here is "what is this made
// of", not "when did each payment land". Every figure is either a component of a
// balance or a count; the individual charges and payments are one level further
// down, on the head's own tab, and each card links straight to it.
//
// Components never get forced to add up. Where HMRC's own parts do not sum to
// its own total, the gap gets its own line and says so.

const n = (v) => Number(v || 0);
const sum = (rows, k) => rows.reduce((s, r) => s + n(r[k]), 0);
const today = () => new Date().toISOString().slice(0, 10);

export default function BreakdownView({ clients = [] }) {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const entityId = params.get('entity') || '';

  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!entityId) { setData(null); return undefined; }
    let cancelled = false;
    setLoading(true);
    // One client, so every query is naturally small. Nothing here fetches a
    // practice-wide detail table — that is how this module once under-reported
    // the Corporation Tax book by £127,377 to a silent PostgREST truncation.
    Promise.all([
      supabase.from('v_hmrc_paye_clients').select('*').eq('entity_id', entityId),
      supabase.from('v_hmrc_ct_periods').select('*').eq('entity_id', entityId).limit(2000),
      supabase.from('v_hmrc_vat_owed').select('*').eq('entity_id', entityId).limit(2000),
      supabase.from('v_hmrc_sa_position').select('*').eq('entity_id', entityId),
      supabase.from('v_hmrc_money_movements').select('*').eq('entity_id', entityId).limit(2000),
    ]).then(async ([paye, ct, vat, sa, mv]) => {
      if (cancelled) return;
      const bad = [paye, ct, vat, sa, mv].find((r) => r.error);
      setError(bad ? bad.error.message : '');

      // What is charged but not yet payable is not debt and is not in HMRC's
      // figure — but it is the next bill, and on a client page that matters.
      // One call per scheme; a client has one or two.
      const schemes = paye.data || [];
      const proofs = await Promise.all(schemes.map((s) =>
        supabase.rpc('hmrc_paye_balance_at', { p_paye_ref: s.paye_ref, p_as_at: today() })
          .then(({ data }) => (data || [])[0] || null)
          .catch(() => null)));

      if (cancelled) return;
      setData({
        paye: schemes,
        proofs: proofs.filter(Boolean),
        ct: ct.data || [],
        vat: vat.data || [],
        sa: sa.data || [],
        moves: mv.data || [],
      });
    }).catch((e) => {
      if (!cancelled) setError(e.message || 'Could not load this client');
    }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [entityId]);

  const chosen = clients.find((c) => c.entity_id === entityId);
  const heads = useMemo(() => (data ? buildHeads(data) : []), [data]);
  const total = heads.reduce((s, h) => s + h.balance, 0);

  if (!entityId) {
    return (
      <div>
        <p style={{ fontSize: 13, color: '#64748b', maxWidth: 900, marginTop: 0, marginBottom: 14, lineHeight: 1.55 }}>
          One client, all four tax heads, grouped by tax type — what each balance is actually made of.
        </p>
        <div style={{ ...card, padding: 30, textAlign: 'center', color: '#94a3b8', fontSize: 13, lineHeight: 1.6 }}>
          Pick a client in the selector above, or click a <b>Total</b> on the All taxes tab.
          <div style={{ marginTop: 6, fontSize: 12 }}>
            The practice-wide position is what <b>All taxes</b> is for; this page is one client.
          </div>
        </div>
      </div>
    );
  }

  return (
    <div>
      <ErrorBar message={error} />

      <p style={{ fontSize: 13, color: '#64748b', maxWidth: 900, marginTop: 0, marginBottom: 14, lineHeight: 1.55 }}>
        {chosen ? <><b>{chosen.entity_name}</b> — </> : null}
        every tax head, grouped by type: what each balance is made of, how old it is and what has moved.
        The individual charges and payments are one level down, on each head&rsquo;s own tab.
      </p>

      {loading ? (
        <div style={{ color: '#94a3b8', fontSize: 13, padding: 24 }}>Reading all four heads…</div>
      ) : !data ? null : (
        <>
          <Summary heads={heads} total={total} chosen={chosen} moves={data.moves} entityId={entityId} />
          <div style={{ display: 'grid', gap: 12 }}>
            {heads.map((h) => (
              <HeadCard key={h.key} head={h} total={total}
                        onOpen={() => navigate(`/hmrc/${h.key}?entity=${entityId}`)} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

// The client's whole position in one strip: where it sits, and the movements
// that cross tax heads — the only thing no single head can show.
function Summary({ heads, total, chosen, moves, entityId }) {
  const mv = (kind) => moves.filter((m) => m.movement === kind).reduce((s, m) => s + n(m.amount), 0);
  const creditHeld = heads.reduce((s, h) => s + h.creditHeld, 0);
  const positive = heads.filter((h) => h.balance > 0);
  const span = positive.reduce((s, h) => s + h.balance, 0);

  return (
    <div style={{ ...card, padding: '12px 14px', marginBottom: 12 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 8, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 15, fontWeight: 700, color: total > 0 ? '#b91c1c' : '#059669' }}>
          {fmtGbpDetailed(total)}
        </span>
        <span style={{ fontSize: 12.5, color: '#475569' }}>
          owed to HMRC across {heads.filter((h) => h.known).length} tax head
          {heads.filter((h) => h.known).length === 1 ? '' : 's'}
        </span>
        {creditHeld > 0 && (
          <span style={{ fontSize: 12.5, color: '#475569' }}>
            · <b style={{ color: '#0369a1' }}>{fmtGbpDetailed(creditHeld)}</b> credit HMRC is holding
          </span>
        )}
        <div style={{ flex: 1 }} />
        {chosen && (
          <a href={`/clients/${entityId}`} target="_blank" rel="noreferrer"
             style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 12, color: '#0e7fe0', textDecoration: 'none' }}>
            Client record <ExternalLink size={11} />
          </a>
        )}
      </div>

      {span > 0 && (
        <>
          <div style={{ display: 'flex', height: 10, borderRadius: 999, overflow: 'hidden', background: '#f1f5f9' }}>
            {positive.map((h) => (
              <div key={h.key} title={`${h.label} ${fmtGbpDetailed(h.balance)}`}
                   style={{ width: `${(h.balance / span) * 100}%`, background: h.colour }} />
            ))}
          </div>
          <div style={{ display: 'flex', gap: 14, marginTop: 7, flexWrap: 'wrap' }}>
            {positive.map((h) => (
              <span key={h.key} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11.5, color: '#475569' }}>
                <span style={{ width: 8, height: 8, borderRadius: 2, background: h.colour }} />
                {h.label} <b style={{ color: '#0f172a' }}>{fmtGbpDetailed(h.balance)}</b>
                <span style={{ color: '#94a3b8' }}>{Math.round((h.balance / span) * 100)}%</span>
              </span>
            ))}
          </div>
        </>
      )}

      {/* Money crossing between heads. A CIS subcontractor builds credit on
          PAYE, we ask HMRC to move it against Corporation Tax and refund the
          rest — and until this existed the only record was somebody's memory. */}
      {(mv('from_another_tax') > 0 || mv('to_another_tax') > 0 || mv('cash_to_client') > 0) && (
        <div style={{ display: 'flex', gap: 16, marginTop: 10, paddingTop: 9, borderTop: '1px solid #f1f5f9',
                      flexWrap: 'wrap', fontSize: 11.5, color: '#475569' }}>
          <span style={{ fontSize: 10, fontWeight: 700, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: 0.4 }}>
            Money that has moved
          </span>
          {mv('paid_by_client') > 0 && <span>Paid by the client <b style={{ color: '#0f172a' }}>{fmtGbpDetailed(mv('paid_by_client'))}</b></span>}
          {mv('cash_to_client') > 0 && <span>Repaid to the client <b style={{ color: '#059669' }}>{fmtGbpDetailed(mv('cash_to_client'))}</b></span>}
          {mv('from_another_tax') > 0 && <span>Credit moved in from another head <b style={{ color: '#7c3aed' }}>{fmtGbpDetailed(mv('from_another_tax'))}</b></span>}
          {mv('to_another_tax') > 0 && <span>Credit moved out to another head <b style={{ color: '#c2410c' }}>{fmtGbpDetailed(mv('to_another_tax'))}</b></span>}
        </div>
      )}
    </div>
  );
}

function HeadCard({ head, total, onOpen }) {
  const partsTotal = head.parts.reduce((s, p) => s + p.value, 0);
  const residual = Math.round((head.balance - partsTotal) * 100) / 100;

  return (
    <div style={{ ...card, borderLeft: `3px solid ${head.colour}` }}>
      <div style={{ padding: '11px 14px', borderBottom: '1px solid #f1f5f9', display: 'flex',
                    alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 14, fontWeight: 700, color: '#0f172a' }}>{head.label}</span>
        {head.known ? (
          <>
            <span style={{ fontSize: 16, fontWeight: 700, fontVariantNumeric: 'tabular-nums',
                           color: head.balance > 0 ? '#b91c1c' : head.balance < 0 ? '#059669' : '#0f172a' }}>
              {fmtGbpDetailed(head.balance)}
            </span>
            {total > 0 && head.balance > 0 && (
              <span style={{ fontSize: 11.5, color: '#94a3b8' }}>
                {Math.round((head.balance / total) * 100)}% of what they owe
              </span>
            )}
            {head.reference && <span style={{ fontSize: 11.5, color: '#94a3b8' }}>{head.reference}</span>}
            {head.flags?.map((f) => (
              <Pill key={f.label} colour={f.colour} bg={f.bg} title={f.hint} style={{ fontSize: 10 }}>{f.label}</Pill>
            ))}
          </>
        ) : (
          <span style={{ fontSize: 12.5, color: '#cbd5e1' }}>Not registered, or not scraped</span>
        )}
        <div style={{ flex: 1 }} />
        {head.known && (
          <button onClick={onOpen}
            title={`Open ${head.label} for this client — ${head.detailLabel}`}
            style={{
              background: 'none', border: 'none', padding: 0, cursor: 'pointer',
              fontFamily: font, fontSize: 11.5, fontWeight: 600, color: '#0e7fe0',
            }}>
            {head.detailLabel} →
          </button>
        )}
      </div>

      {head.known && (
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(280px, 1.1fr) minmax(260px, 1fr)', gap: 0 }}>
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
                    {fmtGbpDetailed(head.balance)}
                  </td>
                </tr>
              </tbody>
            </table>
            {head.note && (
              <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 8, lineHeight: 1.5 }}>{head.note}</div>
            )}
          </Pane>

          <Pane title="Shape of it" last>
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
        </div>
      )}
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

// ── the four heads, for one client ─────────────────────────────────
function buildHeads({ paye, proofs, ct, vat, sa, moves }) {
  const movedIn = (taxKey) => moves
    .filter((m) => m.tax === taxKey && m.movement === 'from_another_tax')
    .reduce((s, m) => s + n(m.amount), 0);
  const repaidOut = (taxKey) => moves
    .filter((m) => m.tax === taxKey && m.movement === 'cash_to_client')
    .reduce((s, m) => s + n(m.amount), 0);
  const oldest = (rows, key) => {
    const ds = rows.map((r) => r[key]).filter(Boolean).sort();
    return ds.length ? ds[0] : null;
  };

  // PAYE. HMRC's own total_debt splits exactly into the monthly bills and the
  // "additional" charges — penalties, interest and specified charges — which is
  // the split that matters: one is late payroll, the other is a fine.
  const payeBalance = sum(paye, 'total_debt');
  const notYetDue = proofs.reduce((s, p) => s + n(p.not_yet_due_at), 0);
  const tier = paye.length ? Math.min(...paye.map((s) => s.chase_tier || 4)) : null;
  const oldestDue = oldest(paye.filter((r) => n(r.total_debt) > 0), 'oldest_due_date');
  const payeHead = {
    key: 'paye',
    ...TAX_META.paye,
    known: paye.length > 0,
    balance: payeBalance,
    creditHeld: 0,
    reference: paye.length === 1 ? paye[0].paye_ref : paye.length > 1 ? `${paye.length} schemes` : null,
    detailLabel: 'Month by month',
    residualLabel: 'Not split by HMRC',
    flags: [
      ...(tier ? [{ label: TIERS[tier].short, colour: TIERS[tier].colour, bg: TIERS[tier].bg, hint: TIERS[tier].hint }] : []),
      ...(paye.some((s) => s.variable_dd) ? [{ label: 'DD', colour: '#059669', bg: '#f0fdf4', hint: 'Paying by variable direct debit' }] : []),
      ...(paye.some((s) => s.claiming_ea) ? [{ label: 'EA', colour: '#7c3aed', bg: '#faf5ff', hint: 'Employment Allowance claimed' }] : []),
    ],
    parts: [
      { label: 'Monthly PAYE bills unpaid', value: sum(paye, 'overdue_monthly'),
        hint: 'Ordinary payroll months past their 22nd' },
      { label: 'Penalties, interest and specified charges', value: sum(paye, 'overdue_additional'),
        hint: 'HMRC charges that are not a payroll month' },
    ],
    facts: [
      { label: 'Charged, not yet due', value: fmtGbpDetailed(notYetDue), colour: notYetDue > 0 ? '#0369a1' : '#94a3b8',
        hint: 'The next bill. Not part of the balance above and not debt to HMRC either — but it is a creditor in the accounts' },
      { label: 'Interest still accruing', value: fmtGbpDetailed(sum(paye, 'accruing_interest')),
        colour: sum(paye, 'accruing_interest') > 0 ? '#c2410c' : '#94a3b8',
        hint: 'Adds to the debt every day it is not settled' },
      { label: 'Overdue items', value: paye.reduce((s, r) => s + (r.overdue_items || 0), 0) },
      { label: 'Of those, penalties', value: paye.reduce((s, r) => s + (r.penalty_items || 0), 0),
        colour: paye.some((r) => r.penalty_items) ? '#b91c1c' : '#94a3b8' },
      { label: 'Oldest overdue', value: oldestDue
          ? `${shortDate(oldestDue)} · ${ageLabel(Math.max(...paye.map((r) => r.days_oldest_overdue || 0)))}`
          : '—' },
      { label: 'Repaid to the client', value: fmtGbpDetailed(repaidOut('paye')),
        colour: repaidOut('paye') > 0 ? '#059669' : '#94a3b8' },
    ],
    note: 'PAYE is HMRC\'s overdue figure, so the month just charged is not in it. For a creditor at a year '
        + 'end, use the statement — it counts the month the year end falls in.',
  };

  // Corporation Tax. Tax charged less what has been paid or moved elsewhere;
  // HMRC's own adjustments column is the residual.
  const ctBalance = sum(ct, 'total');
  const ctUnpaid = ct.filter((p) => n(p.total) > 0);
  const ctHead = {
    key: 'corporation-tax',
    ...TAX_META['corporation-tax'],
    known: ct.length > 0,
    balance: ctBalance,
    creditHeld: 0,
    reference: ct[0]?.utr || null,
    detailLabel: 'By accounting period',
    residualLabel: 'Adjustments HMRC applied',
    flags: ct.some((p) => p.unreadable)
      ? [{ label: 'Unreadable period', colour: '#b45309', bg: '#fffbeb',
           hint: 'At least one period could not be parsed — treat its figures as unknown, not zero' }]
      : [],
    parts: [
      { label: 'Tax charged, all periods', value: sum(ct, 'tax') },
      { label: 'Interest', value: sum(ct, 'interest') },
      { label: 'Penalties', value: sum(ct, 'penalties') },
      // HMRC's own columns, signed as HMRC signs them. Tax + interest +
      // penalties + paid + repayments + adjustments equals HMRC's total exactly
      // on every client we hold, so nothing here is a plug.
      { label: 'Paid', value: sum(ct, 'less_paid'),
        hint: 'Cash the client has paid against those periods' },
      { label: 'Repayments and reallocations', value: sum(ct, 'repayments_reallocations'),
        hint: 'HMRC repaying the client, or moving credit between periods and taxes. Negative where it reduced the balance, positive where it increased it' },
      { label: 'Adjustments', value: sum(ct, 'adjustments'),
        hint: 'HMRC\'s own adjustments column — small, but it is why tax less paid does not equal the total' },
    ],
    facts: [
      { label: 'Accounting periods held', value: ct.length },
      { label: 'Periods still unpaid', value: ctUnpaid.length, colour: ctUnpaid.length ? '#b91c1c' : '#059669' },
      { label: 'Oldest unpaid period', value: ctUnpaid.length ? shortDate(oldest(ctUnpaid, 'period_end')) : '—' },
      { label: 'Newest period held', value: ct.length ? shortDate(ct.map((p) => p.period_end).filter(Boolean).sort().slice(-1)[0]) : '—',
        hint: 'If this is well behind the last year end, HMRC has not yet raised the charge' },
      { label: 'Credit moved in from another head', value: fmtGbpDetailed(movedIn('corporation-tax')),
        colour: movedIn('corporation-tax') > 0 ? '#7c3aed' : '#94a3b8' },
    ],
    note: 'Charges cover every period HMRC holds, back years included — which is why the gross figures are '
        + 'large and only the net matters.',
  };

  // VAT. The split that changes what you do: a return filed and not paid is a
  // collection problem; an assessment is a filing problem, and paying it does
  // not make it go away.
  const vatBalance = sum(vat, 'amount');
  const vatAssessed = vat.filter((l) => l.estimated).reduce((s, l) => s + n(l.amount), 0);
  const vatPeriods = new Set(vat.map((l) => (l.period_from ? `${l.period_from}|${l.period_to}` : 'none')));
  const vatHead = {
    key: 'vat',
    ...TAX_META.vat,
    known: vat.length > 0,
    balance: vatBalance,
    creditHeld: 0,
    reference: vat[0]?.vrn || null,
    detailLabel: 'By VAT period',
    residualLabel: 'Unattributed',
    flags: vat.some((l) => l.estimated)
      ? [{ label: 'Assessed', colour: '#c2410c', bg: '#fff7ed',
           hint: 'HMRC has estimated at least one period because no return was filed' }]
      : [],
    parts: [
      { label: 'Returns filed and unpaid', value: Math.round((vatBalance - vatAssessed) * 100) / 100,
        hint: 'A collection problem: the figure is agreed, the money has not moved' },
      { label: 'Assessed by HMRC, no return filed', value: vatAssessed,
        hint: 'A filing problem: HMRC has estimated it. Paying the assessment does not file the return' },
    ],
    facts: [
      { label: 'Periods outstanding', value: vatPeriods.size },
      { label: 'Lines', value: vat.length },
      { label: 'Of those, overdue', value: vat.filter((l) => l.overdue).length,
        colour: vat.some((l) => l.overdue) ? '#b91c1c' : '#059669' },
      { label: 'Assessments standing', value: vat.filter((l) => l.estimated).length,
        colour: vat.some((l) => l.estimated) ? '#c2410c' : '#94a3b8' },
      { label: 'Oldest unpaid period ends', value: oldest(vat, 'period_to') ? shortDate(oldest(vat, 'period_to')) : '—' },
      { label: 'Repaid to the client', value: fmtGbpDetailed(repaidOut('vat')),
        colour: repaidOut('vat') > 0 ? '#059669' : '#94a3b8' },
    ],
  };

  // Self Assessment. The interesting number here is often not the debt: HMRC
  // may be holding more credit than is owed, which is the CIS pattern — credit
  // built up on PAYE and never asked for back.
  const p = sa[0];
  const saBalance = sum(sa, 'amount_due');
  const saCredit = sum(sa, 'available_for_repayment');
  const saHead = {
    key: 'self-assessment',
    ...TAX_META['self-assessment'],
    known: sa.length > 0,
    balance: saBalance,
    creditHeld: saCredit,
    reference: p?.utr || null,
    detailLabel: 'Statement and years',
    // HMRC's statement nets credits into the amount due without itemising them,
    // and the four components tie to it for 78 of 89 clients. The gap is real
    // and gets a line rather than being buried in one of the four.
    residualLabel: 'Credits and adjustments on HMRC\'s statement',
    flags: p?.statement_available === false
      ? [{ label: 'No statement', colour: '#b45309', bg: '#fffbeb',
           hint: 'HMRC would not show it, so a zero is unknown rather than nil' }]
      : [],
    parts: [
      { label: 'Tax', value: sum(sa, 'tax') },
      { label: 'Surcharges', value: sum(sa, 'surcharges') },
      { label: 'Interest', value: sum(sa, 'interest') },
      { label: 'Penalties', value: sum(sa, 'penalties') },
    ],
    facts: [
      { label: 'Credit HMRC is holding', value: fmtGbpDetailed(saCredit),
        colour: saCredit > 0 ? '#0369a1' : '#94a3b8',
        hint: 'Available for repayment or reallocation — never netted off the debt above' },
      { label: 'Repaid out to the client', value: fmtGbpDetailed(repaidOut('self-assessment')),
        colour: repaidOut('self-assessment') > 0 ? '#059669' : '#94a3b8' },
      { label: 'Credit moved in from another head', value: fmtGbpDetailed(movedIn('self-assessment')),
        colour: movedIn('self-assessment') > 0 ? '#7c3aed' : '#94a3b8',
        hint: 'The CIS pattern: credit built up on PAYE, moved across to settle Self Assessment' },
      { label: 'Statement as at', value: p?.as_at ? shortDate(p.as_at) : '—' },
    ],
    note: saCredit > saBalance && saCredit > 0
      ? 'HMRC is holding more credit than this client owes on Self Assessment. That is money to ask for back.'
      : null,
  };

  const byKey = { paye: payeHead, 'corporation-tax': ctHead, vat: vatHead, 'self-assessment': saHead };
  return TAX_ORDER.map((k) => byKey[k]);
}
