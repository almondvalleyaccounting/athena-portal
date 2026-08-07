// Cash engine — practice cash forecast + safe-drawings.
//
// Model (event-based, then bucketed to 13 weeks and 12 months):
//   IN   contracted fees   gross (net × 1.2), monthly on the 15th (DD spread proxy)
//   IN   other income      gross, invoiced mid-month, received debtor_days later
//   OUT  net pay           month end          = gross payroll × (1 − paye_pct)
//   OUT  PAYE/NI           22nd of month + 1  = gross payroll × paye_pct
//   OUT  overheads         monthly on the 15th, gross of VAT on the VATable share
//   OUT  dividends/other owner comp  month end
//   OUT  VAT               7th of Feb/May/Aug/Nov (quarters Mar/Jun/Sep/Dec + 1m7d);
//                          first payment = BS VAT provision + accrual to that quarter end,
//                          then a full quarter of net VAT each time
//   OUT  CT                prior-year balance (from BS) at last YE + 9 months + 1 day;
//                          in-year accrual tracked as a provision, paid at the following date
//
// Safe-drawings (Bobby's rule, 2026-08-07): ring-fence VAT and CT provisions
// right up to the report date, then keep cash_floor_months × monthly payroll.
// Headline = the MINIMUM headroom across the horizon, so a draw today can't
// breach the floor when the VAT quarter lands.

const DAY = 24 * 36e5;

// UK corporation tax with marginal relief (FY2023+ rates).
export function ctOnAnnualProfit(p) {
  if (p <= 0) return 0;
  if (p <= 50000) return p * 0.19;
  if (p >= 250000) return p * 0.25;
  return p * 0.25 - (250000 - p) * (3 / 200);
}

// Classify a plan_bs_cache snapshot into the buckets the model needs.
// Anything liability-ish that doesn't match a pattern is surfaced, not hidden.
export function classifyBalanceSheet(rows) {
  const out = {
    cash: 0, clientMonies: 0, debtors: 0, vat: 0, paye: 0, ct: 0, directorsLoan: 0,
    cashAccounts: [], clientMoneyAccounts: [], provisionAccounts: [], unclassified: [],
    snapshotDate: rows[0]?.snapshot_date || null,
  };
  for (const r of rows || []) {
    const name = String(r.account_name || '');
    const section = String(r.section || '');
    const amount = Number(r.amount) || 0;
    if (/bank/i.test(section)) {
      // Client-money accounts are NOT the firm's cash — they hold client
      // tax monies in transit (the same trap that poisons Sales by
      // Customer). Track them separately, never in the drawable balance.
      if (/client/i.test(name)) {
        out.clientMonies += amount;
        out.clientMoneyAccounts.push({ name, amount });
      } else {
        out.cash += amount;
        out.cashAccounts.push({ name, amount });
      }
    } else if (/^AR$|receivable/i.test(section)) {
      out.debtors += amount;
    } else if (/liab|credit ?card|^AP$/i.test(section)) {
      if (/vat/i.test(name)) { out.vat += amount; out.provisionAccounts.push({ name, amount, kind: 'VAT' }); }
      else if (/paye|payroll|pension|nest|net pay|wages/i.test(name)) { out.paye += amount; out.provisionAccounts.push({ name, amount, kind: 'PAYE' }); }
      else if (/corporation tax/i.test(name)) { out.ct += amount; out.provisionAccounts.push({ name, amount, kind: 'CT' }); }
      else if (/director/i.test(name)) { out.directorsLoan += amount; }
      else out.unclassified.push({ name, section, amount });
    }
  }
  return out;
}

function lastDayOfMonth(y, m) { return new Date(y, m + 1, 0); }

