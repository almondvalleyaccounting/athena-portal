// Why a client's fee is changing — the vocabulary shared by the
// single-client reprice modal, its letter (PDF) and its email.
//
// Every reason belongs to exactly one bucket, and the buckets are the
// rows of the client-facing summary table:
//
//   ourFees      — our own price went up. Only two things may raise it:
//                  inflation, or the client's business growing. The
//                  email footnote promises the client exactly that, so
//                  no other reason may map here.
//   reductions   — our own price came down (less work, a smaller
//                  business, a goodwill reduction)
//   split        — one fee split out into separate services: the old
//                  line comes down and the new lines take up the
//                  difference, so they belong together in one row rather
//                  than reading as a cut plus new services
//   newService   — a service they did not have before
//   removed      — a service they no longer take
//   passedOn     — a cost we pay on their behalf, passed on at cost
//   other        — anything else, always with free text
//
// The label is what the client reads; it is also stored on the service
// line as pending_uplift_reason so Push and the audit trail carry it.
//
// `optional` rows appear in the client's table only when a line uses
// them — most reviews have no reductions and no split, and a column of
// dashes for them would only raise the question.

import { isCostPassThrough } from './composeUpliftEmail';

export const BUCKETS = [
  { key: 'ourFees',    label: 'Increases in our fees', star: true },
  { key: 'reductions', label: 'Reductions in our fees', optional: true },
  { key: 'split',      label: 'Fees split into separate services', optional: true },
  { key: 'newService', label: 'New services' },
  { key: 'removed',    label: 'Services removed' },
  { key: 'passedOn',   label: 'Costs passed on' },
  { key: 'other',      label: 'Other' },
];

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

// Where a line's amount went. A split comes first: its new lines start
// at £0 and its old line may fall to £0, and all of them belong to the
// split. Otherwise a £0 → £x line is a new service and a £x → £0 line a
// removal whatever reason is picked — facts about the amounts, not
// judgements — and our-fee reasons follow the direction the fee actually
// moved, so a cut can never be counted as an "increase in our fees".
export function bucketFor(line) {
  const cur = Number(line.current) || 0;
  const neu = Number(line.next) || 0;
  if (line.reasonKey === 'split') return 'split';
  if (cur === 0 && neu > 0) return 'newService';
  if (cur > 0 && neu === 0) return 'removed';
  const bucket = REASON_BY_KEY[line.reasonKey]?.bucket || 'other';
  if (bucket === 'ourFees' && neu < cur) return 'reductions';
  if (bucket === 'reductions' && neu > cur) return 'ourFees';
  return bucket;
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

// Recover the reason key a line was saved with, so reopening the modal
// shows what was chosen rather than re-suggesting.
export function reasonFromSaved(s) {
  if (s.pending_uplift_reason_key && REASON_BY_KEY[s.pending_uplift_reason_key]) {
    return { reasonKey: s.pending_uplift_reason_key, otherText: s.pending_uplift_reason_key === 'other' ? (s.pending_uplift_reason || '') : '' };
  }
  return null;
}

// The text stored on the line and shown to the client.
export function reasonText(line) {
  if (line.reasonKey === 'other') return (line.otherText || '').trim() || 'Other';
  return REASON_BY_KEY[line.reasonKey]?.label || '';
}

export const VAT_RATE = 0.2;
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// Roll the changed lines up into the summary table. Monthly net figures;
// callers multiply by 12 for the year.
export function summarise(lines) {
  const buckets = Object.fromEntries(BUCKETS.map((b) => [b.key, 0]));
  const used = new Set();
  let current = 0, next = 0;
  for (const l of lines) {
    const cur = Number(l.current) || 0;
    const neu = Number(l.next) || 0;
    current += cur;
    next += neu;
    if (cur === neu) continue;
    const b = bucketFor(l);
    buckets[b] += neu - cur;
    used.add(b);
  }
  for (const k of Object.keys(buckets)) buckets[k] = r2(buckets[k]);
  current = r2(current);
  next = r2(next);
  const vat = r2(next * VAT_RATE);
  return { current, next, delta: r2(next - current), buckets, used: [...used], vat, gross: r2(next + vat) };
}

// The rows the client's table shows: every standard row, plus an
// optional one when a line uses it (a split that nets to £0 still shows,
// with a dash, because the letter lists its lines).
export function visibleBuckets(summary) {
  const used = new Set(summary?.used || []);
  return BUCKETS.filter((b) => !b.optional || used.has(b.key));
}

export const OUR_FEES_FOOTNOTE =
  'Our own fees only ever increase for one of two reasons: inflation, or because your business has grown and there is more work for us to do. Everything else in this table is a service you have added or stopped, or a cost we pay on your behalf and pass on without any mark-up.';

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
