// The covering email for a single-client fee review. The PDF letter
// carries the detail and the waterfall; the email carries the staff-
// written covering note and one summary table:
//
//   Current fees
//   Increases in our fees *
//   New services
//   Services removed
//   Costs passed on
//   Other
//   New fees (net of VAT)
//   VAT at 20%
//   Total including VAT
//
// with the footnote under it. Returns { subject, body, bodyHtml }.

import { visibleBuckets, OUR_FEES_FOOTNOTE, VAT_RATE, longDate, reasonText } from './repriceReasons';

const money = (n) => `£${Math.abs(Number(n) || 0).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const signed = (n) => (Number(n) > 0 ? `+${money(n)}` : Number(n) < 0 ? `−${money(n)}` : '—');

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// A starting covering note, built from the reasons picked. Staff edit
// it in the modal; this only has to be a sensible first draft.
export function defaultCoveringText({ contactName, clientName, effectiveAt, lines, summary }) {
  const changed = lines.filter((l) => Number(l.current) !== Number(l.next));
  const reasons = [...new Set(changed.map(reasonText).filter(Boolean))];
  const dir = summary.delta > 0 ? 'increase' : summary.delta < 0 ? 'reduce' : 'change';
  const paras = [
    `Dear ${contactName || clientName},`,
    `We have been reviewing the fees for ${clientName}${effectiveAt ? `, and from ${longDate(effectiveAt)}` : ' and'} your monthly fee will ${dir} from ${money(summary.current)} to ${money(summary.next)} plus VAT.`,
  ];
  if (reasons.length === 1) {
    paras.push(`The reason for the change: ${reasons[0].charAt(0).toLowerCase()}${reasons[0].slice(1)}.`);
  } else if (reasons.length > 1) {
    paras.push(`The change comes from the following:\n${reasons.map((r) => `• ${r}`).join('\n')}`);
  }
  paras.push('The table below summarises the change, and the attached letter sets it out service by service. There is nothing you need to do — the new amount will simply appear on your invoices from that date.');
  paras.push('If you have any questions at all, just reply to this email and we will be happy to talk it through.');
  return paras.join('\n\n');
}

export function composeRepriceEmail({ clientName, coveringText, effectiveAt, summary }) {
  const subject = `Your fees from ${effectiveAt ? longDate(effectiveAt) : 'next month'} — ${clientName}`;

  const rows = [
    { label: 'Current fees', v: summary.current, kind: 'total' },
    ...visibleBuckets(summary).map((b) => ({ label: b.label, v: summary.buckets[b.key], kind: 'step', star: b.star })),
    { label: 'New fees (net of VAT)', v: summary.next, kind: 'total' },
    { label: `VAT at ${Math.round(VAT_RATE * 100)}%`, v: summary.vat, kind: 'vat' },
    { label: 'Total including VAT', v: summary.gross, kind: 'grand' },
  ];

  // ─── Plain text ───
  const pad = (s, n) => (s.length >= n ? s : s + ' '.repeat(n - s.length));
  const padR = (s, n) => (s.length >= n ? s : ' '.repeat(n - s.length) + s);
  const fmtCell = (r, v) => (r.kind === 'step' ? signed(v).replace('−', '-') : money(v));
  const text = [
    coveringText.trim(),
    '',
    pad('', 36) + padR('Per month', 14) + padR('Per year', 14),
    ...rows.map((r) => pad(r.label + (r.star ? ' *' : ''), 36) + padR(fmtCell(r, r.v), 14) + padR(fmtCell(r, r.v * 12), 14)),
    '',
    `* ${OUR_FEES_FOOTNOTE}`,
    '',
    'Kind regards,',
    'Almond Valley Accounting',
  ].join('\n');

  // ─── HTML ───
  const td = 'padding:9px 12px;font-size:14px;border-bottom:1px solid #eef2f6;';
  const num = 'text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap;';
  const tableRows = rows.map((r) => {
    const cell = (v) => {
      if (r.kind !== 'step') return esc(money(v));
      const colour = v > 0 ? '#9a5b17' : v < 0 ? '#2f855a' : '#94a3b8';
      return `<span style="color:${colour};">${esc(signed(v))}</span>`;
    };
    const label = `${esc(r.label)}${r.star ? '<sup style="color:#1E4560;">*</sup>' : ''}`;
    if (r.kind === 'grand') {
      return `<tr style="background:#193a50;"><td style="${td}color:#fff;font-weight:700;border-bottom:none;">${label}</td><td style="${td}${num}color:#fff;font-weight:700;border-bottom:none;">${cell(r.v)}</td><td style="${td}${num}color:#fff;font-weight:700;border-bottom:none;">${cell(r.v * 12)}</td></tr>`;
    }
    const weight = r.kind === 'total' ? 'font-weight:700;color:#0f172a;' : r.kind === 'vat' ? 'color:#475569;' : 'color:#334155;';
    const bg = r.kind === 'total' ? 'background:#f4f8fb;' : '';
    const indent = r.kind === 'step' ? 'padding-left:24px;' : '';
    return `<tr style="${bg}"><td style="${td}${weight}${indent}">${label}</td><td style="${td}${num}${weight}">${cell(r.v)}</td><td style="${td}${num}${weight}">${cell(r.v * 12)}</td></tr>`;
  }).join('');

  const paras = coveringText.trim().split(/\n{2,}/).map((p) =>
    `<p style="margin:0 0 14px;font-size:15px;line-height:1.6;color:#1f2937;">${esc(p).replace(/\n/g, '<br/>')}</p>`
  ).join('');

  const bodyHtml = `<!DOCTYPE html>
