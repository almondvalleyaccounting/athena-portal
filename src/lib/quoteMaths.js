// The quote form's arithmetic, out of the React hook so it can be tested.
// hooks/useQuoteForm.js holds the state and calls computeQuote() with it on
// every render; everything here is inputs → figures, no state and no I/O.
//
// This is a straight move of the hook's maths, not a rewrite: a figure that
// comes out differently here is a bug in the move. Where other screens price
// the same service differently (GroupQuoteInputPage, quotePdf, the portal's
// catalogue), those differences are still open questions — see
// tests/money/quoteMaths.test.js before "fixing" one.

const r2 = (n) => Math.round(n * 100) / 100;

// Net monthly fee from the annual total, then VAT on the rounded net, then
// gross on the two rounded figures — the order the quote has always used, so
// net + VAT = gross to the penny on the letter.
export function monthlyFromAnnual(annualTotal) {
  const monthlyNet = r2(annualTotal / 12);
  const monthlyVat = r2(monthlyNet * 0.2);
  const monthlyGross = r2(monthlyNet + monthlyVat);
  return { monthlyNet, monthlyVat, monthlyGross };
}

// The flat monthly payroll fee: BrightPay's annual cost per payroll client,
// marked up, rounded up to the pound.
export function payrollFlat(D) {
  return Math.ceil(
    (D.payroll.brightpay_annual / D.payroll.payroll_client_count) * (1 + D.payroll.markup_pct / 100)
  );
}

// One director's personal tax return, at the given add-on rates.
export function directorTotal(d, addonRates) {
  return d.base +
    (d.otherDividends ? addonRates.other_dividends : 0) +
    (d.hasRentals ? d.rentalProperties * addonRates.rental_property : 0) +
    (d.capitalGains ? addonRates.capital_gains : 0) +
    (d.savingsIncome ? addonRates.savings_income : 0) +
    (d.otherSources || []).reduce((s, o) => s + (o.amount || 0), 0);
}

export function detectBand(D, turnoverNum) {
  return D.accounts_bands.find(
    (b) => turnoverNum >= b.min && turnoverNum <= (b.max === Infinity ? 999999999 : b.max)
  );
}

