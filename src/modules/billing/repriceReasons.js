// Why a client's fee is changing — the vocabulary shared by the
// single-client fee review modal, its letter (PDF) and its email.
//
// A service line's change is one or more CHANGES, each a reason and an
// amount. Most lines have one. A line can have several: Accounts that was
// priced to include other work is split out (−£80) and then has our fee
// raised (+£6), and the letter shows both.
//
// Every change falls in one bucket, and the buckets are the rows of the
// client's summary table:
//
//   ourFees      our own price went up — only ever for inflation or the
//                client's business growing (the footnote promises that)
//   reductions   our own price came down
//   split        a fee split out into separate services: the old line comes
//                down and the new lines take up the difference, so they
//                share one row rather than reading as a cut plus new services
//   newService   a service the client did not have before
//   removed      a service the client no longer takes
//   passedOn     a cost we pay for them, charged at cost
//   other        anything else, always with free text
//
// WHICH CHANGES NEED THE CLIENT'S AGREEMENT (decided 2026-09-25):
// only adding a new service. Fee increases and reductions, costs passed
// on, splits and removals are changes we make and tell the client about;
// they are pushed to QuickBooks from their effective date. A new service
// is proposed, and is held back from QuickBooks until staff record the
// client's written acceptance. That is `needsAcceptance` below — the one
// place the rule lives.
//
// `part` puts a row in the letter's two parts: 1 = changes to their fees,
// 2 = new services we're proposing. `optional` rows show only when used.

import { isCostPassThrough } from './composeUpliftEmail';

export const BUCKETS = [
  { key: 'ourFees',    label: 'Increases in our fees', star: true, part: 1 },
  { key: 'reductions', label: 'Reductions in our fees', optional: true, part: 1 },
  { key: 'split',      label: 'Fees split into separate services', optional: true, part: 1 },
  { key: 'removed',    label: 'Services removed', part: 1 },
  { key: 'passedOn',   label: 'Costs passed on', part: 1 },
  { key: 'other',      label: 'Other', part: 1 },
  { key: 'newService', label: 'New services', part: 2, needsAcceptance: true },
];
export const BUCKET_BY_KEY = Object.fromEntries(BUCKETS.map((b) => [b.key, b]));

export const REASONS = [
  { key: 'inflation',     bucket: 'ourFees',    label: 'Annual inflation adjustment' },
  { key: 'turnover',      bucket: 'ourFees',    label: 'Your turnover has increased' },
  { key: 'employees',     bucket: 'ourFees',    label: 'More employees on the payroll' },
  { key: 'transactions',  bucket: 'ourFees',    label: 'More transactions to process' },
  { key: 'complexity',    bucket: 'ourFees',    label: 'Your affairs have become more complex' },
  { key: 'less_work',     bucket: 'reductions', label: 'Less work is needed than before' },
  { key: 'turnover_down', bucket: 'reductions', label: 'Your turnover has fallen' },
  { key: 'fewer_employees', bucket: 'reductions', label: 'Fewer employees on the payroll' },
  { key: 'fewer_transactions', bucket: 'reductions', label: 'Fewer transactions to process' },
  { key: 'standard_rate', bucket: 'reductions', label: 'Brought into line with our standard fees' },
  { key: 'goodwill',      bucket: 'reductions', label: 'Goodwill reduction' },
  { key: 'split',         bucket: 'split',      label: 'Fee split out into separate services' },
  { key: 'new_service',   bucket: 'newService', label: 'New service added' },
  { key: 'removed',       bucket: 'removed',    label: 'Service no longer required' },
  { key: 'ch_fee',        bucket: 'passedOn',   label: 'Companies House fee increase' },
  { key: 'software',      bucket: 'passedOn',   label: 'Software licence cost change' },
  { key: 'other',         bucket: 'other',      label: 'Other', freeText: true },
];
export const REASON_BY_KEY = Object.fromEntries(REASONS.map((r) => [r.key, r]));

