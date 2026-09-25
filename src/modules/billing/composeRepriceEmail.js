// The covering email for a single-client fee change. Two kinds:
//
//   notice    — we're telling the client their fees change
//   proposal  — the same, plus new services the client must accept in
//               writing (Part 2); Part 1 goes ahead either way
//
// The PDF letter carries the detail; the email carries a short covering
// note (editable) and the summary table from summaryRows(), so the two
// can't disagree. Returns { subject, body, bodyHtml }.

import { OUR_FEES_FOOTNOTE, longDate, reasonText, summaryRows } from './repriceReasons';

const money = (n) => `£${Math.abs(Number(n) || 0).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const signed = (n) => (Number(n) > 0 ? `+${money(n)}` : Number(n) < 0 ? `−${money(n)}` : '—');

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export const KIND_TITLE = {
  notice: 'Your fee review',
  proposal: 'Proposed changes to your services',
};

// A first draft of the covering note. Staff edit it in the modal.
export function defaultCoveringText({ kind = 'notice', contactName, clientName, effectiveAt, lines, summary }) {
  const when = effectiveAt ? longDate(effectiveAt) : 'next month';
  const from = money(summary.current);
  const to = money(summary.next);
  const reasons = [...new Set(lines.filter((l) => Number(l.current) !== Number(l.next)).map(reasonText).filter(Boolean))];
  const paras = [`Dear ${contactName || clientName},`];

  if (kind === 'proposal') {
    paras.push(`From ${when} we're making some changes to your fees (Part 1), and we'd like to add some new services (Part 2). If you accept, your monthly fee will go from ${from} to ${to}, plus VAT.`);
    paras.push('The table below sums it up and the attached letter has the detail.');
    paras.push("To accept the new services, click Review and accept below. We won't add them until you do. The changes in Part 1 go ahead either way.");
  } else {
    paras.push(`From ${when}, your monthly fee will go from ${from} to ${to}, plus VAT.`);
    if (reasons.length === 1) paras.push(`This is because of: ${reasons[0].charAt(0).toLowerCase()}${reasons[0].slice(1)}.`);
    else if (reasons.length > 1) paras.push(`This is because of:\n${reasons.map((r) => `• ${r}`).join('\n')}`);
    paras.push("The table below sums it up and the attached letter has the detail. You don't need to do anything.");
  }
  paras.push('If you have any questions, just reply to this email.');
  return paras.join('\n\n');
}

export function composeRepriceEmail({ kind = 'notice', clientName, coveringText, effectiveAt, summary, acceptUrl = null }) {
  const when = effectiveAt ? longDate(effectiveAt) : 'next month';
  const subject = kind === 'proposal'
    ? `Proposed changes to your services from ${when} — ${clientName}`
    : `Your fees from ${when} — ${clientName}`;
  const rows = summaryRows(summary, kind);
  const cell = (r, v) => (r.type === 'step' ? signed(v) : money(v));

  // ─── Plain text ───
  const pad = (s, n) => (s.length >= n ? s : s + ' '.repeat(n - s.length));
  const padR = (s, n) => (s.length >= n ? s : ' '.repeat(n - s.length) + s);
  const text = [
    coveringText.trim(),
    '',
    pad('', 44) + padR('Per month', 14) + padR('Per year', 14),
    ...rows.map((r) => (r.type === 'section'
      ? `\n${r.label}`
      : pad(`${r.type === 'step' ? '  ' : ''}${r.label}${r.star ? ' *' : ''}`, 44)
        + padR(cell(r, r.v).replace('−', '-'), 14) + padR(cell(r, r.v * 12).replace('−', '-'), 14))),
    '',
    `* ${OUR_FEES_FOOTNOTE}`,
    ...(kind === 'proposal' ? ['', `Review and accept: ${acceptUrl || '[your link appears here once issued]'}`] : []),
    '',
    'Kind regards,',
    'Almond Valley Accounting',
  ].join('\n');

  // ─── HTML ───
  const td = 'padding:9px 12px;font-size:14px;border-bottom:1px solid #eef2f6;';
  const num = 'text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap;';
  const tableRows = rows.map((r) => {
    if (r.type === 'section') {
      return `<tr><td colspan="3" style="padding:12px 12px 6px;font-size:12px;font-weight:700;letter-spacing:0.03em;color:#193a50;border-bottom:1px solid #e5e9ef;background:#fbfcfd;">${esc(r.label)}</td></tr>`;
    }
    const val = (v) => {
      if (r.type !== 'step') return esc(money(v));
      const colour = v > 0 ? '#9a5b17' : v < 0 ? '#2f855a' : '#94a3b8';
      return `<span style="color:${colour};">${esc(signed(v))}</span>`;
    };
    const label = `${esc(r.label)}${r.star ? '<sup style="color:#1E4560;">*</sup>' : ''}`;
    if (r.type === 'grand') {
      return `<tr style="background:#193a50;"><td style="${td}color:#fff;font-weight:700;border-bottom:none;">${label}</td><td style="${td}${num}color:#fff;font-weight:700;border-bottom:none;">${val(r.v)}</td><td style="${td}${num}color:#fff;font-weight:700;border-bottom:none;">${val(r.v * 12)}</td></tr>`;
    }
    const strong = r.type === 'total' || r.type === 'subtotal';
    const weight = strong ? 'font-weight:700;color:#0f172a;' : r.type === 'vat' ? 'color:#475569;' : 'color:#334155;';
    const bg = r.type === 'total' ? 'background:#f4f8fb;' : '';
    const indent = r.type === 'step' ? 'padding-left:24px;' : '';
    return `<tr style="${bg}"><td style="${td}${weight}${indent}">${label}</td><td style="${td}${num}${weight}">${val(r.v)}</td><td style="${td}${num}${weight}">${val(r.v * 12)}</td></tr>`;
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
          <div style="font-family:Georgia,'Playfair Display',serif;font-size:22px;color:#ffffff;">${esc(KIND_TITLE[kind] || KIND_TITLE.notice)}</div>
          <div style="font-size:13px;color:#b9d3e2;margin-top:4px;">${esc(clientName)} · from ${esc(when)}</div>
        </td></tr>
        <tr><td style="padding:28px 32px 8px;">
          ${paras}
        </td></tr>
        <tr><td style="padding:0 32px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;border:1px solid #e5e9ef;border-radius:8px;overflow:hidden;">
            <thead><tr style="background:#f8fafc;">
              <th align="left" style="padding:9px 12px;font-size:11px;font-weight:600;letter-spacing:0.06em;text-transform:uppercase;color:#64748b;border-bottom:1px solid #e5e9ef;">Excluding VAT</th>
              <th align="right" style="padding:9px 12px;font-size:11px;font-weight:600;letter-spacing:0.06em;text-transform:uppercase;color:#64748b;border-bottom:1px solid #e5e9ef;">Per month</th>
              <th align="right" style="padding:9px 12px;font-size:11px;font-weight:600;letter-spacing:0.06em;text-transform:uppercase;color:#64748b;border-bottom:1px solid #e5e9ef;">Per year</th>
            </tr></thead>
            <tbody>${tableRows}</tbody>
          </table>
          <p style="margin:12px 0 0;font-size:12px;line-height:1.55;color:#64748b;"><sup style="color:#1E4560;">*</sup> ${esc(OUR_FEES_FOOTNOTE)}</p>
        </td></tr>
        ${kind === 'proposal' ? `<tr><td align="center" style="padding:24px 32px 4px;">
          <a href="${esc(acceptUrl || '#')}" style="display:inline-block;background:#193a50;color:#ffffff;text-decoration:none;font-weight:600;font-size:15px;padding:13px 28px;border-radius:8px;">Review and accept</a>
          <p style="margin:10px 0 0;font-size:12px;color:#94a3b8;">${acceptUrl ? 'Or copy this link into your browser: ' + esc(acceptUrl) : 'Your link appears here once the proposal is issued.'}</p>
        </td></tr>` : ''}
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
