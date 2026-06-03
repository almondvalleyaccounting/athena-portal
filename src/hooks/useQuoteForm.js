import { useState, useEffect } from 'react';
import { fmt } from '../components/ui';

export default function useQuoteForm(D) {
  // ── Client ──
  const [client, setClient] = useState({
    name: '', companyNumber: '', entityType: 'limited_company', turnover: '',
  });

  // ── Valid Until ──
  const defaultValidUntil = () => {
    const d = new Date();
    d.setDate(d.getDate() + 30);
    return d.toISOString().slice(0, 10);
  };
  const [validUntil, setValidUntil] = useState(defaultValidUntil());

  // ── Setup fees ──
  const [suFormation, setSuFormation] = useState(false);
  const [suFormationQty, setSuFormationQty] = useState(1);
  const [suFormationRate, setSuFormationRate] = useState(D.setup.formation_rate);
  const [suHmrc, setSuHmrc] = useState(false);
  const [suHmrcQty, setSuHmrcQty] = useState(1);
  const [suHmrcRate, setSuHmrcRate] = useState(D.setup.hmrc_reg_rate);
  const [suRegFee, setSuRegFee] = useState(0);
  const [suOthers, setSuOthers] = useState([]);
  const setupTotal =
    (suFormation ? suFormationQty * suFormationRate : 0) +
    (suHmrc ? suHmrcQty * suHmrcRate : 0) +
    suRegFee +
    suOthers.reduce((s, o) => s + (o.amount || 0), 0);

  // ── Accounts & CT ──
  const [accEnabled, setAccEnabled] = useState(true);
  const [accType, setAccType] = useState('trading');
  const [accRate, setAccRate] = useState(900);
  const [accProperties, setAccProperties] = useState(1);
  const [accPropBase, setAccPropBase] = useState(D.property_base);
  const [accPropExtra, setAccPropExtra] = useState(D.property_per_extra);
  const [accDormant, setAccDormant] = useState(D.dormant_rate);

  const turnoverNum = parseFloat(client.turnover) || 0;
  const detectedBand = D.accounts_bands.find(
    (b) => turnoverNum >= b.min && turnoverNum <= (b.max === Infinity ? 999999999 : b.max)
  );
  useEffect(() => {
    if (accType === 'trading' && detectedBand) setAccRate(detectedBand.rate);
  }, [turnoverNum, accType]);

  const accAnnual =
    accType === 'dormant' ? accDormant
    : accType === 'property' ? accPropBase + Math.max(0, accProperties - 1) * accPropExtra
    : accRate;

  // ── Confirmation statement ──
  const [csEnabled, setCsEnabled] = useState(true);
  const [csFee, setCsFee] = useState(D.confirmation_statement.fee);

  // ── Directors ──
  const [dtrEnabled, setDtrEnabled] = useState(true);
  const [addonRates, setAddonRates] = useState({ ...D.director_addons });
  const onAddonRate = (k, v) => setAddonRates((p) => ({ ...p, [k]: v }));
  const newDir = () => ({
    name: '', base: D.director_base, otherDividends: false,
    hasRentals: false, rentalProperties: 1, capitalGains: false,
    savingsIncome: false, otherSources: [],
  });
  const [directors, setDirectors] = useState([newDir()]);
  const updateDir = (i, f, v) => {
    const d = [...directors]; d[i] = { ...d[i], [f]: v }; setDirectors(d);
  };
  const dirTotal = (d) =>
    d.base +
    (d.otherDividends ? addonRates.other_dividends : 0) +
    (d.hasRentals ? d.rentalProperties * addonRates.rental_property : 0) +
    (d.capitalGains ? addonRates.capital_gains : 0) +
    (d.savingsIncome ? addonRates.savings_income : 0) +
    (d.otherSources || []).reduce((s, o) => s + (o.amount || 0), 0);
  const dtrAnnual = directors.reduce((s, d) => s + dirTotal(d), 0);

  // ── Bookkeeping ──
  const [bkEnabled, setBkEnabled] = useState(false);
  const [bkHours, setBkHours] = useState(8);
  const [bkRate, setBkRate] = useState(D.bookkeeping_rate);
  const [bkIncVat, setBkIncVat] = useState(true);
  const [bkVatAdj, setBkVatAdj] = useState(0);
  const bkAnnual = bkHours * bkRate * 12 + (bkIncVat ? bkVatAdj : 0);

  // ── VAT standalone ──
  const [vatEnabled, setVatEnabled] = useState(false);
  const [vatFreq, setVatFreq] = useState(4);
  const [vatRate, setVatRate] = useState(D.vat_per_return);
  const vatAnnual = vatFreq * vatRate;

  // ── Payroll ──
  const [prEnabled, setPrEnabled] = useState(false);
  const prFlatCalc = Math.ceil(
    (D.payroll.brightpay_annual / D.payroll.payroll_client_count) * (1 + D.payroll.markup_pct / 100)
  );
  const [prFlat, setPrFlat] = useState(prFlatCalc);
  const [prMonthlyEe, setPrMonthlyEe] = useState(0);
  const [prMonthlyEeRate, setPrMonthlyEeRate] = useState(D.payroll.monthly_ee_rate);
  const [prWeeklyEe, setPrWeeklyEe] = useState(0);
  const [prWeeklyEeRate, setPrWeeklyEeRate] = useState(D.payroll.weekly_ee_rate);
  const [prCis, setPrCis] = useState(0);
  const [prCisRate, setPrCisRate] = useState(D.payroll.cis_rate);
  const [prP11d, setPrP11d] = useState(0);
  const [prP11dRate, setPrP11dRate] = useState(D.payroll.p11d_rate);
  const prMoCalc = prFlat + prMonthlyEe * prMonthlyEeRate + prWeeklyEe * prWeeklyEeRate * 4.33 + prCis * prCisRate * 4.33;
  const prAnnual = prMoCalc * 12 + prP11d * prP11dRate;

  // ── Auto-enrolment ──
  const [aeEnabled, setAeEnabled] = useState(false);
  const [aeFee, setAeFee] = useState(D.auto_enrolment.standard);

  // ── Modulr Wage Payments ──
  const [modEnabled, setModEnabled] = useState(false);
  const [modSwPrice, setModSwPrice] = useState(D.modulr?.software_monthly_price || 20);
  const [modPayments, setModPayments] = useState(0);
  const [modPaymentRate, setModPaymentRate] = useState(D.modulr?.per_payment || 0.25);
  const [modRuns, setModRuns] = useState(0);
  const [modRunRate, setModRunRate] = useState(D.modulr?.per_run || 5);
  const modMonthly = modSwPrice + modPayments * modPaymentRate + modRuns * modRunRate;
  const modAnnual = modMonthly * 12;

  // ── Management Accounts ──
  const [maEnabled, setMaEnabled] = useState(false);
  const [maSets, setMaSets] = useState(4);
  const [maRate, setMaRate] = useState(D.management_accounts_per_set || 158);
  const maAnnual = maSets * maRate;

  // ── Review Meetings ──
  const [rmEnabled, setRmEnabled] = useState(false);
  const [rmCount, setRmCount] = useState(4);
  const [rmRate, setRmRate] = useState(D.review_meeting_rate || 210);
  const rmAnnual = rmCount * rmRate;

  // ── Budgeting & Forecasting ──
  const [budEnabled, setBudEnabled] = useState(false);
  const [budBasic, setBudBasic] = useState(false);
  const [budBasicRate, setBudBasicRate] = useState(D.budget_basic || 1085);
  const [budAdvanced, setBudAdvanced] = useState(false);
  const [budAdvancedRate, setBudAdvancedRate] = useState(D.budget_advanced || 3255);
  const [budReforecastQty, setBudReforecastQty] = useState(0);
  const [budReforecastRate, setBudReforecastRate] = useState(D.reforecast || 225);
  const budAnnual = (budBasic ? budBasicRate : 0) + (budAdvanced ? budAdvancedRate : 0) + budReforecastQty * budReforecastRate;

  // ── Fractional CFO ──
  const [cfoEnabled, setCfoEnabled] = useState(false);
  const [cfoDays, setCfoDays] = useState(1);
  const [cfoDayRate, setCfoDayRate] = useState(D.cfo_day_rate || 1680);
  const cfoAnnual = cfoDays * cfoDayRate;

  // ── Registered office ──
  const [roEnabled, setRoEnabled] = useState(false);
  const [roFee, setRoFee] = useState(D.registered_office);

  // ── Software ──
  const [swId, setSwId] = useState('none');
  const [dextEnabled, setDextEnabled] = useState(false);
  const [dextPrice, setDextPrice] = useState(D.dext.monthly_price);
  const sw = D.software.find((s) => s.id === swId) || D.software[0];
  const swMonthly = (sw?.monthly || 0) + (dextEnabled ? dextPrice : 0);
  const swAnnual = swMonthly * 12;

  // ── Totals ──
  const lines = [];
  if (accEnabled) lines.push({ id: 'accounts_ct', name: 'Accounts & CT', annual: accAnnual });
  if (csEnabled) lines.push({ id: 'confirmation_statement', name: 'Confirmation Statement', annual: csFee });
  if (dtrEnabled) lines.push({ id: 'directors_tax_return', name: `Directors' Tax Returns`, annual: dtrAnnual });
  if (bkEnabled) lines.push({ id: bkIncVat ? 'bookkeeping_vat' : 'bookkeeping', name: bkIncVat ? 'Bookkeeping & VAT Returns' : 'Bookkeeping', annual: bkAnnual });
  if (vatEnabled) lines.push({ id: 'vat_returns', name: 'VAT Returns', annual: vatAnnual });
  if (prEnabled) lines.push({ id: 'payroll', name: 'Payroll', annual: prAnnual });
  if (aeEnabled) lines.push({ id: 'auto_enrolment', name: 'Auto-Enrolment', annual: aeFee });
  if (modEnabled) lines.push({ id: 'modulr', name: 'Modulr Wage Payments', annual: modAnnual });
  if (maEnabled) lines.push({ id: 'management_accounts', name: 'Management Accounts', annual: maAnnual });
  if (rmEnabled) lines.push({ id: 'review_meetings', name: 'Review Meetings', annual: rmAnnual });
  if (budEnabled) lines.push({ id: 'budgeting', name: 'Budgeting & Forecasting', annual: budAnnual });
  if (cfoEnabled) lines.push({ id: 'fractional_cfo', name: 'Fractional CFO', annual: cfoAnnual });
  if (roEnabled) lines.push({ id: 'registered_office', name: 'Registered Office', annual: roFee });

  // ── Below-standard pricing ──
  // For each enabled service, compute the standard (defaults-rate × the same
  // quantities) and flag where the quoted amount is below it. Driver-based
  // services (payroll, modulr, budgeting, CFO, software) are excluded — their
  // "standard" isn't a single rate, so flagging would be noisy.
  const belowStandard = [];
  const flagBelow = (id, name, actual, standard) => {
    if (standard > 0 && actual < standard - 0.5) belowStandard.push({ id, name, actual, standard });
  };
  if (accEnabled && accType === 'trading' && detectedBand) flagBelow('accounts_ct', 'Accounts & CT', accAnnual, detectedBand.rate);
  if (csEnabled) flagBelow('confirmation_statement', 'Confirmation Statement', csFee, D.confirmation_statement.fee);
  if (dtrEnabled) {
    const stdDtr = directors.reduce((s, d) =>
      s + D.director_base
        + (d.otherDividends ? D.director_addons.other_dividends : 0)
        + (d.hasRentals ? d.rentalProperties * D.director_addons.rental_property : 0)
        + (d.capitalGains ? D.director_addons.capital_gains : 0)
        + (d.savingsIncome ? D.director_addons.savings_income : 0)
        + (d.otherSources || []).reduce((a, o) => a + (o.amount || 0), 0), 0);
    flagBelow('directors_tax_return', "Directors' Tax Returns", dtrAnnual, stdDtr);
  }
  if (bkEnabled) flagBelow('bookkeeping_vat', 'Bookkeeping & VAT', bkAnnual, bkHours * D.bookkeeping_rate * 12 + (bkIncVat ? bkVatAdj : 0));
  if (vatEnabled) flagBelow('vat_returns', 'VAT Returns', vatAnnual, vatFreq * D.vat_per_return);
  if (aeEnabled) flagBelow('auto_enrolment', 'Auto-Enrolment', aeFee, D.auto_enrolment.standard);
  if (roEnabled) flagBelow('registered_office', 'Registered Office', roFee, D.registered_office);
  if (rmEnabled) flagBelow('review_meetings', 'Review Meetings', rmAnnual, rmCount * (D.review_meeting_rate || 210));
  if (maEnabled) flagBelow('management_accounts', 'Management Accounts', maAnnual, maSets * (D.management_accounts_per_set || 158));

  const annualServices = lines.reduce((s, l) => s + l.annual, 0);
  const annualTotal = annualServices + swAnnual;
  const monthlyNet = Math.round((annualTotal / 12) * 100) / 100;
  const monthlyVat = Math.round(monthlyNet * 0.2 * 100) / 100;
  const monthlyGross = Math.round((monthlyNet + monthlyVat) * 100) / 100;

  // ── Build quote data for save ──
  const buildQuoteData = () => {
    const setupLines = [];
    if (suFormation) setupLines.push({ type: 'formation', description: 'Company formation', qty: suFormationQty, rate: suFormationRate, amount: suFormationQty * suFormationRate });
    if (suHmrc) setupLines.push({ type: 'hmrc', description: 'HMRC registrations', qty: suHmrcQty, rate: suHmrcRate, amount: suHmrcQty * suHmrcRate });
    if (suRegFee > 0) setupLines.push({ type: 'reg_fee', description: 'Registration fee', amount: suRegFee });
    suOthers.forEach((o) => { if (o.amount > 0) setupLines.push({ type: 'other', description: o.description || 'Other', amount: o.amount }); });

    return {
      data: {
        estimated_turnover: turnoverNum || null,
        annual_services: Math.round(annualServices * 100) / 100,
        annual_software: swAnnual,
        annual_total: Math.round(annualTotal * 100) / 100,
        monthly_net: monthlyNet,
        monthly_vat: monthlyVat,
        monthly_gross: monthlyGross,
        one_off_total: setupTotal,
        defaults_version: D.version,
        directors: dtrEnabled ? directors.map((d) => ({
          name: d.name, base: d.base, other_dividends: d.otherDividends,
          has_rentals: d.hasRentals, rental_properties: d.hasRentals ? d.rentalProperties : 0,
          capital_gains: d.capitalGains, savings_income: d.savingsIncome,
          other_sources: d.otherSources || [], addon_rates_used: addonRates, total: dirTotal(d),
        })) : [],
        setup_fees: setupLines,
        payroll_detail: prEnabled ? { flat_monthly: prFlat, monthly_ee: prMonthlyEe, monthly_ee_rate: prMonthlyEeRate, weekly_ee: prWeeklyEe, weekly_ee_rate: prWeeklyEeRate, cis: prCis, cis_rate: prCisRate, p11d: prP11d, p11d_rate: prP11dRate } : null,
        bookkeeping_detail: bkEnabled ? { hours_per_month: bkHours, rate: bkRate, includes_vat: bkIncVat, vat_adj: bkVatAdj } : null,
        software_detail: swMonthly > 0 ? { accounting: sw?.id !== 'none' ? { id: sw.id, name: sw.name, monthly: sw.monthly, cost: sw.cost } : null, dext: dextEnabled ? { monthly: dextPrice, cost: D.dext.cost } : null } : null,
        accounts_detail: accEnabled ? { type: accType, band: detectedBand?.label, rate: accAnnual, properties: accType === 'property' ? accProperties : undefined } : null,
        modulr_detail: modEnabled ? { software_monthly: modSwPrice, payments_per_month: modPayments, payment_rate: modPaymentRate, runs_per_month: modRuns, run_rate: modRunRate } : null,
        management_accounts_detail: maEnabled ? { sets: maSets, rate_per_set: maRate } : null,
        review_meetings_detail: rmEnabled ? { count: rmCount, rate: rmRate } : null,
        budgeting_detail: budEnabled ? { basic: budBasic ? budBasicRate : null, advanced: budAdvanced ? budAdvancedRate : null, reforecast_qty: budReforecastQty, reforecast_rate: budReforecastRate } : null,
        cfo_detail: cfoEnabled ? { days: cfoDays, day_rate: cfoDayRate } : null,
        relationship_group: client.name || null,
        valid_until: validUntil || null,
      },
      setupLines,
    };
  };

  const buildLineItems = (qid, setupLines) => {
    const items = lines.map((l, i) => ({
      quote_id: qid, service_id: l.id, description: l.name,
      annual_amount: Math.round(l.annual * 100) / 100,
      monthly_amount: Math.round((l.annual / 12) * 100) / 100,
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
  };

  // ── Seed from an existing recurring bill ──
  // `seedLines` is a list of { serviceId (Athena), annual, monthly } already
  // reverse-mapped from the QBO/live_billing services by the caller. We
  // enable each service and set the cleanest fee field. Driver-based
  // services (directors, bookkeeping, payroll counts, management accounts,
  // software) can't be decomposed from a flat amount, so we set a single
  // representative driver to hit the number and return them in needsReview
  // for the user to confirm.
  // priceMode 'copy'     → set each service's fee from the bill amount.
  // priceMode 'services' → enable the same services but leave fees at the
  //                        current pricing defaults (re-price to standard).
  const seedFromBilling = (seedLines, opts = {}) => {
    const priceMode = opts.priceMode || 'copy';
    const copy = priceMode === 'copy';
    const needsReview = [];
    for (const line of seedLines || []) {
      const annual = Number(line.annual) || 0;
      const monthly = Number(line.monthly) || (annual ? annual / 12 : 0);
      switch (line.serviceId) {
        case 'accounts_ct':
          setAccEnabled(true); if (copy) setAccRate(Math.round(annual));
          break;
        case 'confirmation_statement':
          setCsEnabled(true); if (copy) setCsFee(Math.round(annual));
          break;
        case 'vat_returns':
          setVatEnabled(true); if (copy) { setVatFreq(4); setVatRate(Math.round((annual / 4) * 100) / 100); }
          break;
        case 'auto_enrolment':
          setAeEnabled(true); if (copy) setAeFee(Math.round(annual));
          break;
        case 'registered_office':
          setRoEnabled(true); if (copy) setRoFee(Math.round(annual));
          break;
        case 'review_meetings':
          setRmEnabled(true); if (copy) { setRmCount(1); setRmRate(Math.round(annual)); needsReview.push('Review Meetings (set count/rate)'); }
          break;
        case 'management_accounts':
          setMaEnabled(true); if (copy) { setMaSets(1); setMaRate(Math.round(annual)); needsReview.push('Management Accounts (set number of sets)'); }
          break;
        case 'payroll':
          setPrEnabled(true); if (copy) { setPrFlat(Math.round(monthly * 100) / 100); needsReview.push('Payroll (set employee counts)'); }
          break;
        case 'bookkeeping_vat':
          setBkEnabled(true); if (copy) { setBkHours(1); setBkRate(Math.round(monthly * 100) / 100); setBkIncVat(true); needsReview.push('Bookkeeping & VAT (set hours × rate)'); }
          break;
        case 'directors_tax_return':
          setDtrEnabled(true); if (copy) { setDirectors([{ ...newDir(), base: Math.round(annual) }]); needsReview.push("Directors' Tax Returns (set number of directors)"); }
          break;
        case 'modulr':
          setModEnabled(true); if (copy) { setModSwPrice(Math.round(monthly * 100) / 100); needsReview.push('Modulr (set payments/runs)'); }
          break;
        case 'software_accounting':
          needsReview.push('Software (' + (copy && annual ? '£' + Math.round(monthly) + '/mo' : '') + ' — choose the software package)');
          break;
        default:
          needsReview.push((line.serviceId || 'Unknown service') + ' (no automatic mapping)');
      }
    }
    return needsReview;
  };

  // ── Load from saved quote (for edit/re-quote) ──
  const loadFromQuote = (q) => {
    setClient({
      name: q.relationship_group || '',
      companyNumber: '',
      entityType: q.accounts_detail?.type || 'limited_company',
      turnover: q.estimated_turnover ? String(q.estimated_turnover) : '',
    });

    // Setup fees
    const sf = q.setup_fees || [];
    const formation = sf.find(s => s.type === 'formation');
    const hmrc = sf.find(s => s.type === 'hmrc');
    const regFee = sf.find(s => s.type === 'reg_fee');
    const others = sf.filter(s => s.type === 'other');
    if (formation) { setSuFormation(true); setSuFormationQty(formation.qty || 1); setSuFormationRate(formation.rate || D.setup.formation_rate); }
    if (hmrc) { setSuHmrc(true); setSuHmrcQty(hmrc.qty || 1); setSuHmrcRate(hmrc.rate || D.setup.hmrc_reg_rate); }
    if (regFee) setSuRegFee(regFee.amount || 0);
    if (others.length) setSuOthers(others.map(o => ({ description: o.description || '', amount: o.amount || 0 })));

    // Accounts — explicitly reflect the saved state (default-true flags
    // would otherwise leak through when the saved quote had it disabled).
    setAccEnabled(!!q.accounts_detail);
    if (q.accounts_detail) {
      setAccType(q.accounts_detail.type || 'trading');
      setAccRate(q.accounts_detail.rate || 900);
      if (q.accounts_detail.properties) setAccProperties(q.accounts_detail.properties);
    }

    // csEnabled is driven by line items (set by the caller after loading
    // line_items) — the old `annual_services > 0` heuristic spuriously
    // re-enabled CS when other services existed.

    // Directors — reflect the saved state. An empty/missing directors array
    // means DTR was off; don't let the default-true initial state re-enable it.
    const hasDtr = Array.isArray(q.directors) && q.directors.length > 0;
    setDtrEnabled(hasDtr);
    if (hasDtr) {
      setDirectors(q.directors.map(d => ({
        name: d.name || '', base: d.base || D.director_base,
        otherDividends: d.other_dividends || false,
        hasRentals: d.has_rentals || false,
        rentalProperties: d.rental_properties || 1,
        capitalGains: d.capital_gains || false,
        savingsIncome: d.savings_income || false,
        otherSources: d.other_sources || [],
      })));
      if (q.directors[0]?.addon_rates_used) setAddonRates(q.directors[0].addon_rates_used);
    }

    // Bookkeeping
    if (q.bookkeeping_detail) {
      setBkEnabled(true);
      setBkHours(q.bookkeeping_detail.hours_per_month || 8);
      setBkRate(q.bookkeeping_detail.rate || D.bookkeeping_rate);
      setBkIncVat(q.bookkeeping_detail.includes_vat ?? true);
      setBkVatAdj(q.bookkeeping_detail.vat_adj || 0);
    }

    // Payroll
    if (q.payroll_detail) {
      setPrEnabled(true);
      setPrFlat(q.payroll_detail.flat_monthly || 0);
      setPrMonthlyEe(q.payroll_detail.monthly_ee || 0);
      setPrMonthlyEeRate(q.payroll_detail.monthly_ee_rate || D.payroll.monthly_ee_rate);
      setPrWeeklyEe(q.payroll_detail.weekly_ee || 0);
      setPrWeeklyEeRate(q.payroll_detail.weekly_ee_rate || D.payroll.weekly_ee_rate);
      setPrCis(q.payroll_detail.cis || 0);
      setPrCisRate(q.payroll_detail.cis_rate || D.payroll.cis_rate);
      setPrP11d(q.payroll_detail.p11d || 0);
      setPrP11dRate(q.payroll_detail.p11d_rate || D.payroll.p11d_rate);
    }

    // Modulr
    if (q.modulr_detail) {
      setModEnabled(true);
      setModSwPrice(q.modulr_detail.software_monthly || D.modulr?.software_monthly_price || 20);
      setModPayments(q.modulr_detail.payments_per_month || 0);
      setModPaymentRate(q.modulr_detail.payment_rate || D.modulr?.per_payment || 0.25);
      setModRuns(q.modulr_detail.runs_per_month || 0);
      setModRunRate(q.modulr_detail.run_rate || D.modulr?.per_run || 5);
    }

    // Management Accounts
    if (q.management_accounts_detail) {
      setMaEnabled(true);
      setMaSets(q.management_accounts_detail.sets || 4);
      setMaRate(q.management_accounts_detail.rate_per_set || D.management_accounts_per_set);
    }

    // Review Meetings
    if (q.review_meetings_detail) {
      setRmEnabled(true);
      setRmCount(q.review_meetings_detail.count || 4);
      setRmRate(q.review_meetings_detail.rate || D.review_meeting_rate);
    }

    // Budgeting
    if (q.budgeting_detail) {
      setBudEnabled(true);
      if (q.budgeting_detail.basic) { setBudBasic(true); setBudBasicRate(q.budgeting_detail.basic); }
      if (q.budgeting_detail.advanced) { setBudAdvanced(true); setBudAdvancedRate(q.budgeting_detail.advanced); }
      setBudReforecastQty(q.budgeting_detail.reforecast_qty || 0);
      setBudReforecastRate(q.budgeting_detail.reforecast_rate || D.reforecast);
    }

    // CFO
    if (q.cfo_detail) {
      setCfoEnabled(true);
      setCfoDays(q.cfo_detail.days || 1);
      setCfoDayRate(q.cfo_detail.day_rate || D.cfo_day_rate);
    }

    // Software
    if (q.software_detail?.accounting) setSwId(q.software_detail.accounting.id || 'none');
    if (q.software_detail?.dext) { setDextEnabled(true); setDextPrice(q.software_detail.dext.monthly || D.dext.monthly_price); }

    // Valid until
    if (q.valid_until) setValidUntil(q.valid_until);
  };

  return {
    // Client
    client, setClient, validUntil, setValidUntil,
    // Setup
    suFormation, setSuFormation, suFormationQty, setSuFormationQty, suFormationRate, setSuFormationRate,
    suHmrc, setSuHmrc, suHmrcQty, setSuHmrcQty, suHmrcRate, setSuHmrcRate,
    suRegFee, setSuRegFee, suOthers, setSuOthers, setupTotal,
    // Accounts
    accEnabled, setAccEnabled, accType, setAccType, accRate, setAccRate,
    accProperties, setAccProperties, accPropBase, setAccPropBase, accPropExtra, setAccPropExtra,
    accDormant, setAccDormant, turnoverNum, detectedBand, accAnnual,
    // Confirmation
    csEnabled, setCsEnabled, csFee, setCsFee,
    // Directors
    dtrEnabled, setDtrEnabled, addonRates, setAddonRates, onAddonRate,
    newDir, directors, setDirectors, updateDir, dirTotal, dtrAnnual,
    // Bookkeeping
    bkEnabled, setBkEnabled, bkHours, setBkHours, bkRate, setBkRate,
    bkIncVat, setBkIncVat, bkVatAdj, setBkVatAdj, bkAnnual,
    // VAT
    vatEnabled, setVatEnabled, vatFreq, setVatFreq, vatRate, setVatRate, vatAnnual,
    // Payroll
    prEnabled, setPrEnabled, prFlat, setPrFlat, prFlatCalc,
    prMonthlyEe, setPrMonthlyEe, prMonthlyEeRate, setPrMonthlyEeRate,
    prWeeklyEe, setPrWeeklyEe, prWeeklyEeRate, setPrWeeklyEeRate,
    prCis, setPrCis, prCisRate, setPrCisRate,
    prP11d, setPrP11d, prP11dRate, setPrP11dRate, prMoCalc, prAnnual,
    // Auto-enrolment
    aeEnabled, setAeEnabled, aeFee, setAeFee,
    // Modulr
    modEnabled, setModEnabled, modSwPrice, setModSwPrice, modPayments, setModPayments,
    modPaymentRate, setModPaymentRate, modRuns, setModRuns, modRunRate, setModRunRate,
    modMonthly, modAnnual,
    // Management Accounts
    maEnabled, setMaEnabled, maSets, setMaSets, maRate, setMaRate, maAnnual,
    // Review Meetings
    rmEnabled, setRmEnabled, rmCount, setRmCount, rmRate, setRmRate, rmAnnual,
    // Budgeting
    budEnabled, setBudEnabled, budBasic, setBudBasic, budBasicRate, setBudBasicRate,
    budAdvanced, setBudAdvanced, budAdvancedRate, setBudAdvancedRate,
    budReforecastQty, setBudReforecastQty, budReforecastRate, setBudReforecastRate, budAnnual,
    // CFO
    cfoEnabled, setCfoEnabled, cfoDays, setCfoDays, cfoDayRate, setCfoDayRate, cfoAnnual,
    // Registered office
    roEnabled, setRoEnabled, roFee, setRoFee,
    // Software
    swId, setSwId, dextEnabled, setDextEnabled, dextPrice, setDextPrice, sw, swMonthly, swAnnual,
    // Totals
    lines, annualServices, annualTotal, monthlyNet, monthlyVat, monthlyGross,
    // Below-standard pricing flags
    belowStandard,
    // Builders
    buildQuoteData, buildLineItems, loadFromQuote, seedFromBilling,
    // Defaults ref
    D,
  };
}
