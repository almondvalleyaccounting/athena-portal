// The covering email for a single-client fee change. Two kinds:
//
//   notice    — we're telling the client their fees change. Short and
//               simple (2026-09-27): why, when, a table of each service
//               now and new, and no attachment.
//   proposal  — the same, plus new services the client must accept in
//               writing (Part 2); Part 1 goes ahead either way. Keeps the
//               PDF letter, the summary table and the accept button.
//
// Returns { subject, body, bodyHtml }.

import { OUR_FEES_FOOTNOTE, componentsOf, changeLabel, clientServiceName, longDate, summaryRows } from './repriceReasons';

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

// Does any line carry an inflation rise? The "we last reviewed your fees"
// sentence only makes sense when one does.
export function hasInflationRise(lines) {
  return (lines || []).some((l) => componentsOf(l).some((c) => c.reasonKey === 'inflation' && c.amount > 0));
}

// The opening of a proposal, in the practice's own words (2026-09-26),
// shared by the letter and the covering email. Optional additions only
// when true: when we last reviewed the fees (with an inflation rise), and
// that the client asked about the new services.
export function proposalOpening({ when, current, next, clientRequested = false, lastReviewed = null }) {
  return [
    'Please see below the proposed new fees for our services. This proposal is in two parts.',
    `Part 1 is a change to our fees as a result of inflation and / or because your business has evolved and the work required from our side has therefore changed.${lastReviewed ? ` We last reviewed your fees in ${lastReviewed}.` : ''}`,
    `Part 2 is a quote for additional services we can provide${clientRequested ? ', which you asked us about' : ''}.`,
    `If you accept the new services by clicking the link, your monthly fee will go from ${money(current)} to ${money(next)} plus VAT from ${when}.`,
    'As ever, please get in touch if you have any questions or would like to discuss any of these changes.',
  ];
}

// "a", "a and b", "a, b and c".
const listOf = (xs) => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);
const capital = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
const sentence = (s) => { const t = String(s || '').trim(); return !t ? '' : /[.!?]$/.test(t) ? capital(t) : `${capital(t)}.`; };

// How each reason reads inside the "why" paragraph.
const GROWTH = {
  turnover: 'your turnover has increased',
  employees: 'you now have more employees on the payroll',
  transactions: 'there are more transactions to process',
  complexity: 'your affairs have become more complex',
  vat_registered: 'you are now VAT registered',
  paye_registered: 'you are now registered for PAYE',
};
const SHRINK = {
  less_work: 'less work is needed than before',
  turnover_down: 'your turnover has fallen',
  fewer_employees: 'you have fewer employees on the payroll',
  fewer_transactions: 'there are fewer transactions to process',
};
const PASSED_ON = {
  ch_fee: 'Companies House has increased its fees',
  software: 'the cost of software we pay for on your behalf has changed',
};

// Why the fees are changing, written from the reasons on the lines — so it
// is only ever what is true for this client. Staff can still edit it.
//   "We have reviewed our fees. The changes are due to inflation, and because
//    your business has changed since we last reviewed them in March 2024:
//    your turnover has increased and you are now VAT registered. Companies
//    House has also increased its fees, which we pass on at cost."
export function reasonParagraph(lines, { lastReviewed = null } = {}) {
  const comps = (lines || []).flatMap((l) => componentsOf(l).map((c) => ({ ...c, line: l })));
  const has = (k) => comps.some((c) => c.reasonKey === k);
  const uniq = (xs) => [...new Set(xs.filter(Boolean))];
  const inflation = comps.some((c) => c.reasonKey === 'inflation' && c.amount > 0);
  const growth = uniq(comps.filter((c) => c.amount > 0).map((c) => GROWTH[c.reasonKey]));
  const shrink = uniq(comps.filter((c) => c.amount < 0).map((c) => SHRINK[c.reasonKey]));
  const passed = uniq(comps.filter((c) => c.bucket === 'passedOn').map((c) => PASSED_ON[c.reasonKey]));
  const nowBilled = uniq(comps.filter((c) => c.bucket === 'nowBilled').map((c) => clientServiceName(c.line.serviceId)));
  const others = uniq(comps.filter((c) => c.reasonKey === 'other').map((c) => c.otherText));
  const since = `since we last reviewed them${lastReviewed ? ` in ${lastReviewed}` : ''}`;

  const out = ['We have reviewed our fees.'];
  if (inflation && growth.length) out.push(`The changes are due to inflation, and because your business has changed ${since}: ${listOf(growth)}.`);
  else if (inflation) out.push(`The changes are due to inflation${lastReviewed ? ` since we last reviewed them in ${lastReviewed}` : ''}.`);
  else if (growth.length) out.push(`The changes are because your business has changed ${since}: ${listOf(growth)}.`);
  // "also" once: on the first extra sentence after the main reason.
  let alsoLeft = out.length > 1;
  const also = () => { const w = alsoLeft ? ' also' : ''; alsoLeft = false; return w; };
  if (shrink.length) out.push(`Some fees have come down because ${listOf(shrink)}.`);
  if (has('standard_rate')) out.push('We have brought some fees into line with our standard rates.');
  if (has('goodwill')) out.push('We have applied a goodwill reduction.');
  if (nowBilled.length) out.push(`We are${also()} now billing monthly for work we already do for you: ${listOf(nowBilled)}.`);
  if (has('split')) out.push('We have split some fees into separate services, so you can see what each one costs.');
  if (comps.some((c) => c.bucket === 'removed')) out.push('Services you no longer need have been removed.');
  if (passed.length) {
    const w = also();
    out.push(`${capital(listOf(passed))}, which we pass on at cost.`.replace(/^Companies House has increased/, `Companies House has${w} increased`));
  }
  others.forEach((t) => out.push(sentence(t)));
  return out.join(' ');
}