// q: the quote form's state, by the hook's own names. D: quote_defaults.
export function computeQuote(q, D) {
  const setupTotal =
    (q.suFormation ? q.suFormationQty * q.suFormationRate : 0) +
    (q.suHmrc ? q.suHmrcQty * q.suHmrcRate : 0) +
    q.suRegFee +
    q.suOthers.reduce((s, o) => s + (o.amount || 0), 0);

  const turnoverNum = parseFloat(q.turnover) || 0;
  const detectedBand = detectBand(D, turnoverNum);

  const accAnnual =
    q.accType === 'dormant' ? q.accDormant
    : q.accType === 'property' ? q.accPropBase + Math.max(0, q.accProperties - 1) * q.accPropExtra
    : q.accRate;
  const staAnnual = q.staFee;
  const dtrAnnual = q.directors.reduce((s, d) => s + directorTotal(d, q.addonRates), 0);
  const bkAnnual = q.bkHours * q.bkRate * 12 + (q.bkIncVat ? q.bkVatAdj : 0);
  const vatAnnual = q.vatFreq * q.vatRate;
  const mtdAnnual = q.mtdFreq * q.mtdRate;
  const prMoCalc = q.prFlat + q.prMonthlyEe * q.prMonthlyEeRate + q.prWeeklyEe * q.prWeeklyEeRate * 4.33 + q.prCis * q.prCisRate * 4.33;
  const prAnnual = prMoCalc * 12 + q.prP11d * q.prP11dRate;
  const modMonthly = q.modSwPrice + q.modPayments * q.modPaymentRate + q.modRuns * q.modRunRate;
  const modAnnual = modMonthly * 12;
  const maAnnual = q.maSets * q.maRate;
  const rmAnnual = q.rmCount * q.rmRate;
  const budAnnual = (q.budBasic ? q.budBasicRate : 0) + (q.budAdvanced ? q.budAdvancedRate : 0) + q.budReforecastQty * q.budReforecastRate;
  const cfoAnnual = q.cfoDays * q.cfoDayRate;

  const sw = D.software.find((s) => s.id === q.swId) || D.software[0];
  const swMonthly = (sw?.monthly || 0) + (q.dextEnabled ? q.dextPrice : 0);
  const swAnnual = swMonthly * 12;

  const lines = [];
  if (q.accEnabled) lines.push({ id: 'accounts_ct', name: 'Accounts & CT', annual: accAnnual });
  if (q.staEnabled) lines.push({ id: 'sole_trader_accounts', name: 'Sole Trader Accounts', annual: staAnnual });
  if (q.csEnabled) lines.push({ id: 'confirmation_statement', name: 'Confirmation Statement', annual: q.csFee });
  if (q.dtrEnabled) lines.push({ id: 'directors_tax_return', name: `Directors' Tax Returns`, annual: dtrAnnual });
  if (q.bkEnabled) lines.push({ id: q.bkIncVat ? 'bookkeeping_vat' : 'bookkeeping', name: q.bkIncVat ? 'Bookkeeping & VAT Returns' : 'Bookkeeping', annual: bkAnnual });
  if (q.vatEnabled) lines.push({ id: 'vat_returns', name: 'VAT Returns', annual: vatAnnual });
  if (q.mtdEnabled) lines.push({ id: 'mtd_returns', name: 'MTD Returns', annual: mtdAnnual });
  if (q.prEnabled) lines.push({ id: 'payroll', name: 'Payroll', annual: prAnnual });
  if (q.aeEnabled) lines.push({ id: 'auto_enrolment', name: 'Auto-Enrolment', annual: q.aeFee });
  if (q.modEnabled) lines.push({ id: 'modulr', name: 'Modulr Wage Payments', annual: modAnnual });
  if (q.maEnabled) lines.push({ id: 'management_accounts', name: 'Management Accounts', annual: maAnnual });
  if (q.rmEnabled) lines.push({ id: 'review_meetings', name: 'Review Meetings', annual: rmAnnual });
  if (q.budEnabled) lines.push({ id: 'budgeting', name: 'Budgeting & Forecasting', annual: budAnnual });
  if (q.cfoEnabled) lines.push({ id: 'fractional_cfo', name: 'Fractional CFO', annual: cfoAnnual });
  if (q.roEnabled) lines.push({ id: 'registered_office', name: 'Registered Office', annual: q.roFee });

  // Below-standard pricing: for each enabled service, the standard is the
  // defaults' rate × the same quantities; flag where the quote is more than
  // 50p under it. Driver-based services (payroll, modulr, budgeting, CFO,
  // software) are excluded — their "standard" isn't a single rate, so
  // flagging would be noisy.
  const belowStandard = [];
  const flagBelow = (id, name, actual, standard) => {
    if (standard > 0 && actual < standard - 0.5) belowStandard.push({ id, name, actual, standard });
  };
  if (q.accEnabled && q.accType === 'trading' && detectedBand) flagBelow('accounts_ct', 'Accounts & CT', accAnnual, detectedBand.rate);
  if (q.csEnabled) flagBelow('confirmation_statement', 'Confirmation Statement', q.csFee, D.confirmation_statement.fee);
  if (q.dtrEnabled) {
    const stdDtr = q.directors.reduce((s, d) => s + directorTotal({ ...d, base: D.director_base }, D.director_addons), 0);
    flagBelow('directors_tax_return', "Directors' Tax Returns", dtrAnnual, stdDtr);
  }
  if (q.bkEnabled) flagBelow('bookkeeping_vat', 'Bookkeeping & VAT', bkAnnual, q.bkHours * D.bookkeeping_rate * 12 + (q.bkIncVat ? q.bkVatAdj : 0));
  if (q.vatEnabled) flagBelow('vat_returns', 'VAT Returns', vatAnnual, q.vatFreq * D.vat_per_return);
  if (q.staEnabled) flagBelow('sole_trader_accounts', 'Sole Trader Accounts', staAnnual, D.sole_trader_accounts ?? 450);
  if (q.mtdEnabled) flagBelow('mtd_returns', 'MTD Returns', mtdAnnual, q.mtdFreq * (D.mtd_returns?.per_return ?? 35));
  if (q.aeEnabled) flagBelow('auto_enrolment', 'Auto-Enrolment', q.aeFee, D.auto_enrolment.standard);
  if (q.roEnabled) flagBelow('registered_office', 'Registered Office', q.roFee, D.registered_office);
  if (q.rmEnabled) flagBelow('review_meetings', 'Review Meetings', rmAnnual, q.rmCount * (D.review_meeting_rate || 210));
  if (q.maEnabled) flagBelow('management_accounts', 'Management Accounts', maAnnual, q.maSets * (D.management_accounts_per_set || 158));

  const annualServices = lines.reduce((s, l) => s + l.annual, 0);
  const annualTotal = annualServices + swAnnual;

  return {
    setupTotal, turnoverNum, detectedBand,
    accAnnual, staAnnual, dtrAnnual, bkAnnual, vatAnnual, mtdAnnual,
    prMoCalc, prAnnual, modMonthly, modAnnual, maAnnual, rmAnnual, budAnnual, cfoAnnual,
    sw, swMonthly, swAnnual,
    lines, belowStandard, annualServices, annualTotal,
    ...monthlyFromAnnual(annualTotal),
  };
}

// The quote's recurring and one-off line items, as saved to quote_line_items.
export function lineItemsFor(qid, { lines, sw, dextEnabled, dextPrice }, setupLines) {
  const items = lines.map((l, i) => ({
    quote_id: qid, service_id: l.id, description: l.name,
    annual_amount: r2(l.annual),
    monthly_amount: r2(l.annual / 12),
    detail: l.detail || '', is_recurring: true, sort_order: i,
  }));
  if (sw?.id !== 'none' && sw?.monthly > 0) {
    items.push({ quote_id: qid, service_id: 'software_accounting', description: sw.name, annual_amount: sw.monthly * 12, monthly_amount: sw.monthly, detail: '', is_recurring: true, sort_order: items.length });
  }
  if (dextEnabled) {
    items.push({ quote_id: qid, service_id: 'software_dext', description: 'Dext', annual_amount: dextPrice * 12, monthly_amount: dextPrice, detail: '', is_recurring: true, sort_order: items.length });
  }
  setupLines.forEach((sl, i) => {
    items.push({ quote_id: qid, service_id: `setup_${sl.type}`, description: sl.description, annual_amount: sl.amount, monthly_amount: 0, detail: '', is_recurring: false, sort_order: 100 + i });
  });
  return items;
}
