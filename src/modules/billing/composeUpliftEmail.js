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
//
// Returns { subject, body, bodyHtml, summary }. body is the plain-text
// version (used as fallback for mail clients without HTML), bodyHtml is
// the rendered HTML body with a per-line table.

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

function escHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Bucket-specific copy. Tone: factual, professional, no apologies.
const SECTION_COPY = {
  manual: {
    heading: 'Changes to fees following a service review',
    blurb:
      'These changes follow a review of the work we do for you. Either the service was previously missed from your fee, or the time we spend on it has grown beyond what the existing fee covers. The new figure reflects the work we now provide.',
  },
  passThrough: {
    heading: 'Pass-through cost changes',
    blurb:
      'These items are amounts we pay on your behalf — Companies House confirmation-statement fees and the software licences we use to deliver your service. We pass the change on at cost, with no margin added.',
  },
  inflation: {
    heading: 'Inflation adjustment',
    blurb:
      'We last applied an inflation-based uplift to our fees in 2024. Like any business, our salary, regulatory and operating costs have continued to rise, and we need to revisit pricing periodically to keep pace. We aim to keep any increase modest and predictable.',
  },
};

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

  // ─── Plain text body ─────────────────────────────────────
  const lines = [];
  lines.push(greeting);
  lines.push('');
  lines.push(
    `We have completed our fee review${effectiveAt ? ` for ${formatLongDate(effectiveAt)}` : ''}. ` +
    `Below is a breakdown of the adjustments to your monthly fees, with the reasons for each.`
  );
  lines.push('');

  const renderSection = (key) => {
    const rows = buckets[key];
    if (!rows.length) return;
    lines.push(SECTION_COPY[key].heading);
    lines.push('—'.repeat(48));
    // Plain-text column layout — service / old / new / change.
    const colW = { svc: 30, old: 12, neu: 12, dlt: 12 };
    const head = pad('Service', colW.svc) + padR('Old', colW.old) + padR('New', colW.neu) + padR('Change', colW.dlt);
    lines.push(head);
    for (const r of rows) {
      lines.push(
        pad(r.serviceId, colW.svc)
        + padR(fmt(r.current), colW.old)
        + padR(fmt(r.pending), colW.neu)
        + padR(fmtSigned(r.delta), colW.dlt)
      );
    }
    lines.push('');
    lines.push(SECTION_COPY[key].blurb);
    lines.push('');
  };

  renderSection('manual');
  renderSection('passThrough');
  renderSection('inflation');

  lines.push('Summary');
  lines.push('—'.repeat(48));
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

  const body = lines.join('\n');

  // ─── HTML body ───────────────────────────────────────────
  const bodyHtml = renderHtml({
    greeting,
    effectiveAt,
    buckets,
    currentMonthly,
    newMonthly,
    totalDelta,
    annualisedDelta,
  });

  return {
    subject,
    body,
    bodyHtml,
    summary: { currentMonthly, newMonthly, totalDelta, annualisedDelta, effectiveAt, buckets },
  };
}

