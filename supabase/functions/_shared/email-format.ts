// Shared email-rendering helpers. Used by send-quote-email and accept-quote.
// Keep pure — no Deno.env reads here, no I/O.

export function escapeHtml(s: string): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function formatGBP(n: number | string | null | undefined): string {
  const v = Number(n);
  if (!Number.isFinite(v)) return "\u00A30.00";
  return (
    "\u00A3" +
    v.toLocaleString("en-GB", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })
  );
}

// Rounds to whole pence. Use before any figure a client might check with a
// calculator, so 12 x the monthly Direct Debit ties exactly to the annual
// total we quote.
export function money(n: number | string | null | undefined): number {
  const v = Number(n);
  if (!Number.isFinite(v)) return 0;
  return Math.round(v * 100) / 100;
}

export function formatDateGB(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

export function formatDateTimeGB(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  const date = d.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
  });
  const time = d.toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  return `${date} at ${time}`;
}

// ---- Quote line-items breakdown -----------------------------------------
// Used in:
//   - send-quote-email  (quote email to client)
//   - accept-quote       (internal notification to AVA on acceptance)

export type LineItem = {
  description: string | null;
  annual_amount: number | string | null;
  is_recurring: boolean | null;
  service_id: string | null;
  sort_order: number | null;
};

/**
 * Render an HTML <tr> block containing a breakdown table of line items,
 * grouped the same way the PDF does: recurring accountancy / software /
 * one-off setup fees. Returns empty string if there are no items.
 *
 * Figures shown net of VAT.
 */
export function renderBreakdownHtml(lineItems: LineItem[]): string {
  const recurring = lineItems.filter(
    (l) => l.is_recurring && !(l.service_id ?? "").startsWith("software"),
  );
  const software = lineItems.filter((l) =>
    (l.service_id ?? "").startsWith("software"),
  );
  const setup = lineItems.filter((l) => !l.is_recurring);

  if (!recurring.length && !software.length && !setup.length) return "";

  const row = (
    label: string,
    annual: number,
    opts: { bold?: boolean } = {},
  ) => {
    const monthly = annual / 12;
    const weight = opts.bold ? "600" : "400";
    const labelColor = opts.bold ? "#0f172a" : "#1e293b";
    return `
      <tr>
        <td style="padding:8px 14px;color:${labelColor};font-weight:${weight};border-top:1px solid #f1f5f9;">
          ${escapeHtml(label)}
        </td>
        <td style="padding:8px 14px;color:#0f172a;text-align:right;border-top:1px solid #f1f5f9;font-weight:${weight};white-space:nowrap;">
          ${formatGBP(annual)}
        </td>
        <td style="padding:8px 14px;color:#0f172a;text-align:right;border-top:1px solid #f1f5f9;font-weight:${weight};white-space:nowrap;">
          ${formatGBP(monthly)}
        </td>
      </tr>`;
  };

  const sectionHeader = (label: string) => `
    <tr style="background:#f8fafc;">
      <td colspan="3" style="padding:10px 14px;font-weight:600;color:#0f172a;border-top:1px solid #e5e7eb;">
        ${escapeHtml(label)}
      </td>
    </tr>
    <tr style="background:#f8fafc;">
      <td style="padding:6px 14px;font-size:11px;color:#94a3b8;font-weight:500;letter-spacing:0.05em;text-transform:uppercase;">Service</td>
      <td style="padding:6px 14px;font-size:11px;color:#94a3b8;font-weight:500;letter-spacing:0.05em;text-transform:uppercase;text-align:right;">Annual (net)</td>
      <td style="padding:6px 14px;font-size:11px;color:#94a3b8;font-weight:500;letter-spacing:0.05em;text-transform:uppercase;text-align:right;">Monthly (net)</td>
    </tr>`;

  let rows = "";

  if (recurring.length) {
    rows += sectionHeader("Recurring services");
    for (const l of recurring) {
      const annual = Number(l.annual_amount) || 0;
      if (annual <= 0) continue;
      rows += row(l.description ?? "", annual);
    }
    const total = recurring.reduce(
      (s, l) => s + (Number(l.annual_amount) || 0),
      0,
    );
    rows += row("Total accountancy", total, { bold: true });
  }

  if (software.length) {
    rows += sectionHeader("Software");
    for (const l of software) {
      const annual = Number(l.annual_amount) || 0;
      if (annual <= 0) continue;
      rows += row(l.description ?? "", annual);
    }
  }

  if (setup.length) {
    const setupTotal = setup.reduce(
      (s, l) => s + (Number(l.annual_amount) || 0),
      0,
    );
    rows += `
      <tr style="background:#f8fafc;">
        <td colspan="3" style="padding:10px 14px;font-weight:600;color:#0f172a;border-top:1px solid #e5e7eb;">
          One-off setup fees
        </td>
      </tr>`;
    for (const l of setup) {
      const amt = Number(l.annual_amount) || 0;
      if (amt <= 0) continue;
      rows += `
        <tr>
          <td style="padding:8px 14px;color:#1e293b;border-top:1px solid #f1f5f9;">${escapeHtml(l.description ?? "")}</td>
          <td colspan="2" style="padding:8px 14px;color:#0f172a;border-top:1px solid #f1f5f9;text-align:right;white-space:nowrap;">${formatGBP(amt)}</td>
        </tr>`;
    }
    rows += `
      <tr>
        <td style="padding:8px 14px;color:#0f172a;font-weight:600;border-top:1px solid #f1f5f9;">Total setup fees</td>
        <td colspan="2" style="padding:8px 14px;color:#0f172a;font-weight:600;border-top:1px solid #f1f5f9;text-align:right;white-space:nowrap;">${formatGBP(setupTotal)}</td>
      </tr>`;
  }

  return `
    <tr>
      <td style="padding-top:16px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0"
               style="border:1px solid #e5e7eb;border-radius:10px;overflow:hidden;font-size:13px;">
          ${rows}
        </table>
        <div style="font-size:11px;color:#94a3b8;margin-top:8px;">
          Figures shown net of VAT. Monthly Direct Debit in the summary above is inclusive of VAT.
        </div>
      </td>
    </tr>`;
}

