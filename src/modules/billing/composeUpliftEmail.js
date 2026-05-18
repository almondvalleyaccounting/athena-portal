// Build the data + body for a fee-raise email per approved row.
//
// Three change categories, in priority order:
//   1. Service changes        — strategy='manual' (you've explicitly
//                                re-priced or added a service)
//   2. Cost pass-throughs    — services whose price you don't control
//                              (software licences, confirmation
//                              statement filing fees). Detected by
//                              service_id pattern. These take
//                              precedence over inflation classification
//                              for the same line.
//   3. Inflation adjustment   — everything else (strategy='inflation'
//                              or 'floor')

const COST_PASSTHROUGH_PATTERNS = [
  /software/i,
  /licen[cs]e/i,
  /confirmation statement/i,
  /\bid verif/i,
];

export function isCostPassThrough(serviceId) {
  if (!serviceId) return false;
  return COST_PASSTHROUGH_PATTERNS.some((p) => p.test(serviceId));
}

// Money formatter — kept local to avoid an import cycle.
function fmt(n) {
  const v = Number(n) || 0;
  return `£${Math.abs(v).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function fmtSigned(n) {
  const v = Number(n) || 0;
  const prefix = v > 0 ? '+' : v < 0 ? '−' : '';
  return `${prefix}${fmt(Math.abs(v))}`;
}

// Compose the per-row email data.
//
// services[] are the live_billing.services jsonb entries with a
// pending_monthly_amount set. effectiveAt is the row's
// pending_effective_at (first non-null wins).
export function composeUpliftEmail({ clientName, services, contactName }) {
  // Split services into the three buckets. Order within bucket:
  // largest delta first.
  const buckets = { manual: [], passThrough: [], inflation: [] };
  let currentMonthly = 0;
  let newMonthly = 0;
  let effectiveAt = null;
  for (const s of services) {
    const cur = Number(s.monthly_amount) || 0;
    const pen = Number(s.pending_monthly_amount) || 0;
    if (pen === 0 || pen === cur) continue;
    currentMonthly += cur;
    newMonthly += pen;
    if (!effectiveAt && s.pending_effective_at) effectiveAt = s.pending_effective_at;
    const line = {
      serviceId: s.service_id || s.description || 'service',
      description: s.description || '',
      current: cur,
      pending: pen,
      delta: pen - cur,
      strategy: s.pending_uplift_strategy || 'inflation',
    };
    if (isCostPassThrough(line.serviceId)) buckets.passThrough.push(line);
    else if (line.strategy === 'manual') buckets.manual.push(line);
    else buckets.inflation.push(line);
  }
  for (const k of Object.keys(buckets)) buckets[k].sort((a, b) => b.delta - a.delta);

  const totalDelta = newMonthly - currentMonthly;
  const annualisedDelta = totalDelta * 12;

  const subject = `Almond Valley — fee review for ${clientName}`;

  const greeting = contactName ? `Dear ${contactName},` : `Dear ${clientName},`;

  const lines = [];
  lines.push(greeting);
  lines.push('');
  lines.push(`Our annual fee review for ${effectiveAt ? formatLongDate(effectiveAt) : 'the upcoming year'} is complete. Below is a breakdown of the adjustments to your monthly fees.`);
  lines.push('');

  if (buckets.manual.length) {
    lines.push('Changes to fees or services');
    lines.push('—'.repeat(28));
    for (const l of buckets.manual) {
      lines.push(`• ${l.serviceId}: ${fmt(l.current)} → ${fmt(l.pending)} per month (${fmtSigned(l.delta)})`);
    }
    lines.push('');
    lines.push('These reflect changes to the scope of work or a deliberate re-pricing on our part.');
    lines.push('');
  }

  if (buckets.passThrough.length) {
    lines.push('Pass-through cost adjustments');
    lines.push('—'.repeat(28));
    for (const l of buckets.passThrough) {
      lines.push(`• ${l.serviceId}: ${fmt(l.current)} → ${fmt(l.pending)} per month (${fmtSigned(l.delta)})`);
    }
    lines.push('');
    lines.push('These items are paid by us to third parties on your behalf (software licences and statutory filing fees, for example). We pass on the cost change without margin.');
    lines.push('');
  }

  if (buckets.inflation.length) {
    lines.push('Inflation adjustment');
    lines.push('—'.repeat(28));
    for (const l of buckets.inflation) {
      lines.push(`• ${l.serviceId}: ${fmt(l.current)} → ${fmt(l.pending)} per month (${fmtSigned(l.delta)})`);
    }
    lines.push('');
    lines.push('This brings our recurring fees in line with rising salary, regulatory and operating costs. We aim to keep increases modest and predictable.');
    lines.push('');
  }

  lines.push('Summary');
  lines.push('—'.repeat(28));
  lines.push(`Current monthly fees:  ${fmt(currentMonthly)}`);
  lines.push(`New monthly fees:      ${fmt(newMonthly)}`);
  lines.push(`Change per month:      ${fmtSigned(totalDelta)}`);
  lines.push(`Change per year:       ${fmtSigned(annualisedDelta)}`);
  if (effectiveAt) lines.push(`Effective from:        ${formatLongDate(effectiveAt)}`);
  lines.push('');
  lines.push('If you have any questions about these changes please reply to this email and we will be happy to discuss them with you.');
  lines.push('');
  lines.push('Kind regards,');
  lines.push('Almond Valley Accounting');

  return {
    subject,
    body: lines.join('\n'),
    summary: { currentMonthly, newMonthly, totalDelta, annualisedDelta, effectiveAt, buckets },
  };
}

function formatLongDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
}
