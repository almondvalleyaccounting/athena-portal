const { Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType, PageBreak } = require("docx");
const fs = require("fs");

const hdr = (t) => new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun({ text: t, bold: true, font: "Arial", size: 28 })] });
const h2 = (t) => new Paragraph({ heading: HeadingLevel.HEADING_2, children: [new TextRun({ text: t, bold: true, font: "Arial", size: 24 })] });
const pr = (t) => new Paragraph({ spacing: { after: 100 }, children: [new TextRun({ text: t, font: "Arial", size: 20 })] });
const pb = () => new Paragraph({ children: [new PageBreak()] });

const doc = new Document({ sections: [{ children: [
  new Paragraph({ spacing: { before: 2000 }, alignment: AlignmentType.CENTER, children: [new TextRun({ text: "ATHENA FEE ENGINE", font: "Arial", size: 48, bold: true, color: "193A50" })] }),
  new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: "Technical Specification v2.0", font: "Arial", size: 28, color: "1E4560" })] }),
  new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: "12 April 2026 | Almond Valley Accounting", font: "Arial", size: 22, color: "888888" })] }),
  pb(),

  hdr("1. Overview"),
  pr("The Athena Fee Engine is a practice management tool for Almond Valley Accounting handling quote creation, pricing management, group billing, client tracking, and live billing commitment. It bridges client onboarding and QuickBooks Online billing. Live at portal.almondvalleyaccounting.co.uk. Tech: React 18 + Vite + Tailwind CSS + Supabase + Vercel."),
  pb(),

  hdr("2. Features Delivered"),
  h2("2.1 Quote Creation"),
  pr("15 configurable service sections: Accounts & CT (turnover band detection), Confirmation Statement, Directors' Tax Returns (multi-director with add-ons), Bookkeeping & VAT Returns, VAT Returns, Payroll (flat + employees + CIS + P11D), Auto-Enrolment, Modulr Wage Payments, Management Accounts, Review Meetings, Budgeting & Forecasting, Fractional CFO, Registered Office, Software (11 platforms + Dext). One-off setup fees. Valid Until (30-day default). Auto-creates client entity on save."),

  h2("2.2 Group Quotes"),
  pr("Groups page with step-by-step client addition (search existing or create new). Cross-tab quote builder with two tables: Drivers cross-tab (turnover, hours, rates, employee counts grouped by service section) and Values cross-tab (auto-calculated from drivers with hover tooltips showing every calculation). Per-entity discounts. Consolidation table. Monthly net/VAT/gross breakdown. Save creates individual quotes per entity linked to the group."),

  h2("2.3 Quote Lifecycle"),
  pr("Draft > Awaiting Approval > Approved > Sent to Client > Accepted > Committed to Live. Permission-gated transitions. Audit trail on every change. Edit/delete on drafts and pending. Re-quote from any status. Batch actions: mass approve, reject, delete, send. Auto-expire with extend option."),

  h2("2.4 Pricing Defaults"),
  pr("Full fee schedule editor at /manage/quotes/pricing. Every rate configurable. Versioned save with optional change notes. Version history. Permission-gated by can_edit_fee_schedule."),

  h2("2.5 PDF Export"),
  pr("Professional A4 layout with AVA logo. Scottish Coast palette. Table: Annual Net | Monthly Net | VAT | Monthly Gross. All Inclusive Monthly Fee headline. Service rows, Total Accountancy Costs, Software, Total Including Software. Setup fees totalled. Quote date + valid until. Company footer: Almond Valley Accounting Limited, 14 Ellismuir House, Ellismuir Way, Tannochside, G71 5PW, info@almondvalleyaccounting.co.uk, 0141 471 4255."),

  h2("2.6 Client Management"),
  pr("Auto-created from quotes (status: prospect). Client detail page with all quotes. Group membership badges. Clickable quote status counts. Inline rename. Status workflow: prospect > onboarding > active > inactive."),

  h2("2.7 Dashboard"),
  pr("Time period filter (This Month, 3/6/12 Months, This Year, All Time). Top-level status filter: Draft, Awaiting Approval, Approved, Sent, Accepted, Pipeline, Rejected. Status cards with volumes and values. Revenue by service: services subtotal, software subtotal, grand total. Previous period comparison with green/red delta. Service multi-select filter. 12-month trend tables (values and volumes). All numbers clickable to drill-down analysis page."),

  h2("2.8 Analysis & Export"),
  pr("Drill-down page at /manage/quotes/analysis. Shows contributing quotes for any clicked dashboard number. Sortable table. Export to Excel (CSV) and PDF. Quotes page: status card filters, group filter, net/gross toggle, multi-add filter chips, export all."),

  h2("2.9 Live Billing"),
  pr("Billing page at /manage/billing. CSV import for initial population. Manual entry. Live vs Quote comparison with delta. Commit to Live modal on accepted quotes: creates live_billing record, upserts entity_fees, generates QBO import CSV. Committed status (teal badge)."),

  h2("2.10 Email Delivery"),
  pr("Send to Client modal with recipient, subject (Services Quote: Client Name), customisable message with expiry date. PDF attached. Status updated to Sent. Requires Supabase Edge Function deployment (send-quote-email via Resend - not yet deployed)."),
  pb(),

  hdr("3. Statuses"),
  pr("Draft (internal, grey) | Awaiting Approval (internal, amber) | Approved (internal, blue) | Sent to Client (purple) | Accepted (green) | Committed to Live (teal) | Rejected (red) | Expired (grey) | Deleted (grey)"),
  pr("Pipeline = Draft + Awaiting Approval + Approved + Sent + Accepted (all active statuses)."),
  pb(),

  hdr("4. Permissions"),
  pr("can_view_quotes: See list, detail, export PDF."),
  pr("can_edit_quotes: Create, edit drafts/pending, submit for approval, re-quote, delete."),
  pr("can_approve_quotes: Approve, reject, mark sent, accept, commit to live."),
  pr("can_edit_fee_schedule: Access pricing defaults, save new versions."),
  pr("can_manage_portal: Portal admin functions."),
  pb(),

  hdr("5. Routes"),
  pr("/ = Dashboard"),
  pr("/manage/clients = Clients | /manage/clients/:id = Client Detail"),
  pr("/manage/quotes = Quotes | /manage/quotes/new = New Quote"),
  pr("/manage/quotes/:id = Quote Detail | /manage/quotes/:id/edit = Edit Quote"),
  pr("/manage/quotes/pricing = Pricing Defaults | /manage/quotes/analysis = Analysis"),
  pr("/manage/groups = Groups"),
  pr("/manage/quotes/group/:id = Group Detail | /manage/quotes/group/:id/quote = Cross-Tab Builder"),
  pr("/manage/billing = Live Billing"),
  pb(),

  hdr("6. Database"),
  pr("Tables: quotes, quote_line_items, quote_defaults, quote_entities, entities, entity_fees, billing_groups, billing_group_members, live_billing, staff_profiles, audit_log."),
  pr("RLS: All tables use is_active_staff() and is_portal_admin() SECURITY DEFINER functions."),
  pr("Supabase project: neksyvneljgxvpchwgch | GitHub: almondvalleyaccounting/athena-portal | Vercel: auto-deploy on push to master."),
  pb(),

  hdr("7. Next Actions"),
  h2("7.1 Immediate"),
  pr("QBO API: OAuth connection via Supabase Edge Function. Pull recurring invoices from QBO to live_billing. Push committed quotes as QBO invoices. Sync monitoring."),
  h2("7.2 Short Term"),
  pr("Deploy email Edge Function (Resend). Editable email templates. Accept quote link in PDF. Approval notifications."),
  h2("7.3 Medium Term"),
  pr("Client portal for self-service. Billing variance alerts. Automated expiry. Management pack reporting."),
  h2("7.4 Long Term"),
  pr("Full QBO two-way sync. Billing change workflows. Revenue forecasting. BrightManager entity sync. Module extraction for Athena shell."),
  pb(),

  hdr("8. Infrastructure Notes"),
  pr("Supabase fixes: Dropped orphaned trigger, fixed recursive RLS (SECURITY DEFINER functions), fixed RLS on all tables, dropped constraints, seeded defaults, added columns, created live_billing table."),
  pr("Environment: Supabase neksyvneljgxvpchwgch, Vercel athena-portal, GitHub almondvalleyaccounting/athena-portal (public), portal.almondvalleyaccounting.co.uk."),
]}]});

Packer.toBuffer(doc).then(buf => {
  fs.writeFileSync("C:/Users/bobby/Downloads/Athena_FeeEngine_Spec_v2.docx", buf);
  console.log("Spec created: C:/Users/bobby/Downloads/Athena_FeeEngine_Spec_v2.docx");
});