// A first draft of the covering note. Staff edit it in the modal.
// clientRequested: the client asked for the new services (a thank-you).
// lastReviewed: "March 2024", when we last reviewed their fees.
export function defaultCoveringText({ kind = 'notice', contactName, clientName, effectiveAt, lines, summary, clientRequested = false, lastReviewed = null }) {
  const when = effectiveAt ? longDate(effectiveAt) : 'next month';
  const from = money(summary.current);
  const to = money(summary.next);
  const paras = [`Dear ${contactName || clientName},`];
  const reviewed = lastReviewed && hasInflationRise(lines)
    ? `We last reviewed your fees in ${lastReviewed}. Our costs have risen with inflation since then`
    : null;

  if (kind === 'proposal') {
    const opening = proposalOpening({ when, current: summary.current, next: summary.next, clientRequested, lastReviewed: reviewed ? lastReviewed : null });
    // The letter's words, with the table and the button in the email.
    paras.push(...opening.slice(0, 4));
    paras.push('The table below sums it up. The changes in Part 1 go ahead either way.');
    paras.push(opening[4]);
    return paras.join('\n\n');
  }
  // A fee review: why, then when and how much. The table and the closing
  // line follow automatically.
  paras.push(reasonParagraph(lines, { lastReviewed }));
  paras.push(`Starting from your next invoice on ${when}, your monthly fee will change from ${from} to ${to} plus VAT. Here's the detail:`);
  return paras.join('\n\n');
}