// ---- Group breakdown (by company, by service) ---------------------------
// Used by send-quote-email (group quote to client) and accept-quote (group
// acceptance notification). Renders one section per company with its service
// lines, a per-company subtotal, then a group total. Figures net of VAT.

export type GroupCompany = {
  name: string;
  lineItems: LineItem[];
};

export function renderGroupBreakdownHtml(companies: GroupCompany[]): string {
  if (!companies.length) return "";

  const serviceRow = (label: string, annual: number, bold = false) => {
    const monthly = annual / 12;
    const weight = bold ? "600" : "400";
    return `
      <tr>
        <td style="padding:8px 14px;color:${bold ? "#0f172a" : "#1e293b"};font-weight:${weight};border-top:1px solid #f1f5f9;">${escapeHtml(label)}</td>
        <td style="padding:8px 14px;color:#0f172a;text-align:right;border-top:1px solid #f1f5f9;font-weight:${weight};white-space:nowrap;">${formatGBP(annual)}</td>
        <td style="padding:8px 14px;color:#0f172a;text-align:right;border-top:1px solid #f1f5f9;font-weight:${weight};white-space:nowrap;">${formatGBP(monthly)}</td>
      </tr>`;
  };

  let groupAnnual = 0;
  let sections = "";

  for (const company of companies) {
    const items = (company.lineItems || []).filter(
      (l) => (Number(l.annual_amount) || 0) > 0,
    );
    const companyAnnual = items.reduce((s, l) => s + (Number(l.annual_amount) || 0), 0);
    groupAnnual += companyAnnual;

    // Company header + column captions.
    sections += `
      <tr style="background:#eff6ff;">
        <td colspan="3" style="padding:10px 14px;font-weight:600;color:#0f172a;border-top:2px solid #dbeafe;">${escapeHtml(company.name)}</td>
      </tr>
      <tr style="background:#f8fafc;">
        <td style="padding:6px 14px;font-size:11px;color:#94a3b8;font-weight:500;letter-spacing:0.05em;text-transform:uppercase;">Service</td>
        <td style="padding:6px 14px;font-size:11px;color:#94a3b8;font-weight:500;letter-spacing:0.05em;text-transform:uppercase;text-align:right;">Annual (net)</td>
        <td style="padding:6px 14px;font-size:11px;color:#94a3b8;font-weight:500;letter-spacing:0.05em;text-transform:uppercase;text-align:right;">Monthly (net)</td>
      </tr>`;
    if (items.length === 0) {
      sections += `<tr><td colspan="3" style="padding:8px 14px;color:#94a3b8;border-top:1px solid #f1f5f9;">No priced services.</td></tr>`;
    } else {
      for (const l of items) sections += serviceRow(l.description ?? "", Number(l.annual_amount) || 0);
      sections += serviceRow(`Subtotal — ${company.name}`, companyAnnual, true);
    }
  }

  // Group grand total.
  sections += `
    <tr style="background:#0f172a;">
      <td style="padding:12px 14px;color:#ffffff;font-weight:700;">Group total</td>
      <td style="padding:12px 14px;color:#ffffff;text-align:right;font-weight:700;white-space:nowrap;">${formatGBP(groupAnnual)}</td>
      <td style="padding:12px 14px;color:#ffffff;text-align:right;font-weight:700;white-space:nowrap;">${formatGBP(groupAnnual / 12)}</td>
    </tr>`;

  return `
    <tr>
      <td style="padding-top:16px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0"
               style="border:1px solid #e5e7eb;border-radius:10px;overflow:hidden;font-size:13px;">
          ${sections}
        </table>
        <div style="font-size:11px;color:#94a3b8;margin-top:8px;">
          Figures shown net of VAT. Monthly Direct Debit in the summary above is inclusive of VAT.
        </div>
      </td>
    </tr>`;
}
