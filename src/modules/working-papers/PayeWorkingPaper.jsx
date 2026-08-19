import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { RefreshCw, Calendar } from 'lucide-react';
import {
  fetchHmrcTaxYears, fetchCreditOrigin, fetchPayeBalanceAt,
  fetchQboRoleBalances, fetchBrightpayPeriods, pullQboBalances,
} from './api';
import {
  font, card, th, thNum, td, tdNum, inputStyle, btnQuiet,
  money, shortDate, dateTime, Pill, VarianceCell, ErrorBar, NotFedNotice, taxYearOf,
} from './wpShared';

/*
 * Working Papers → PAYE.
 *
 * A three-way reconciliation of one client's PAYE position: HMRC's own account,
 * the client's QuickBooks ledger, and the payroll that produced both.
 *
 * TWO PANELS, TWO PERIODS, and the reason is the whole point of the paper.
 *
 *   THE CREDITOR panel is on the ACCOUNTING year end, because that is the date
 *   the accounts are drawn at. Its HMRC leg is hmrc_paye_balance_at() (sql/239),
 *   which knows that a 31 January year end accrues the tax month ending
 *   5 February — the payroll run in January is charged in tax month 6 Jan–5 Feb.
 *
 *   THE TAX YEAR panel is on 6 April – 5 April, because a CIS deduction
 *   suffered can only be set against PAYE liabilities of the SAME tax year. A
 *   December year end does not extend that; the offset capacity resets on
 *   6 April regardless, part-way through the client's own year.
 *
 * WHY CIS IS NEVER MATCHED BY MONTH. Measured on the live scrape (19 Aug 2026),
 * 20 of 36 CIS-suffered credit lines sit against a tax month that is not the
 * month their own label says they relate to, and Antonine Builders carries
 * £678.34 recorded in 2026-27 for a deduction suffered in 2022-23. HMRC records
 * the credit when it processes the EPS and labels it with the month claimed for,
 * and the two differ in both directions. Matching on the month manufactures a
 * variance on more than half the population, so the CIS analysis is annual and
 * the timing difference is shown as its own line.
 *
 * See docs/hmrc-timing-and-cis-rules.md for the rules and their authority.
 */

const LEG = {
  hmrc:      { label: 'HMRC',       colour: '#0e7fe0', bg: '#eff6ff' },
  qbo:       { label: 'QuickBooks', colour: '#15803d', bg: '#f0fdf4' },
  brightpay: { label: 'BrightPay',  colour: '#7c3aed', bg: '#f5f3ff' },
};

function LegPill({ leg }) {
  const m = LEG[leg];
  return <Pill colour={m.colour} bg={m.bg}>{m.label}</Pill>;
}

/** A three-column comparison line: the figure from each leg, then the variance. */
function ThreeWayRow({ label, hint, hmrc, qbo, brightpay, tolerance, indent = false }) {
  // The variance is HMRC against QuickBooks, because that is the pair that
  // always exists. BrightPay is shown alongside as corroboration; where it is
  // absent the row is still a real two-way reconciliation and says so.
  const variance = (hmrc != null && qbo != null) ? Number(hmrc) - Number(qbo) : null;
  return (
    <tr style={{ borderTop: '1px solid #f1f5f9' }}>
      <td style={{ ...td, paddingLeft: indent ? 28 : 12 }}>
        {label}
        {hint && <div style={{ fontSize: 11, color: '#94a3b8', lineHeight: 1.45 }}>{hint}</div>}
      </td>
      <td style={tdNum}>{money(hmrc)}</td>
      <td style={tdNum}>{money(qbo)}</td>
      <td style={tdNum}>{money(brightpay)}</td>
      <td style={tdNum}><VarianceCell value={variance} tolerance={tolerance} /></td>
    </tr>
  );
}