export function composeRepriceEmail({ kind = 'notice', clientName, coveringText, effectiveAt, summary, acceptUrl = null, lines = [], senderName = null }) {
  if (kind !== 'proposal') return composeNoticeEmail({ clientName, coveringText, effectiveAt, summary, lines, senderName });
  const when = effectiveAt ? longDate(effectiveAt) : 'next month';
  const subject = kind === 'proposal'
    ? `Proposed changes to your services from ${when} — ${clientName}`
    : `Your fees from ${when} — ${clientName}`;
  // Rows that are zero say nothing — the letter drops them too.
  const all = summaryRows(summary, kind).filter((r) => r.type !== 'step' || r.v !== 0);
  const rows = all.filter((r, i) => r.type !== 'section' || (all[i + 1] && all[i + 1].type === 'step'));
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
    ...(senderName ? [senderName] : []),
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

// ─── The fee review email ────────────────────────────────────────────
// Plain and short: the covering note (why, when, how much), a table of
// each service now and from the change, VAT, the monthly total, the
// footnote, "you don't need to do anything", signed by the sender.
const NOTICE_CLOSE = "You don't need to do anything. If you have any questions, just reply to this email.";

function whyOf(l) {
  if (Number(l.current) === Number(l.next)) return '';
  const labels = componentsOf(l).map(changeLabel).filter(Boolean);
  return labels.map((t, i) => (i === 0 ? t : t.charAt(0).toLowerCase() + t.slice(1))).join(', ');
}

function composeNoticeEmail({ clientName, coveringText, effectiveAt, summary, lines, senderName }) {
  const when = effectiveAt ? longDate(effectiveAt) : 'next month';
  const short = effectiveAt
    ? new Date(effectiveAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
    : 'next month';
  const subject = `Your fees from ${when} — ${clientName}`;
  const rows = (lines || []).filter((l) => (Number(l.current) || 0) !== 0 || (Number(l.next) || 0) !== 0)
    .map((l) => ({ name: clientServiceName(l.serviceId), why: whyOf(l), now: Number(l.current) || 0, next: Number(l.next) || 0 }));
  const vatNow = Math.round(summary.current * 0.2 * 100) / 100;
  const star = rows.some((r) => r.next > r.now);

  // ─── Plain text ───
  const pad = (s, n) => (s.length >= n ? s : s + ' '.repeat(n - s.length));
  const padR = (s, n) => (s.length >= n ? s : ' '.repeat(n - s.length) + s);
  const line = (a, b, c) => pad(a, 44) + padR(b, 12) + padR(c, 14);
  const text = [
    coveringText.trim(),
    '',
    line('', 'Now', `From ${short}`),
    ...rows.flatMap((r) => [line(r.name, money(r.now), money(r.next)), ...(r.why ? [`  ${r.why}`] : [])]),
    line('Monthly fee (excl. VAT)', money(summary.current), money(summary.next)),
    line('VAT at 20%', money(vatNow), money(summary.vat)),
    line('Monthly total', money(summary.current + vatNow), money(summary.gross)),
    ...(star ? ['', OUR_FEES_FOOTNOTE] : []),
    '',
    NOTICE_CLOSE,
    '',
    'Kind regards,',
    ...(senderName ? [senderName] : []),
    'Almond Valley Accounting',
  ].join('\n');

  // ─── HTML ───
  const td = 'padding:9px 12px;font-size:14px;border-bottom:1px solid #eef2f6;vertical-align:top;';
  const num = 'text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap;';
  const th = 'padding:9px 12px;font-size:11px;font-weight:600;letter-spacing:0.06em;text-transform:uppercase;color:#64748b;border-bottom:1px solid #e5e9ef;';
  const body = rows.map((r) => `<tr>
      <td style="${td}color:#1f2937;">${esc(r.name)}${r.why ? `<div style="font-size:12px;color:#64748b;margin-top:2px;">${esc(r.why)}</div>` : ''}</td>
      <td style="${td}${num}color:#64748b;">${esc(money(r.now))}</td>
      <td style="${td}${num}color:#0f172a;">${esc(money(r.next))}</td>
    </tr>`).join('');
  const total = (label, a, b, style) => `<tr style="${style.row || ''}"><td style="${td}${style.cell}">${label}</td><td style="${td}${num}${style.cell}">${esc(money(a))}</td><td style="${td}${num}${style.cell}">${esc(money(b))}</td></tr>`;
  const paras = coveringText.trim().split(/\n{2,}/).map((p) =>
    `<p style="margin:0 0 14px;font-size:15px;line-height:1.6;color:#1f2937;">${esc(p).replace(/\n/g, '<br/>')}</p>`
  ).join('');

  const bodyHtml = `<!DOCTYPE html>
<html>
<body style="margin:0;padding:0;background:#f3f5f8;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f3f5f8;padding:24px 12px;">
    <tr><td align="center">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:12px;overflow:hidden;border:1px solid #e5e9ef;">
        <tr><td style="padding:18px 28px;border-bottom:3px solid #193a50;">
          <img src="https://portal.almondvalleyaccounting.co.uk/ava-logo.jpg" width="38" height="38" alt="" style="vertical-align:middle;border-radius:6px;" />
          <span style="vertical-align:middle;margin-left:10px;font-size:13px;font-weight:600;letter-spacing:0.08em;color:#193a50;">ALMOND VALLEY ACCOUNTING</span>
        </td></tr>
        <tr><td style="padding:24px 28px 4px;">${paras}</td></tr>
        <tr><td style="padding:0 28px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;border:1px solid #e5e9ef;">
            <thead><tr style="background:#f8fafc;">
              <th align="left" style="${th}">Service</th>
              <th align="right" style="${th}">Now</th>
              <th align="right" style="${th}">From ${esc(short)}</th>
            </tr></thead>
            <tbody>
              ${body}
              ${total('Monthly fee (excl. VAT)', summary.current, summary.next, { row: 'background:#f4f8fb;', cell: 'font-weight:700;color:#0f172a;' })}
              ${total('VAT at 20%', vatNow, summary.vat, { cell: 'color:#475569;' })}
              ${total('Monthly total', summary.current + vatNow, summary.gross, { row: 'background:#193a50;', cell: 'font-weight:700;color:#ffffff;border-bottom:none;' })}
            </tbody>
          </table>
          ${star ? `<p style="margin:10px 0 0;font-size:12px;line-height:1.55;color:#64748b;">${esc(OUR_FEES_FOOTNOTE)}</p>` : ''}
        </td></tr>
        <tr><td style="padding:18px 28px 4px;">
          <p style="margin:0;font-size:15px;line-height:1.6;color:#1f2937;">${esc(NOTICE_CLOSE)}</p>
        </td></tr>
        <tr><td style="padding:14px 28px 24px;">
          <p style="margin:0;font-size:15px;color:#1f2937;">Kind regards,</p>
          ${senderName ? `<p style="margin:0;font-size:15px;color:#1f2937;font-weight:600;">${esc(senderName)}</p>` : ''}
          <p style="margin:0;font-size:13px;color:#64748b;">Almond Valley Accounting</p>
        </td></tr>
        <tr><td style="background:#f8fafc;padding:12px 28px;border-top:1px solid #eef2f6;font-size:11px;color:#94a3b8;line-height:1.5;">
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