export const VAT_RATE = 0.2;
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const money = (n) => `£${Math.abs(Number(n) || 0).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// A line's changes. The line's first reason (reasonKey/otherText) takes
// whatever the extra changes don't account for, so typing a new fee always
// balances: new = current + every change.
//
// Bucket of a change: a split is a split; a whole line appearing from £0
// is a new service and a whole line going to £0 a removal (facts about the
// amounts, not judgements); otherwise the reason's bucket, with our-fee
// reasons following the direction the money actually moved.
export function componentsOf(line) {
  const cur = Number(line.current) || 0;
  const neu = Number(line.next) || 0;
  const extras = (line.extra || []).map((e) => ({
    reasonKey: e.reasonKey, otherText: e.otherText || '', amount: r2(e.amount),
    splitId: e.splitId || null, splitTo: e.splitTo || null, splitFrom: e.splitFrom || null,
  }));
  const primaryAmount = r2(neu - cur - extras.reduce((t, e) => t + e.amount, 0));
  const all = [{
    reasonKey: line.reasonKey, otherText: line.otherText || '', amount: primaryAmount, primary: true,
    splitId: line.splitId || null, splitFrom: line.splitFrom || null,
  }, ...extras];
  return all
    .filter((c) => c.amount !== 0)
    .map((c) => {
      let bucket;
      if (c.reasonKey === 'split') bucket = 'split';
      else if (c.primary && cur === 0 && neu > 0) bucket = 'newService';
      else if (c.primary && cur > 0 && neu === 0) bucket = 'removed';
      else {
        bucket = REASON_BY_KEY[c.reasonKey]?.bucket || 'other';
        if (bucket === 'ourFees' && c.amount < 0) bucket = 'reductions';
        if (bucket === 'reductions' && c.amount > 0) bucket = 'ourFees';
        if (bucket === 'newService' && !(cur === 0)) bucket = c.amount > 0 ? 'ourFees' : 'reductions';
      }
      return { ...c, bucket, needsAcceptance: !!BUCKET_BY_KEY[bucket]?.needsAcceptance };
    });
}

// The bucket of a line's first reason — for the modal's hint. null when
// the first reason nets to £0 (all of the change is in extra reasons).
export function bucketFor(line) {
  return componentsOf(line).find((c) => c.primary)?.bucket || null;
}

// Does this line wait for the client's written acceptance?
export function lineNeedsAcceptance(line) {
  return componentsOf(line).some((c) => c.needsAcceptance);
}

// Which part of the letter a line sits in: 2 if it needs acceptance.
export function partFor(line) {
  return lineNeedsAcceptance(line) ? 2 : 1;
}

// Suggest a reason for a changed line. Staff always see it and can
// change it; this only saves picking the obvious one every time.
export function suggestReason({ serviceId, current, next }) {
  const cur = Number(current) || 0;
  const neu = Number(next) || 0;
  if (cur === 0 && neu > 0) return 'new_service';
  if (cur > 0 && neu === 0) return 'removed';
  if (neu < cur) {
    if (/payroll|pension|auto.?enrol/i.test(serviceId || '')) return 'fewer_employees';
    if (/bookkeep|vat/i.test(serviceId || '')) return 'fewer_transactions';
    if (/accounts/i.test(serviceId || '')) return 'turnover_down';
    return 'less_work';
  }
  if (/confirmation statement|companies house/i.test(serviceId || '')) return 'ch_fee';
  if (isCostPassThrough(serviceId)) return 'software';
  if (/payroll|pension|auto.?enrol/i.test(serviceId || '')) return cur > 0 && neu / cur > 1.1 ? 'employees' : 'inflation';
  if (/bookkeep|vat/i.test(serviceId || '')) return cur > 0 && neu / cur > 1.1 ? 'transactions' : 'inflation';
  // A rise within ~10% reads as inflation; beyond it, growth.
  if (cur > 0 && neu / cur > 1.1) return 'turnover';
  return 'inflation';
}

// Restore what a line was saved with, so reopening the modal shows the
// reasons chosen rather than re-suggesting.
export function reasonFromSaved(s) {
  const saved = Array.isArray(s.pending_changes) ? s.pending_changes.filter((c) => REASON_BY_KEY[c.reason_key]) : null;
  if (saved && saved.length) {
    // The first reason is saved flagged `primary` (older saves: the first
    // entry). It may have netted to £0 and not been saved at all.
    const first = saved.find((c) => c.primary) || (saved.some((c) => 'primary' in c) ? null : saved[0]);
    const rest = saved.filter((c) => c !== first);
    return {
      reasonKey: first?.reason_key || s.pending_uplift_reason_key || 'other',
      otherText: first?.reason_key === 'other' ? (first.other_text || '') : '',
      splitId: first?.split_id || null,
      splitFrom: first?.split_from || null,
      extra: rest.map((c, i) => ({
        id: `saved-${i}`, reasonKey: c.reason_key, amount: String(c.amount), otherText: c.other_text || '',
        splitId: c.split_id || null, splitTo: c.split_to || null, splitFrom: c.split_from || null,
      })),
    };
  }
  if (s.pending_uplift_reason_key && REASON_BY_KEY[s.pending_uplift_reason_key]) {
    return { reasonKey: s.pending_uplift_reason_key, otherText: s.pending_uplift_reason_key === 'other' ? (s.pending_uplift_reason || '') : '', extra: [] };
  }
  return null;
}

// What the client reads for one change, and for a whole line.
export function changeLabel(c) {
  if (c.reasonKey === 'other') return (c.otherText || '').trim() || 'Other';
  // A split names the service the money moved to or from.
  if (c.reasonKey === 'split' && c.splitTo) return `Split out into ${c.splitTo}`;
  if (c.reasonKey === 'split' && c.splitFrom) return `Split out of ${c.splitFrom}`;
  return REASON_BY_KEY[c.reasonKey]?.label || '';
}
export function reasonText(line) {
  const comps = componentsOf(line);
  if (comps.length === 0) return '';
  if (comps.length === 1) return changeLabel(comps[0]);
  return comps.map((c) => `${changeLabel(c)} (${c.amount > 0 ? '+' : '-'}${money(c.amount)})`).join('; ');
}

// What a line is saved with, beside its pending amount.
export function savedChanges(line) {
  return componentsOf(line).map((c) => ({
    reason_key: c.reasonKey, other_text: c.reasonKey === 'other' ? c.otherText : null,
    amount: c.amount, bucket: c.bucket, needs_acceptance: c.needsAcceptance,
    ...(c.primary ? { primary: true } : {}),
    ...(c.splitId ? { split_id: c.splitId, split_to: c.splitTo, split_from: c.splitFrom } : {}),
  }));
}

// Roll the lines up into the summary table. Monthly net figures; callers
// multiply by 12 for the year.
export function summarise(lines) {
  const buckets = Object.fromEntries(BUCKETS.map((b) => [b.key, 0]));
  const used = new Set();
  let current = 0, next = 0;
  for (const l of lines) {
    current += Number(l.current) || 0;
    next += Number(l.next) || 0;
    for (const c of componentsOf(l)) {
      buckets[c.bucket] += c.amount;
      used.add(c.bucket);
    }
  }
  for (const k of Object.keys(buckets)) buckets[k] = r2(buckets[k]);
  current = r2(current);
  next = r2(next);
  const vat = r2(next * VAT_RATE);
  return {
    current, next, delta: r2(next - current), buckets, used: [...used], vat, gross: r2(next + vat),
    needsAcceptance: lines.some(lineNeedsAcceptance),
  };
}

// The rows the client's table shows: every standard row, plus an optional
// one when a change uses it.
export function visibleBuckets(summary) {
  const used = new Set(summary?.used || []);
  return BUCKETS.filter((b) => !b.optional || used.has(b.key));
}

// A fee change that adds a service is a proposal (the client must agree to
// that part); one that doesn't is a notice.
export function kindOf(summary) {
  return summary?.needsAcceptance ? 'proposal' : 'notice';
}

export const OUR_FEES_FOOTNOTE =
  'Our fees only go up with inflation, or when your business grows and there is more work to do. Costs passed on are charged at cost.';

export const PART_TITLE = {
  1: 'Part 1 — changes to your fees',
  2: 'Part 2 — new services we are proposing',
};

// The summary table, row by row, for the email and the letter alike.
//   notice   — current fee, each change, new fee, VAT, total
//   proposal — the same in two parts: the changes we're making, with the
//              fee they come to, then the new services for the client to
//              agree to
// Row types: total | step | section | subtotal | vat | grand.
export function summaryRows(summary, kind = kindOf(summary)) {
  const step = (b) => ({ type: 'step', label: b.label, v: summary.buckets[b.key], star: b.star });
  const shown = visibleBuckets(summary);
  const rows = [{ type: 'total', label: 'Current monthly fee', v: summary.current }];
  if (kind === 'proposal') {
    const p1 = shown.filter((b) => b.part === 1);
    const p2 = shown.filter((b) => b.part === 2);
    const afterPart1 = r2(summary.current + p1.reduce((t, b) => t + summary.buckets[b.key], 0));
    rows.push({ type: 'section', label: PART_TITLE[1] });
    rows.push(...p1.map(step));
    rows.push({ type: 'subtotal', label: 'Your fee after these changes', v: afterPart1 });
    rows.push({ type: 'section', label: PART_TITLE[2] });
    rows.push(...p2.map(step));
    rows.push({ type: 'total', label: 'New fee if you accept (excl. VAT)', v: summary.next });
  } else {
    rows.push(...shown.map(step));
    rows.push({ type: 'total', label: 'New monthly fee (excl. VAT)', v: summary.next });
  }
  rows.push({ type: 'vat', label: `VAT at ${Math.round(VAT_RATE * 100)}%`, v: summary.vat });
  rows.push({ type: 'grand', label: 'Total including VAT', v: summary.gross });
  return rows;
}

// First day of next month, ISO — the default effective date.
export function firstOfNextMonth(from = new Date()) {
  const d = new Date(Date.UTC(from.getFullYear(), from.getMonth() + 1, 1));
  return d.toISOString().slice(0, 10);
}

export function longDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
}