export function buildCashForecast({
  scenario,
  contractedNetMonthly = 0,
  otherNetMonthly = 0,
  grossPayrollMonthly = 0,       // fully loaded: staff + owner salary incl. on-costs
  dividendsMonthly = 0,
  overheadNetMonthly = 0,
  bs = { cash: 0, vat: 0, ct: 0, paye: 0, snapshotDate: null },
}) {
  const debtorDays = Number(scenario?.cash_debtor_days ?? 30);
  const floorMonths = Number(scenario?.cash_floor_months ?? 6);
  const payePct = Number(scenario?.cash_paye_pct ?? 30) / 100;
  const vatablePct = Number(scenario?.cash_overhead_vatable_pct ?? 70) / 100;
  const yeMonth = Number(scenario?.fiscal_year_end_month ?? 9); // 1-12; September per Bobby 2026-08-07

  const today = new Date(); today.setHours(0, 0, 0, 0);
  const horizonDays = 370;
  const end = new Date(today.getTime() + horizonDays * DAY);

  const contractedGross = contractedNetMonthly * 1.2;
  const otherGross = otherNetMonthly * 1.2;
  const overheadGross = overheadNetMonthly * (1 + 0.2 * vatablePct);
  const netPay = grossPayrollMonthly * (1 - payePct);
  const payeAmt = grossPayrollMonthly * payePct;
  const monthlyNetVat = Math.max(0,
    0.2 * (contractedNetMonthly + otherNetMonthly) - 0.2 * overheadNetMonthly * vatablePct);

  const events = []; // { date: Date, amount: +in/-out, label, kind }
  const pushEvent = (date, amount, label, kind) => {
    if (date >= today && date <= end && Math.abs(amount) >= 0.005) events.push({ date, amount, label, kind });
  };

  // Monthly flows for the next 13 months (events beyond 12 months keep the
  // last week-bucket honest).
  for (let i = 0; i < 13; i++) {
    const y = today.getFullYear();
    const m = today.getMonth() + i;
    const d15 = new Date(y, m, 15);
    const dEnd = lastDayOfMonth(y, m);
    const d22next = new Date(y, m + 1, 22);
    pushEvent(d15, contractedGross, 'Contracted fees (DD, gross)', 'in');
    pushEvent(new Date(d15.getTime() + debtorDays * DAY), otherGross, `Other fees (+${debtorDays}d debtors, gross)`, 'in');
    pushEvent(d15, -overheadGross, 'Overheads (gross)', 'out');
    pushEvent(dEnd, -netPay, 'Net pay', 'out');
    pushEvent(d22next, -payeAmt, 'PAYE/NI', 'out');
    pushEvent(dEnd, -dividendsMonthly, 'Owner drawings (dividends etc.)', 'out');
  }

  // VAT quarters: Mar/Jun/Sep/Dec ends, paid 1 month + 7 days later.
  // The FIRST payment settles the BS provision + accrual up to its quarter
  // end; later payments are a full quarter of net VAT.
  const vatQuarterEnds = [];
  for (let i = -1; i < 14; i++) {
    const d = lastDayOfMonth(today.getFullYear(), today.getMonth() + i);
    if ((d.getMonth() + 1) % 3 === 0) vatQuarterEnds.push(d);
  }
  let firstVatHandled = false;
  for (const qe of vatQuarterEnds) {
    const payDate = new Date(qe.getFullYear(), qe.getMonth() + 1, 7);
    payDate.setMonth(payDate.getMonth() + 1);
    if (payDate < today) continue;
    let amount;
    if (!firstVatHandled) {
      const monthsToQe = Math.max(0, (qe.getFullYear() - today.getFullYear()) * 12 + (qe.getMonth() - today.getMonth()));
      amount = Math.max(0, (Number(bs.vat) || 0) + monthlyNetVat * monthsToQe);
      firstVatHandled = true;
    } else {
      amount = monthlyNetVat * 3;
    }
    pushEvent(payDate, -amount, `VAT (quarter to ${qe.toLocaleDateString('en-GB', { month: 'short', year: 'numeric' })})`, 'vat');
  }

  // CT: prior-year balance from the BS pays at last YE + 9 months + 1 day.
  const lastYe = new Date(today.getFullYear(), yeMonth, 0); // last day of YE month this year
  if (lastYe > today) lastYe.setFullYear(lastYe.getFullYear() - 1);
  const ctPayDate = new Date(lastYe.getFullYear(), lastYe.getMonth() + 10, 1); // +9m1d
  const priorCt = Math.max(0, Number(bs.ct) || 0);
  if (priorCt > 0) pushEvent(ctPayDate, -priorCt, `CT (year to ${lastYe.toLocaleDateString('en-GB', { month: 'short', year: 'numeric' })})`, 'ct');

  // In-year CT accrues as a provision (paid beyond most horizons).
  const monthlyProfit = Math.max(0, contractedNetMonthly + otherNetMonthly - grossPayrollMonthly - overheadNetMonthly);
  const annualProfit = monthlyProfit * 12;
  const effCtRate = annualProfit > 0 ? ctOnAnnualProfit(annualProfit) / annualProfit : 0;
  const monthlyCtAccrual = monthlyProfit * effCtRate;
  const monthsSinceYe = (today.getFullYear() - lastYe.getFullYear()) * 12 + (today.getMonth() - lastYe.getMonth());
  const inYearCtProvisionNow = monthlyCtAccrual * Math.max(0, monthsSinceYe);

  events.sort((a, b) => a.date - b.date);

  // Walk the timeline tracking balance + unpaid provisions.
  const floor = floorMonths * grossPayrollMonthly;
  let balance = Number(bs.cash) || 0;
  let vatProv = Math.max(0, Number(bs.vat) || 0);
  let ctProv = priorCt + inYearCtProvisionNow;
  let headroomMin = balance - vatProv - ctProv - floor;
  let headroomMinDate = today;

  const daily = []; // sampled at each event for charts/buckets
  let cursor = new Date(today);
  const monthKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  const monthAgg = new Map(); // key -> {in, out, vat, ct, closing, headroom}
  const ensureMonth = (d) => {
    const k = monthKey(d);
    if (!monthAgg.has(k)) monthAgg.set(k, { key: k, in: 0, out: 0, closing: balance, headroom: 0 });
    return monthAgg.get(k);
  };
  ensureMonth(today);

  for (const ev of events) {
    // Accrue provisions linearly between cursor and event date.
    const days = Math.max(0, (ev.date - cursor) / DAY);
    vatProv += (monthlyNetVat / 30.44) * days;
    ctProv += (monthlyCtAccrual / 30.44) * days;
    cursor = ev.date;

    balance += ev.amount;
    if (ev.kind === 'vat') vatProv = Math.max(0, vatProv + ev.amount);        // payment reduces provision
    if (ev.kind === 'ct') ctProv = Math.max(0, ctProv + ev.amount);

    const m = ensureMonth(ev.date);
    if (ev.amount >= 0) m.in += ev.amount; else m.out += -ev.amount;
    m.closing = balance;
    m.headroom = balance - vatProv - ctProv - floor;

    const headroom = balance - vatProv - ctProv - floor;
    if (headroom < headroomMin) { headroomMin = headroom; headroomMinDate = ev.date; }
    daily.push({ date: new Date(ev.date), balance, vatProv, ctProv, headroom, label: ev.label, amount: ev.amount });
  }

  // Weekly buckets for the 13-week view.
  const weeks = [];
  for (let w = 0; w < 13; w++) {
    const start = new Date(today.getTime() + w * 7 * DAY);
    const endW = new Date(start.getTime() + 7 * DAY);
    const inWeek = daily.filter((d) => d.date >= start && d.date < endW);
    const last = inWeek[inWeek.length - 1];
    const prevBalance = weeks[w - 1]?.closing ?? (Number(bs.cash) || 0);
    weeks.push({
      index: w,
      start,
      in: inWeek.filter((d) => d.amount > 0).reduce((s, d) => s + d.amount, 0),
      out: inWeek.filter((d) => d.amount < 0).reduce((s, d) => s - d.amount, 0),
      closing: last ? last.balance : prevBalance,
      headroom: last ? last.headroom : (weeks[w - 1]?.headroom ?? headroomMin),
      events: inWeek,
    });
  }

  const months = [...monthAgg.values()].slice(0, 12);

  const provisionsNow = { vat: Math.max(0, Number(bs.vat) || 0), ct: priorCt + inYearCtProvisionNow };
  const safeDrawNow = (Number(bs.cash) || 0) - provisionsNow.vat - provisionsNow.ct - floor;
  const safeDraw = Math.min(safeDrawNow, headroomMin);

  return {
    assumptions: { debtorDays, floorMonths, payePct, vatablePct, yeMonth, monthlyNetVat, monthlyCtAccrual, effCtRate },
    provisionsNow,
    floor,
    cashNow: Number(bs.cash) || 0,
    safeDrawNow,
    safeDraw,
    headroomMin,
    headroomMinDate,
    weeks,
    months,
    events: daily,
    ctPayDate,
    priorCt,
  };
}