function renderHtml({ greeting, effectiveAt, buckets, currentMonthly, newMonthly, totalDelta, annualisedDelta }) {
  const sectionHtml = (key) => {
    const rows = buckets[key];
    if (!rows.length) return '';
    const tableRows = rows.map((r) => {
      const deltaColour = r.delta > 0 ? '#15803d' : r.delta < 0 ? '#b91c1c' : '#475569';
      return `
        <tr>
          <td style="padding:8px 10px;border-bottom:1px solid #f1f5f9;color:#0f172a;font-size:13px;">${escHtml(r.serviceId)}</td>
          <td style="padding:8px 10px;border-bottom:1px solid #f1f5f9;color:#475569;font-size:13px;text-align:right;font-variant-numeric:tabular-nums;">${escHtml(fmt(r.current))}</td>
          <td style="padding:8px 10px;border-bottom:1px solid #f1f5f9;color:#0f172a;font-size:13px;text-align:right;font-variant-numeric:tabular-nums;font-weight:600;">${escHtml(fmt(r.pending))}</td>
          <td style="padding:8px 10px;border-bottom:1px solid #f1f5f9;font-size:13px;text-align:right;font-variant-numeric:tabular-nums;color:${deltaColour};font-weight:600;">${escHtml(fmtSigned(r.delta))}</td>
        </tr>`;
    }).join('');
    return `
      <h3 style="margin:24px 0 4px;font-family:'Playfair Display',Georgia,serif;font-size:17px;font-weight:500;color:#0f172a;">${escHtml(SECTION_COPY[key].heading)}</h3>
      <p style="margin:0 0 10px;color:#475569;font-size:13px;line-height:1.55;">${escHtml(SECTION_COPY[key].blurb)}</p>
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="width:100%;border-collapse:collapse;margin:8px 0 4px;">
        <thead>
          <tr style="background:#f8fafc;">
            <th align="left"  style="padding:8px 10px;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;color:#64748b;border-bottom:1px solid #e5e7eb;">Service</th>
            <th align="right" style="padding:8px 10px;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;color:#64748b;border-bottom:1px solid #e5e7eb;">Old (per month)</th>
            <th align="right" style="padding:8px 10px;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;color:#64748b;border-bottom:1px solid #e5e7eb;">New (per month)</th>
            <th align="right" style="padding:8px 10px;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;color:#64748b;border-bottom:1px solid #e5e7eb;">Change</th>
          </tr>
        </thead>
        <tbody>${tableRows}</tbody>
      </table>`;
  };

  const summaryDeltaColour = totalDelta > 0 ? '#15803d' : totalDelta < 0 ? '#b91c1c' : '#475569';

  return `<!DOCTYPE html>
<html>
<body style="margin:0;padding:24px;background:#fafafa;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','Outfit',sans-serif;color:#0f172a;line-height:1.55;">
  <div style="max-width:640px;margin:0 auto;background:#fff;border:1px solid #e5e7eb;border-radius:10px;padding:28px 32px;">
    <p style="margin:0 0 12px;font-size:14px;">${escHtml(greeting)}</p>
    <p style="margin:0 0 8px;font-size:14px;color:#0f172a;">
      We have completed our fee review${effectiveAt ? ` for ${escHtml(formatLongDate(effectiveAt))}` : ''}. Below is a breakdown of the adjustments to your monthly fees, with the reasons for each.
    </p>
    ${sectionHtml('manual')}
    ${sectionHtml('passThrough')}
    ${sectionHtml('inflation')}

    <h3 style="margin:28px 0 4px;font-family:'Playfair Display',Georgia,serif;font-size:17px;font-weight:500;color:#0f172a;">Summary</h3>
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="width:100%;border-collapse:collapse;margin:6px 0 14px;">
      <tbody>
        <tr><td style="padding:6px 10px;font-size:13px;color:#475569;border-bottom:1px solid #f1f5f9;">Current monthly fees</td><td style="padding:6px 10px;font-size:13px;text-align:right;font-variant-numeric:tabular-nums;color:#0f172a;border-bottom:1px solid #f1f5f9;">${escHtml(fmt(currentMonthly))}</td></tr>
        <tr><td style="padding:6px 10px;font-size:13px;color:#475569;border-bottom:1px solid #f1f5f9;">New monthly fees</td><td style="padding:6px 10px;font-size:13px;text-align:right;font-variant-numeric:tabular-nums;color:#0f172a;font-weight:600;border-bottom:1px solid #f1f5f9;">${escHtml(fmt(newMonthly))}</td></tr>
        <tr><td style="padding:6px 10px;font-size:13px;color:#475569;border-bottom:1px solid #f1f5f9;">Change per month</td><td style="padding:6px 10px;font-size:13px;text-align:right;font-variant-numeric:tabular-nums;color:${summaryDeltaColour};font-weight:600;border-bottom:1px solid #f1f5f9;">${escHtml(fmtSigned(totalDelta))}</td></tr>
        <tr><td style="padding:6px 10px;font-size:13px;color:#475569;${effectiveAt ? 'border-bottom:1px solid #f1f5f9;' : ''}">Change per year</td><td style="padding:6px 10px;font-size:13px;text-align:right;font-variant-numeric:tabular-nums;color:${summaryDeltaColour};font-weight:600;${effectiveAt ? 'border-bottom:1px solid #f1f5f9;' : ''}">${escHtml(fmtSigned(annualisedDelta))}</td></tr>
        ${effectiveAt ? `<tr><td style="padding:6px 10px;font-size:13px;color:#475569;">Effective from</td><td style="padding:6px 10px;font-size:13px;text-align:right;color:#0f172a;">${escHtml(formatLongDate(effectiveAt))}</td></tr>` : ''}
      </tbody>
    </table>

    <p style="margin:18px 0 8px;font-size:14px;color:#475569;line-height:1.55;">
      If you have any questions about these changes please reply to this email and we will be happy to discuss them with you.
    </p>
    <p style="margin:18px 0 0;font-size:14px;color:#0f172a;">Kind regards,<br/>Almond Valley Accounting</p>
  </div>
</body>
</html>`;
}

function pad(s, n)  { s = String(s); return s.length >= n ? s.slice(0, n - 1) + '…' : s + ' '.repeat(n - s.length); }
function padR(s, n) { s = String(s); return s.length >= n ? s.slice(0, n) : ' '.repeat(n - s.length) + s; }

function formatLongDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
}