export default function PayeWorkingPaper({ entity }) {
  const [yearEnd, setYearEnd] = useState('');
  const [taxYears, setTaxYears] = useState([]);
  const [credits, setCredits] = useState([]);
  const [balanceAt, setBalanceAt] = useState(null);
  const [qboRoles, setQboRoles] = useState([]);
  const [bpPeriods, setBpPeriods] = useState([]);
  const [loading, setLoading] = useState(false);
  const [valuing, setValuing] = useState(false);
  const [error, setError] = useState(null);

  // Which tax year the paper's CIS analysis is on. Defaults to the tax year the
  // chosen year end falls in, which is the year whose offset the accounts need.
  const [taxYear, setTaxYear] = useState('');

  const entityId = entity?.entity_id;
  const payeRef = entity?.paye_ref;
  const realmId = entity?.realm_id;

  // The tax year the year end sits in — never derived from the calendar year,
  // because 1 April and 6 April are different years and the gap holds a month.
  const impliedTaxYear = useMemo(() => (yearEnd ? taxYearOf(yearEnd) : ''), [yearEnd]);
  useEffect(() => { if (impliedTaxYear) setTaxYear(impliedTaxYear); }, [impliedTaxYear]);

  const load = useCallback(async () => {
    if (!entityId) return;
    setLoading(true);
    setError(null);
    try {
      const [ty, cr] = await Promise.all([
        fetchHmrcTaxYears(entityId),
        fetchCreditOrigin(entityId),
      ]);
      setTaxYears(ty);
      setCredits(cr);
      if (!taxYear && ty.length) setTaxYear(ty[0].tax_year);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [entityId, taxYear]);

  useEffect(() => { load(); }, [entityId]); // eslint-disable-line react-hooks/exhaustive-deps

  // The creditor panel. Every leg is fetched for the SAME date or not at all —
  // a paper comparing HMRC at one date with the ledger at another is worse than
  // no paper, because the variance looks like an error in the books.
  useEffect(() => {
    if (!yearEnd || !payeRef) { setBalanceAt(null); return; }
    let live = true;
    fetchPayeBalanceAt(payeRef, yearEnd)
      .then((r) => { if (live) setBalanceAt(r); })
      .catch((e) => { if (live) setError(e.message); });
    return () => { live = false; };
  }, [yearEnd, payeRef]);

  useEffect(() => {
    if (!entityId || !yearEnd) { setQboRoles([]); return; }
    let live = true;
    fetchQboRoleBalances(entityId, yearEnd)
      .then((r) => { if (live) setQboRoles(r); })
      .catch((e) => { if (live) setError(e.message); });
    return () => { live = false; };
  }, [entityId, yearEnd]);

  useEffect(() => {
    if (!entityId || !taxYear) { setBpPeriods([]); return; }
    let live = true;
    fetchBrightpayPeriods(entityId, taxYear)
      .then((r) => { if (live) setBpPeriods(r); })
      .catch(() => { /* an empty leg is the expected state, not an error */ });
    return () => { live = false; };
  }, [entityId, taxYear]);

  const value = async () => {
    if (!realmId || !yearEnd) return;
    setValuing(true);
    setError(null);
    try {
      const res = await pullQboBalances(realmId, yearEnd);
      if (res.absent_from_reports?.length) {
        setError(
          `QuickBooks reported no balance at ${shortDate(yearEnd)} for account id `
          + `${res.absent_from_reports.join(', ')}. An account absent from both the general ledger and the `
          + `balance sheet is not a nil balance — check the mapping still points at an account that exists.`,
        );
      }
      if (res.report_disagreements?.length) {
        setError(
          `The general ledger and the balance sheet disagree on `
          + `${res.report_disagreements.length} mapped account(s) at ${shortDate(yearEnd)}. `
          + `The paper is using the general ledger figure; the difference needs explaining before sign-off.`,
        );
      }
      const r = await fetchQboRoleBalances(entityId, yearEnd);
      setQboRoles(r);
    } catch (e) {
      setError(e.message);
    } finally {
      setValuing(false);
    }
  };

  const roleBalance = (role) => {
    const row = qboRoles.find((r) => r.role === role);
    return row ? Number(row.balance) : null;
  };

  const year = taxYears.find((y) => y.tax_year === taxYear) || null;

  // BrightPay: sum the tax year from whatever periods are held. Null, never 0,
  // when nothing is held — see NotFedNotice.
  const bp = useMemo(() => {
    if (!bpPeriods.length) return null;
    const sum = (k) => bpPeriods.reduce((a, p) => a + Number(p[k] ?? 0), 0);
    return {
      months: bpPeriods.length,
      net_tax: sum('net_tax'),
      employee_nic: sum('employee_nic'),
      employer_nic: sum('employer_nic'),
      ea_claim: sum('ea_claim'),
      cis_suffered: bpPeriods.some((p) => p.cis_suffered != null) ? sum('cis_suffered') : null,
      cis_withheld: bpPeriods.some((p) => p.cis_withheld != null) ? sum('cis_withheld') : null,
      amount_due: sum('amount_due'),
      amount_paid: sum('amount_paid'),
      all_reconcile: bpPeriods.every((p) => p.reconciles === true),
    };
  }, [bpPeriods]);

  // The credits recorded in this tax year, grouped by where they actually came
  // from. This is the reconciling table nobody has today and every CIS client
  // needs, because it is the difference between "the books are wrong" and
  // "HMRC credited an old year in this one".
  const creditsThisYear = useMemo(
    () => credits.filter((c) => c.recorded_tax_year === taxYear),
    [credits, taxYear],
  );
  const cisTiming = useMemo(() => {
    const cis = creditsThisYear.filter((c) => c.category === 'CIS suffered');
    const g = (t) => cis.filter((c) => c.timing === t).reduce((a, c) => a + Number(c.amount), 0);
    return {
      in_period: g('in_period'),
      within_year: g('timing_within_year'),
      prior_year: g('prior_year_credit'),
      unlabelled: g('unlabelled'),
      rows: cis,
    };
  }, [creditsThisYear]);

  if (!entity) {
    return <p style={{ fontFamily: font, fontSize: 13, color: '#94a3b8' }}>Pick a client to prepare their PAYE paper.</p>;
  }

  return (
    <div style={{ fontFamily: font }}>
      <ErrorBar message={error} />

      {/* ── The paper's header: whose, at what date, on what basis ── */}
      <div style={{ ...card, padding: '12px 14px', marginBottom: 14, display: 'flex', gap: 16, alignItems: 'flex-end', flexWrap: 'wrap' }}>
        <div>
          <div style={{ fontSize: 11, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 3 }}>Client</div>
          <div style={{ fontSize: 15, fontWeight: 600, color: '#0f172a' }}>{entity.entity_name}</div>
          <div style={{ fontSize: 11.5, color: '#64748b' }}>
            PAYE ref {entity.paye_ref || '— none held'}
            {entity.qbo_company ? ` · QuickBooks: ${entity.qbo_company}` : ' · no QuickBooks file'}
          </div>
        </div>
        <div>
          <div style={{ fontSize: 11, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 3 }}>
            Accounting year end
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <Calendar size={13} style={{ color: '#94a3b8' }} />
            <input type="date" value={yearEnd} onChange={(e) => setYearEnd(e.target.value)} style={inputStyle} />
          </div>
          {yearEnd && (
            <div style={{ fontSize: 11, color: '#64748b', marginTop: 3 }}>
              Falls in tax year {impliedTaxYear}
            </div>
          )}
        </div>
        <div>
          <div style={{ fontSize: 11, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 3 }}>
            CIS / tax year
          </div>
          <select value={taxYear} onChange={(e) => setTaxYear(e.target.value)} style={inputStyle}>
            {taxYears.map((y) => <option key={y.tax_year} value={y.tax_year}>{y.tax_year}</option>)}
            {!taxYears.length && <option value="">no HMRC data</option>}
          </select>
          <div style={{ fontSize: 11, color: '#64748b', marginTop: 3 }}>6 April – 5 April</div>
        </div>
        <div style={{ flex: 1 }} />
        <button onClick={value} disabled={!realmId || !yearEnd || valuing}
          style={{ ...btnQuiet, display: 'flex', alignItems: 'center', gap: 6 }}
          title="Ask QuickBooks for the balance on the mapped nominals at the year end">
          <RefreshCw size={13} style={{ animation: valuing ? 'spin 1s linear infinite' : 'none' }} />
          {valuing ? 'Valuing…' : 'Value the ledger at this date'}
        </button>
      </div>

      {!bp && (
        <NotFedNotice
          leg="BrightPay"
          why={
            'The journal runner reads the HMRC Payments screen already but stores only the net amount due '
            + 'and the Employment Allowance, and it does not read the CIS lines or student loan at all. '
            + 'Until it writes a row per tax month into wp_brightpay_period there is no third leg.'
          }
        />
      )}

      {/* ── PANEL 1: the creditor at the accounting year end ── */}
      <h3 style={{ fontFamily: "'Playfair Display', serif", fontSize: 17, fontWeight: 500, color: '#0f172a', margin: '18px 0 4px' }}>
        PAYE creditor at {yearEnd ? shortDate(yearEnd) : 'the year end'}
      </h3>
      <p style={{ fontSize: 12, color: '#64748b', marginBottom: 10, maxWidth: 820, lineHeight: 1.55 }}>
        The balance-sheet question. A tax month belongs to the period containing its start, so this
        includes the month the year end falls in — the payroll run in the final month is charged in a tax
        month that straddles the year end and is a creditor at it.
      </p>

      {!yearEnd ? (
        <div style={{ ...card, padding: '14px 16px', color: '#94a3b8', fontSize: 12.5 }}>
          Set the accounting year end above. Nothing is shown until then: a creditor figure without a date
          is not a working paper.
        </div>
      ) : (
        <div style={card}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead><tr style={{ background: '#f8fafc' }}>
              <th style={th}>Line</th>
              <th style={thNum}><LegPill leg="hmrc" /></th>
              <th style={thNum}><LegPill leg="qbo" /></th>
              <th style={thNum}><LegPill leg="brightpay" /></th>
              <th style={thNum}>Variance</th>
            </tr></thead>
            <tbody>
              <ThreeWayRow
                label="PAYE / NIC owed at the year end"
                hint="HMRC: charges less credits less payments, months whose period starts on or before the date."
                hmrc={balanceAt?.balance_at}
                qbo={roleBalance('paye_control')}
                brightpay={null}
              />
              <ThreeWayRow
                indent
                label="of which not yet payable at the date"
                hint="Charged by the year end but not due until the 22nd of the following month. A creditor, but not overdue — and this is the part HMRC's own debt figure excludes."
                hmrc={balanceAt?.not_yet_due_at}
                qbo={null}
                brightpay={null}
              />
              <ThreeWayRow
                indent
                label="of which overdue at the date"
                hint="Comparable with HMRC's stated debt. If this is material, the accounts have an overdue PAYE creditor to disclose."
                hmrc={balanceAt?.overdue_at}
                qbo={null}
                brightpay={null}
              />
              <ThreeWayRow
                label="CIS suffered, recoverable"
                hint="Carried separately where the file does. Only offsettable against PAYE of the same tax year — see the panel below."
                hmrc={null}
                qbo={roleBalance('cis_suffered')}
                brightpay={null}
              />
              {/* No HMRC figure here on purpose. HMRC's statement never itemises
                  CIS withheld, and the only derivation available — the residual
                  on the charge — is a tax-YEAR flow, not a balance at a date.
                  Putting it in this column would compare a year's CIS against a
                  year-end creditor and invent a variance. */}
              <ThreeWayRow
                label="CIS withheld from subcontractors"
                hint="Deducted from subcontractors and owed over to HMRC with the PAYE, so it is already inside the PAYE creditor above unless this file carries it separately. HMRC gives no balance for it at a date — see the tax-year panel below."
                hmrc={null}
                qbo={roleBalance('cis_withheld')}
                brightpay={null}
              />
            </tbody>
          </table>

          {balanceAt && (
            <div style={{ padding: '10px 14px', borderTop: '1px solid #e5e7eb', background: '#f8fafc', fontSize: 11.5, color: '#64748b', lineHeight: 1.6 }}>
              <strong style={{ color: '#334155' }}>Basis.</strong>{' '}
              {balanceAt.periods_counted} tax month{balanceAt.periods_counted === 1 ? '' : 's'} counted,{' '}
              {shortDate(balanceAt.first_period_start)} to {shortDate(balanceAt.last_period_end)}, last due{' '}
              {shortDate(balanceAt.last_period_due)}. Residual treated as{' '}
              <em>{balanceAt.residual_kind === 'ties' ? 'tying without adjustment'
                : balanceAt.residual_kind === 'opening_balance' ? 'an opening balance' : 'a restatement by HMRC'}</em>.
              {balanceAt.basis === 'minimum' && (
                <>
                  {' '}<strong style={{ color: '#a16207' }}>Minimum basis:</strong> HMRC's dated payment history for
                  this scheme only reaches back to {shortDate(balanceAt.earliest_payment_held)}, so the figure at
                  a date before that is a floor, not an exact balance. Say so on the file.
                </>
              )}
              {!realmId && <> {' '}<strong style={{ color: '#c2410c' }}>No QuickBooks file is connected</strong>, so there is no ledger leg to compare.</>}
              {realmId && !qboRoles.length && <> {' '}The ledger has not been valued at this date yet — use <em>Value the ledger at this date</em>.</>}
            </div>
          )}
        </div>
      )}

      {/* ── PANEL 2: the tax year, and the CIS offset ── */}
      <h3 style={{ fontFamily: "'Playfair Display', serif", fontSize: 17, fontWeight: 500, color: '#0f172a', margin: '26px 0 4px' }}>
        Tax year {taxYear || '—'} · what was charged, and what was set against it
      </h3>
      <p style={{ fontSize: 12, color: '#64748b', marginBottom: 10, maxWidth: 820, lineHeight: 1.55 }}>
        On the tax year, not the accounting year, because that is the only period a CIS deduction suffered
        can be offset in. Anything left at 5 April is not carried into the next year — it is repayable, or
        set against corporation tax on request.
      </p>

      {!year ? (
        <div style={{ ...card, padding: '14px 16px', color: '#94a3b8', fontSize: 12.5 }}>
          {loading ? 'Loading the HMRC leg…' : 'No HMRC PAYE data held for this client in that tax year.'}
        </div>
      ) : (
        <>
          <div style={card}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead><tr style={{ background: '#f8fafc' }}>
                <th style={th}>Line</th>
                <th style={thNum}><LegPill leg="hmrc" /></th>
                <th style={thNum}><LegPill leg="brightpay" /></th>
                <th style={thNum}>Variance</th>
              </tr></thead>
              <tbody>
                {[
                  ['Income tax', year.income_tax, bp?.net_tax ?? null],
                  ["Employees' NI", year.employee_ni, bp?.employee_nic ?? null],
                  ["Employer's NI", year.employer_ni, bp?.employer_nic ?? null],
                  ['Student and postgraduate loans', year.student_loan, null],
                  ['Apprenticeship levy', year.apprenticeship_levy, null],
                  ['Interest and penalties', Number(year.interest) + Number(year.penalties), null],
                ].map(([label, h, b]) => (
                  <tr key={label} style={{ borderTop: '1px solid #f1f5f9' }}>
                    <td style={td}>{label}</td>
                    <td style={tdNum}>{money(h)}</td>
                    <td style={tdNum}>{money(b)}</td>
                    <td style={tdNum}><VarianceCell value={h != null && b != null ? Number(h) - Number(b) : null} /></td>
                  </tr>
                ))}
                <tr style={{ borderTop: '1px solid #e5e7eb', background: '#fafafa' }}>
                  <td style={td}>Itemised by HMRC</td>
                  <td style={tdNum}>{money(year.charges_itemised)}</td>
                  <td style={tdNum}>—</td>
                  <td style={tdNum} />
                </tr>
                {/* HMRC's statement never itemises CIS withheld — checked across
                    the whole line table, every CIS line is an EPS credit. So the
                    residual between the month's charge and the itemised lines IS
                    the CIS withheld for a contractor. It is a named line, not a
                    variance: Antonine Builders 2024-25 is £390,468 of it against
                    £12,293 of payroll, and calling that an error would condemn a
                    perfectly good record. */}
                <tr style={{ borderTop: '1px solid #f1f5f9' }}>
                  <td style={td}>
                    Not itemised — CIS withheld from subcontractors
                    <div style={{ fontSize: 11, color: '#94a3b8', lineHeight: 1.45 }}>
                      {year.charges_unitemised == null
                        ? `Cannot be derived: HMRC line detail covers ${year.months_with_detail} of the `
                          + `${year.months_present} months held, so this residual would contain a scrape gap.`
                        : 'HMRC does not break CIS withheld out of the monthly charge, so this is the charge '
                          + 'less everything it does itemise. For a client with no CIS it should be nil — and '
                          + 'if it is not, that is worth investigating.'}
                    </div>
                  </td>
                  <td style={tdNum}>{money(year.charges_unitemised)}</td>
                  <td style={tdNum}>{money(bp?.cis_withheld ?? null)}</td>
                  <td style={tdNum}>
                    <VarianceCell value={year.charges_unitemised != null && bp?.cis_withheld != null
                      ? Number(year.charges_unitemised) - Number(bp.cis_withheld) : null} />
                  </td>
                </tr>
                <tr style={{ borderTop: '2px solid #e5e7eb', background: '#f8fafc', fontWeight: 600 }}>
                  <td style={td}>Charged for the year</td>
                  <td style={tdNum}>{money(year.charges_total)}</td>
                  <td style={tdNum}>—</td>
                  <td style={tdNum} />
                </tr>
                <tr style={{ borderTop: '1px solid #f1f5f9' }}>
                  <td style={td}>Employment Allowance claimed</td>
                  <td style={tdNum}>({money(year.employment_allowance)})</td>
                  <td style={tdNum}>{bp ? `(${money(bp.ea_claim)})` : '—'}</td>
                  <td style={tdNum}>
                    <VarianceCell value={bp ? Number(year.employment_allowance) - Number(bp.ea_claim) : null} />
                  </td>
                </tr>
                <tr style={{ borderTop: '1px solid #f1f5f9' }}>
                  <td style={td}>Statutory payments recovered</td>
                  <td style={tdNum}>({money(year.statutory_recovered)})</td>
                  <td style={tdNum}>—</td>
                  <td style={tdNum} />
                </tr>
                <tr style={{ borderTop: '1px solid #f1f5f9' }}>
                  <td style={td}>
                    CIS suffered, credited by HMRC in this year
                    <div style={{ fontSize: 11, color: '#94a3b8' }}>
                      Every CIS credit HMRC recorded in {taxYear}, whichever year it relates to. Analysed below.
                    </div>
                  </td>
                  <td style={tdNum}>({money(year.cis_suffered)})</td>
                  <td style={tdNum}>{bp?.cis_suffered != null ? `(${money(bp.cis_suffered)})` : '—'}</td>
                  <td style={tdNum} />
                </tr>
                <tr style={{ borderTop: '2px solid #e5e7eb', background: '#f8fafc', fontWeight: 600 }}>
                  <td style={td}>Net liability for the year</td>
                  <td style={tdNum}>{money(Number(year.charges_total) - Number(year.credits_total))}</td>
                  <td style={tdNum}>{bp ? money(bp.amount_due) : '—'}</td>
                  <td style={tdNum}>
                    <VarianceCell value={bp
                      ? (Number(year.charges_total) - Number(year.credits_total)) - Number(bp.amount_due)
                      : null} />
                  </td>
                </tr>
                <tr style={{ borderTop: '1px solid #f1f5f9' }}>
                  <td style={td}>Paid to HMRC</td>
                  <td style={tdNum}>({money(year.payments_total)})</td>
                  <td style={tdNum}>{bp ? `(${money(bp.amount_paid)})` : '—'}</td>
                  <td style={tdNum}>
                    <VarianceCell value={bp ? Number(year.payments_total) - Number(bp.amount_paid) : null} />
                  </td>
                </tr>
                <tr style={{ borderTop: '2px solid #0f172a', background: '#f1f5f9', fontWeight: 700 }}>
                  <td style={td}>Outstanding on the year per HMRC</td>
                  <td style={tdNum}>{money(year.balance_per_hmrc)}</td>
                  <td style={tdNum}>—</td>
                  <td style={tdNum} />
                </tr>
              </tbody>
            </table>
            <div style={{ padding: '9px 14px', borderTop: '1px solid #e5e7eb', background: '#f8fafc', fontSize: 11.5, color: '#64748b' }}>
              {year.months_present} of 12 tax months held
              {!year.all_months_reconcile && (
                <> · <strong style={{ color: '#a16207' }}>at least one month's detail does not reconcile in HMRC's own statement</strong></>
              )}
              {bp && <> · BrightPay: {bp.months} period{bp.months === 1 ? '' : 's'} held{!bp.all_reconcile && ', not all self-checked'}</>}
            </div>
          </div>

          {/* ── The CIS timing analysis ── */}
          {(cisTiming.rows.length > 0 || Number(year.cis_suffered) !== 0) && (
            <>
              <h4 style={{ fontSize: 14, fontWeight: 600, color: '#0f172a', margin: '20px 0 4px' }}>
                CIS suffered credited in {taxYear} — where it came from
              </h4>
              <p style={{ fontSize: 12, color: '#64748b', marginBottom: 10, maxWidth: 820, lineHeight: 1.55 }}>
                HMRC records a CIS credit in the month it processes the EPS and labels it with the month
                claimed for. The two differ in both directions, so this is the reconciling table between
                "what HMRC credited this year" and "what this year's payroll actually suffered". A prior-year
                line has no counterpart in this year's payroll and must not be chased as a variance.
              </p>
              <div style={card}>
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <thead><tr style={{ background: '#f8fafc' }}>
                    <th style={th}>Origin</th>
                    <th style={thNum}>Amount</th>
                    <th style={th}>What it means for this paper</th>
                  </tr></thead>
                  <tbody>
                    <tr style={{ borderTop: '1px solid #f1f5f9' }}>
                      <td style={td}>Claimed for, and credited in, the same tax month</td>
                      <td style={tdNum}>{money(cisTiming.in_period)}</td>
                      <td style={{ ...td, color: '#64748b', fontSize: 12 }}>
                        Agrees month for month. Nothing to explain.
                      </td>
                    </tr>
                    <tr style={{ borderTop: '1px solid #f1f5f9' }}>
                      <td style={td}>Credited in a different month of the same tax year</td>
                      <td style={tdNum}>{money(cisTiming.within_year)}</td>
                      <td style={{ ...td, color: '#64748b', fontSize: 12 }}>
                        A timing difference only. Still offsettable — same tax year — so it changes when
                        the liability fell, not how much of it there was.
                      </td>
                    </tr>
                    <tr style={{ borderTop: '1px solid #f1f5f9', background: Number(cisTiming.prior_year) ? '#fefce8' : undefined }}>
                      <td style={td}>Relates to an <strong>earlier tax year</strong></td>
                      <td style={tdNum}>{money(cisTiming.prior_year)}</td>
                      <td style={{ ...td, color: '#a16207', fontSize: 12 }}>
                        Reduces this year's HMRC bill but arose in an earlier year, so it has no counterpart
                        in this year's payroll. Expect a variance of exactly this amount against BrightPay,
                        and check the earlier year's paper was not left showing a recoverable that has now
                        been given.
                      </td>
                    </tr>
                    <tr style={{ borderTop: '1px solid #f1f5f9' }}>
                      <td style={td}>Label carries no period</td>
                      <td style={tdNum}>{money(cisTiming.unlabelled)}</td>
                      <td style={{ ...td, color: '#64748b', fontSize: 12 }}>
                        HMRC gave no month. Agree it to the EPS by hand before signing off.
                      </td>
                    </tr>
                    <tr style={{ borderTop: '2px solid #e5e7eb', background: '#f8fafc', fontWeight: 600 }}>
                      <td style={td}>Total credited in {taxYear}</td>
                      <td style={tdNum}>{money(year.cis_suffered)}</td>
                      <td style={td} />
                    </tr>
                    <tr style={{ borderTop: '1px solid #f1f5f9' }}>
                      <td style={td}>
                        of which arose in {taxYear}
                        <div style={{ fontSize: 11, color: '#94a3b8' }}>
                          The figure to agree to this year's payroll and to the CIS suffered nominal.
                        </div>
                      </td>
                      <td style={tdNum}>{money(year.cis_suffered_in_year)}</td>
                      <td style={td} />
                    </tr>
                  </tbody>
                </table>
              </div>

              {cisTiming.rows.length > 0 && (
                <details style={{ marginTop: 10 }}>
                  <summary style={{ cursor: 'pointer', fontSize: 12.5, color: '#0e7fe0', fontFamily: font }}>
                    Every CIS credit line behind those totals ({cisTiming.rows.length})
                  </summary>
                  <div style={{ ...card, marginTop: 8 }}>
                    <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                      <thead><tr style={{ background: '#f8fafc' }}>
                        <th style={th}>Recorded</th>
                        <th style={th}>Relates to</th>
                        <th style={thNum}>Months late</th>
                        <th style={thNum}>Amount</th>
                        <th style={th}>HMRC's own wording</th>
                      </tr></thead>
                      <tbody>
                        {cisTiming.rows.map((c, i) => (
                          <tr key={`${c.line_type}-${i}`} style={{ borderTop: '1px solid #f1f5f9' }}>
                            <td style={td}>{c.recorded_tax_year} m{c.recorded_tax_month}</td>
                            <td style={td}>
                              {c.relates_tax_year
                                ? `${c.relates_tax_year} m${c.relates_tax_month}`
                                : <span style={{ color: '#94a3b8' }}>not stated</span>}
                              {c.timing === 'prior_year_credit' && (
                                <> <Pill colour="#a16207" bg="#fefce8">prior year</Pill></>
                              )}
                            </td>
                            <td style={tdNum}>{c.months_late ?? '—'}</td>
                            <td style={tdNum}>{money(c.amount)}</td>
                            <td style={{ ...td, fontSize: 11.5, color: '#64748b' }}>{c.line_type}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </details>
              )}
            </>
          )}
        </>
      )}
    </div>
  );
}