<html>
<body style="margin:0;padding:0;background:#f3f5f8;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f3f5f8;padding:28px 12px;">
    <tr><td align="center">
      <table role="presentation" width="640" cellpadding="0" cellspacing="0" border="0" style="max-width:640px;width:100%;background:#ffffff;border-radius:12px;overflow:hidden;border:1px solid #e5e9ef;">
        <tr><td style="background:#193a50;padding:22px 32px;">
          <div style="font-family:Georgia,'Playfair Display',serif;font-size:22px;color:#ffffff;">Your fee review</div>
          <div style="font-size:13px;color:#b9d3e2;margin-top:4px;">${esc(clientName)}${effectiveAt ? ` · new fees from ${esc(longDate(effectiveAt))}` : ''}</div>
        </td></tr>
        <tr><td style="padding:28px 32px 8px;">
          ${paras}
        </td></tr>
        <tr><td style="padding:0 32px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;border:1px solid #e5e9ef;border-radius:8px;overflow:hidden;">
            <thead><tr style="background:#f8fafc;">
              <th align="left" style="padding:9px 12px;font-size:11px;font-weight:600;letter-spacing:0.06em;text-transform:uppercase;color:#64748b;border-bottom:1px solid #e5e9ef;">All figures net of VAT</th>
              <th align="right" style="padding:9px 12px;font-size:11px;font-weight:600;letter-spacing:0.06em;text-transform:uppercase;color:#64748b;border-bottom:1px solid #e5e9ef;">Per month</th>
              <th align="right" style="padding:9px 12px;font-size:11px;font-weight:600;letter-spacing:0.06em;text-transform:uppercase;color:#64748b;border-bottom:1px solid #e5e9ef;">Per year</th>
            </tr></thead>
            <tbody>${tableRows}</tbody>
          </table>
          <p style="margin:12px 0 0;font-size:12px;line-height:1.55;color:#64748b;"><sup style="color:#1E4560;">*</sup> ${esc(OUR_FEES_FOOTNOTE)}</p>
        </td></tr>
        <tr><td style="padding:22px 32px 28px;">
          <p style="margin:0 0 4px;font-size:15px;color:#1f2937;">Kind regards,</p>
          <p style="margin:0;font-size:15px;color:#1f2937;font-weight:600;">Almond Valley Accounting</p>
        </td></tr>
        <tr><td style="background:#f8fafc;padding:14px 32px;border-top:1px solid #eef2f6;font-size:11px;color:#94a3b8;line-height:1.5;">
          Almond Valley Accounting Limited · 14 Ellismuir House, Ellismuir Way, Tannochside, G71 5PW<br/>
          info@almondvalleyaccounting.co.uk · 0141 471 4255
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

  return { subject, body: text, bodyHtml };
}
