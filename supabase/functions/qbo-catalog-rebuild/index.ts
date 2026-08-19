import { getServiceClient, qboFetch, qboQuery, logSync, jsonResponse, corsHeaders } from "../_shared/qbo-client.ts";
import { requireStaffOrService, authErrorResponse } from "../_shared/require-staff.ts";

// Apply the agreed product-catalogue rebuild to QBO: income accounts, the
// grouping items, renames, re-parents, income-account fixes, the new leaves
// and the retirements. Decisions and reasoning are recorded in the crosswalk
// artifact and the checklist workbook (4 Aug 2026).
//
// POST { dry_run: true }            -> the exact payload for every step, no writes
// POST { apply: true, phases: [1] } -> run only those phases
// POST { apply: true }              -> run every phase in order
//
// Deliberately NOT in here: recoding posted invoice lines. That edits issued
// and possibly paid invoices, and re-pointing an item's income account never
// moves an already-posted line, so it has to be done by hand afterwards.
// Merging items is also absent — QBO has no merge API.
//
// Every step is name-resolved against live QBO first, so a re-run after a
// partial failure skips what already exists rather than duplicating it.

type Op =
  | { kind: "create_account"; name: string; subtype?: string }
  | { kind: "rename_account"; from: string; to: string }
  | { kind: "create_item"; name: string; parent?: string; account: string }
  | { kind: "update_item"; id: string; name?: string; parent?: string; account?: string }
  | { kind: "deactivate_item"; id: string; expectName?: string; renameTo?: string }
  | { kind: "reactivate_item"; id: string; name?: string; parent?: string; account?: string };

type Step = { phase: number; label: string; op: Op };

// ── The plan ─────────────────────────────────────────────────────────
// Phase 1 leads: QBO enforces unique item names across the file, so the
// Advisory and Bookkeeping groups cannot be created while items 41 and 43
// hold those names.
//
// These renames are the point of the phase, not cosmetic. QBO appends
// "(deleted)" to an item's name when it goes inactive *in the UI*; relying on
// that happening via the API would be a guess, and if it didn't, phase 3
// would silently skip both grouping items and phase 4 would then attach real
// services underneath two retired junk items. Renaming explicitly makes the
// names free either way.
const PHASE1: Step[] = [
  { phase: 1, label: "Retire auto-created Advisory (frees the name)", op: { kind: "deactivate_item", id: "41", expectName: "Advisory", renameTo: "Advisory (retired)" } },
  { phase: 1, label: "Retire auto-created Bookkeeping (frees the name)", op: { kind: "deactivate_item", id: "43", expectName: "Bookkeeping", renameTo: "Bookkeeping (retired)" } },
];

const NEW_ACCOUNTS = [
  "All Inclusive - Sole Traders",
  "All Inclusive - LLPs",
  "All Inclusive - Partnerships",
  "Retainers",
  "Bookkeeping (non-VAT registered)",
  "Statutory Accounts - Ltd Company",
  "Statutory Accounts - LLP",
  "Statutory Accounts - Partnership",
  "Statutory Accounts - Property",
  "Tax Returns - Ltd Company (CT600)",
  "Tax Returns - LLP",
  "Tax Returns - Partnership (SA800)",
  "Bespoke Analysis",
  "Business Plans",
  "Registered Office",
  "HMRC Registrations",
  "Companies House Amendments",
  "Other Services",
];

const PHASE2: Step[] = [
  ...NEW_ACCOUNTS.map((name): Step => ({ phase: 2, label: `Income account: ${name}`, op: { kind: "create_account", name } })),
  {
    phase: 2,
    label: "Rename 193 to reflect the entity split (already 95% Ltd revenue)",
    op: { kind: "rename_account", from: "All Inclusive Packages", to: "All Inclusive - Ltd Companies" },
  },
];

// Grouping items. QBO service items require an income account even when the
// item is only ever a container, so each group points at its category's
// primary account. Athena never offers these for billing — the /billing
// dropdown is built from qbo_service_items, and none of these are mapped.
const GROUPS: Array<{ name: string; account: string; parent?: string }> = [
  { name: "All Inclusive", account: "All Inclusive - Ltd Companies" },
  { name: "Payroll Related", account: "Payroll" },
  { name: "Bookkeeping", account: "Bookkeeping & VAT Returns" },
  { name: "Accounts", account: "Annual Accounts and Business Tax" },
  { name: "Tax Returns", account: "Self Assessments" },
  { name: "Advisory", account: "FD / Advice" },
  { name: "Company Secretarial", account: "Confirmation Statements" },
  { name: "Other", account: "Software Licences" },
  // Third level: sits inside All Inclusive and holds the VAT / non-VAT leaves.
  { name: "All Inclusive Fees - Ltd Companies", account: "All Inclusive - Ltd Companies", parent: "All Inclusive" },
];

const PHASE3: Step[] = GROUPS.map((g): Step => ({
  phase: 3,
  label: `Grouping item: ${g.name}${g.parent ? ` (inside ${g.parent})` : ""}`,
  op: { kind: "create_item", name: g.name, parent: g.parent, account: g.account },
}));

// Renames, re-parents and income-account fixes on items that already exist.
// These carry ~£334k of this year's revenue history with them.
const PHASE4: Step[] = [
  { phase: 4, label: "#3 -> Ltd Companies (VAT Registered)", op: { kind: "update_item", id: "3", name: "All Inclusive Fees - Ltd Companies (VAT Registered)", parent: "All Inclusive Fees - Ltd Companies" } },
  { phase: 4, label: "#16 -> Ltd Companies (Not VAT Registered)", op: { kind: "update_item", id: "16", name: "All Inclusive Fees - Ltd Companies (Not VAT Registered)", parent: "All Inclusive Fees - Ltd Companies" } },
  { phase: 4, label: "#17 -> Sole Traders, onto its own account", op: { kind: "update_item", id: "17", name: "All Inclusive Fees - Sole Traders", parent: "All Inclusive", account: "All Inclusive - Sole Traders" } },
  { phase: 4, label: "#11 Retainer -> All Inclusive, onto Retainers", op: { kind: "update_item", id: "11", parent: "All Inclusive", account: "Retainers" } },
  { phase: 4, label: "#13 -> Accounts & Corporation Tax", op: { kind: "update_item", id: "13", name: "Accounts & Corporation Tax", parent: "Accounts" } },
  { phase: 4, label: "#33 -> Statutory Accounts - Sole Trader", op: { kind: "update_item", id: "33", name: "Statutory Accounts - Sole Trader", parent: "Accounts" } },
  { phase: 4, label: "#25 -> Statutory Accounts - Dormant Ltd Company", op: { kind: "update_item", id: "25", name: "Statutory Accounts - Dormant Ltd Company", parent: "Accounts" } },
  { phase: 4, label: "#14 -> Tax Returns - Individual", op: { kind: "update_item", id: "14", name: "Tax Returns - Individual", parent: "Tax Returns" } },
  { phase: 4, label: "#46 -> Tax Returns - MTD", op: { kind: "update_item", id: "46", name: "Tax Returns - MTD", parent: "Tax Returns" } },
  { phase: 4, label: "#22 -> Bookkeeping (VAT Registered)", op: { kind: "update_item", id: "22", name: "Bookkeeping (VAT Registered)", parent: "Bookkeeping" } },
  { phase: 4, label: "#4 -> Fractional CFO", op: { kind: "update_item", id: "4", name: "Fractional CFO", parent: "Advisory" } },
  { phase: 4, label: "#36 -> Review Meetings", op: { kind: "update_item", id: "36", name: "Review Meetings", parent: "Advisory" } },
  { phase: 4, label: "#24 Management Accounts -> Advisory", op: { kind: "update_item", id: "24", parent: "Advisory" } },
  { phase: 4, label: "#27 Billable Hours -> Advisory (consultancy only)", op: { kind: "update_item", id: "27", parent: "Advisory" } },
  { phase: 4, label: "#21 -> Confirmation Statement", op: { kind: "update_item", id: "21", name: "Confirmation Statement", parent: "Company Secretarial" } },
  { phase: 4, label: "#38 -> HMRC Registrations, off 193", op: { kind: "update_item", id: "38", name: "HMRC Registrations", parent: "Company Secretarial", account: "HMRC Registrations" } },
  { phase: 4, label: "#35 Registered Office -> Company Secretarial, off 193", op: { kind: "update_item", id: "35", parent: "Company Secretarial", account: "Registered Office" } },
  { phase: 4, label: "#39 ID Verification -> Company Secretarial", op: { kind: "update_item", id: "39", parent: "Company Secretarial" } },
  { phase: 4, label: "#28 Company Formation -> Company Secretarial", op: { kind: "update_item", id: "28", parent: "Company Secretarial" } },
  { phase: 4, label: "#20 -> Software", op: { kind: "update_item", id: "20", name: "Software", parent: "Other" } },
  { phase: 4, label: "#15 Payroll -> Payroll Related", op: { kind: "update_item", id: "15", parent: "Payroll Related" } },
  { phase: 4, label: "#34 Modulr -> Payroll Related", op: { kind: "update_item", id: "34", parent: "Payroll Related" } },
  { phase: 4, label: "#19 Fee Protection Insurance -> Other", op: { kind: "update_item", id: "19", parent: "Other" } },
  { phase: 4, label: "#12 Lending Commissions -> Other", op: { kind: "update_item", id: "12", parent: "Other" } },
  // Reactivated so the Company Administration history has a live home to be
  // recoded onto, and moved off the generic 19 Services account.
  { phase: 4, label: "#37 Companies House Amendments -> reactivate, own account", op: { kind: "reactivate_item", id: "37", name: "Companies House Amendments", parent: "Company Secretarial", account: "Companies House Amendments" } },
];

const NEW_LEAVES: Array<{ name: string; parent: string; account: string }> = [
  { name: "All Inclusive Fees - LLPs", parent: "All Inclusive", account: "All Inclusive - LLPs" },
  { name: "All Inclusive Fees - Partnerships", parent: "All Inclusive", account: "All Inclusive - Partnerships" },
  { name: "Bookkeeping (non-VAT registered)", parent: "Bookkeeping", account: "Bookkeeping (non-VAT registered)" },
  { name: "Statutory Accounts - Ltd Company", parent: "Accounts", account: "Statutory Accounts - Ltd Company" },
  { name: "Statutory Accounts - LLP", parent: "Accounts", account: "Statutory Accounts - LLP" },
  { name: "Statutory Accounts - Partnership", parent: "Accounts", account: "Statutory Accounts - Partnership" },
  { name: "Statutory Accounts - Property", parent: "Accounts", account: "Statutory Accounts - Property" },
  { name: "Tax Returns - Ltd Company (CT600)", parent: "Tax Returns", account: "Tax Returns - Ltd Company (CT600)" },
  { name: "Tax Returns - LLP", parent: "Tax Returns", account: "Tax Returns - LLP" },
  { name: "Tax Returns - Partnership (SA800)", parent: "Tax Returns", account: "Tax Returns - Partnership (SA800)" },
  { name: "Bespoke Analysis", parent: "Advisory", account: "Bespoke Analysis" },
  { name: "Business Plans", parent: "Advisory", account: "Business Plans" },
  { name: "SA302s", parent: "Other", account: "Other Services" },
  { name: "Accountant Certificates", parent: "Other", account: "Other Services" },
];

const PHASE5: Step[] = NEW_LEAVES.map((l): Step => ({
  phase: 5,
  label: `New leaf: ${l.name}`,
  op: { kind: "create_item", name: l.name, parent: l.parent, account: l.account },
}));

// Left until last so nothing still points at them. #42's and #45's history is
// recoded by hand afterwards; #18 has never sold.
const PHASE6: Step[] = [
  { phase: 6, label: "Retire auto-created Accounts Production", op: { kind: "deactivate_item", id: "42", expectName: "Accounts Production" } },
  { phase: 6, label: "Retire auto-created Admin", op: { kind: "deactivate_item", id: "45", expectName: "Admin" } },
  { phase: 6, label: "Retire unsold All Inclusive Self Employed & VAT Reg", op: { kind: "deactivate_item", id: "18" } },
];

const PLAN: Step[] = [...PHASE1, ...PHASE2, ...PHASE3, ...PHASE4, ...PHASE5, ...PHASE6];

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders() });
  if (req.method !== "POST") return jsonResponse({ success: false, error: "POST required" }, 405);

  // Rebuilds the live QBO product catalogue. Destructive admin operation.
  try { await requireStaffOrService(req, "can_manage_portal"); }
  catch (err) { return authErrorResponse(err, corsHeaders()); }

  const body = await req.json().catch(() => ({}));
  const phases: number[] | null = Array.isArray(body.phases) ? body.phases.map(Number) : null;
  const steps = phases ? PLAN.filter((s) => phases.includes(s.phase)) : PLAN;

  try {
    const ctx = await loadContext();

    if (!body.apply) {
      // Dry run: resolve every reference and show the payload, no writes.
      const plan = steps.map((s) => describe(s, ctx));
      return jsonResponse({
        success: true,
        dry_run: true,
        total: plan.length,
        would_write: plan.filter((p) => p.action !== "skip").length,
        would_skip: plan.filter((p) => p.action === "skip").length,
        blocked: plan.filter((p) => p.action === "blocked"),
        plan,
      });
    }

    const results: Array<Record<string, unknown>> = [];
    for (const step of steps) {
      const d = describe(step, ctx);
      if (d.action === "skip") { results.push({ ...d, status: "skipped" }); continue; }
      if (d.action === "blocked") { results.push({ ...d, status: "blocked" }); continue; }
      try {
        const out = await execute(step, ctx);
        results.push({ ...d, status: out.needs_qbo_ui ? "needs_qbo_ui" : "ok", ...out });
      } catch (e) {
        results.push({ ...d, status: "error", error: (e as Error).message });
        // Stop on first hard failure: later steps reference earlier ones by
        // name, so pressing on would compound one bad state into several.
        // A closed-period refusal is not a hard failure — see execute().
        break;
      }
    }

    const errors = results.filter((r) => r.status === "error").length;
    await logSync({
      direction: "push",
      qbo_entity_type: "Item",
      status: errors ? "error" : "success",
      detail: { rebuild: true, phases: phases || "all", results },
      error_message: errors ? `${errors} step(s) failed` : undefined,
      initiated_by: body.initiated_by || undefined,
    });

    return jsonResponse({
      success: errors === 0,
      applied: results.filter((r) => r.status === "ok").length,
      skipped: results.filter((r) => r.status === "skipped").length,
      failed: errors,
      results,
    });
  } catch (e) {
    return jsonResponse({ success: false, error: (e as Error).message }, 500);
  }
});

// ── live state ───────────────────────────────────────────────────────
type Ctx = {
  accByName: Map<string, Record<string, unknown>>;
  itemByName: Map<string, Record<string, unknown>>;
  itemById: Map<string, Record<string, unknown>>;
};

async function loadContext(): Promise<Ctx> {
  const accounts = await pageAll("Account", "SELECT * FROM Account WHERE AccountType IN ('Income', 'Other Income')");
  const items = await pageAll("Item", "SELECT * FROM Item WHERE Active IN (true, false)");
  const ctx: Ctx = { accByName: new Map(), itemByName: new Map(), itemById: new Map() };
  for (const a of accounts) ctx.accByName.set(norm(a.Name), a);
  for (const it of items) {
    ctx.itemByName.set(norm(it.Name), it);
    ctx.itemById.set(String(it.Id), it);
  }
  return ctx;
}

const norm = (v: unknown) => String(v ?? "").toLowerCase().trim();

// ── planning ─────────────────────────────────────────────────────────
function describe(step: Step, ctx: Ctx): Record<string, unknown> {
  const base = { phase: step.phase, label: step.label, kind: step.op.kind };
  const op = step.op;

  if (op.kind === "create_account") {
    if (ctx.accByName.has(norm(op.name))) {
      return { ...base, action: "skip", reason: `account "${op.name}" already exists`, target: op.name };
    }
    return { ...base, action: "create", target: op.name, payload: accountPayload(op.name, op.subtype) };
  }

  if (op.kind === "rename_account") {
    const acc = ctx.accByName.get(norm(op.from));
    if (!acc) {
      if (ctx.accByName.has(norm(op.to))) return { ...base, action: "skip", reason: `already renamed to "${op.to}"` };
      return { ...base, action: "blocked", reason: `no income account named "${op.from}"` };
    }
    return { ...base, action: "update", target: `${op.from} -> ${op.to}`, id: String(acc.Id), payload: { Id: acc.Id, SyncToken: acc.SyncToken, Name: op.to, sparse: true } };
  }

  if (op.kind === "create_item") {
    if (ctx.itemByName.has(norm(op.name))) {
      return { ...base, action: "skip", reason: `item "${op.name}" already exists`, target: op.name };
    }
    const acc = ctx.accByName.get(norm(op.account));
    if (!acc) return { ...base, action: "blocked", reason: `income account "${op.account}" not found — run phase 2 first` };
    let parentId: string | null = null;
    if (op.parent) {
      const p = ctx.itemByName.get(norm(op.parent));
      if (!p) return { ...base, action: "blocked", reason: `parent item "${op.parent}" not found — run phase 3 first` };
      parentId = String(p.Id);
    }
    return { ...base, action: "create", target: op.name, payload: itemPayload(op.name, String(acc.Id), parentId) };
  }

  if (op.kind === "update_item" || op.kind === "reactivate_item") {
    const it = ctx.itemById.get(op.id);
    if (!it) return { ...base, action: "blocked", reason: `item #${op.id} not found in QBO` };
    const patch: Record<string, unknown> = { Id: it.Id, SyncToken: it.SyncToken, Name: op.name || it.Name, Type: it.Type, sparse: true };
    if (op.kind === "reactivate_item") patch.Active = true;
    if (op.parent) {
      const p = ctx.itemByName.get(norm(op.parent));
      if (!p) return { ...base, action: "blocked", reason: `parent item "${op.parent}" not found — run phase 3 first` };
      patch.SubItem = true;
      patch.ParentRef = { value: String(p.Id) };
    }
    if (op.account) {
      const acc = ctx.accByName.get(norm(op.account));
      if (!acc) return { ...base, action: "blocked", reason: `income account "${op.account}" not found — run phase 2 first` };
      patch.IncomeAccountRef = { value: String(acc.Id) };
    }
    const already = op.kind === "update_item"
      && (!op.name || norm(it.Name) === norm(op.name))
      && (!op.parent || norm((it.ParentRef as Record<string, unknown>)?.name) === norm(op.parent))
      && (!op.account || norm((it.IncomeAccountRef as Record<string, unknown>)?.name) === norm(op.account));
    if (already) return { ...base, action: "skip", reason: "already in the target state", target: String(it.Name) };
    return { ...base, action: "update", target: `${it.Name} -> ${patch.Name}`, id: op.id, payload: patch };
  }

  if (op.kind === "deactivate_item") {
    const it = ctx.itemById.get(op.id);
    if (!it) return { ...base, action: "blocked", reason: `item #${op.id} not found in QBO` };
    if (it.Active === false) return { ...base, action: "skip", reason: "already inactive", target: String(it.Name) };
    if (op.expectName && norm(it.Name) !== norm(op.expectName)) {
      // Guard against retiring the wrong item if ids ever shift under us.
      return { ...base, action: "blocked", reason: `item #${op.id} is "${it.Name}", expected "${op.expectName}"` };
    }
    return {
      ...base,
      action: "update",
      target: op.renameTo ? `${it.Name} -> ${op.renameTo}` : String(it.Name),
      id: op.id,
      payload: { Id: it.Id, SyncToken: it.SyncToken, Name: op.renameTo || it.Name, Type: it.Type, Active: false, sparse: true },
    };
  }

  return { ...base, action: "blocked", reason: "unknown op" };
}

function accountPayload(name: string, subtype?: string) {
  return { Name: name, AccountType: "Income", AccountSubType: subtype || "ServiceFeeIncome" };
}

function itemPayload(name: string, accountId: string, parentId: string | null) {
  const p: Record<string, unknown> = {
    Name: name,
    Type: "Service",
    IncomeAccountRef: { value: accountId },
    Taxable: true,
  };
  if (parentId) { p.SubItem = true; p.ParentRef = { value: parentId }; }
  return p;
}

// ── execution ────────────────────────────────────────────────────────
async function execute(step: Step, ctx: Ctx): Promise<Record<string, unknown>> {
  const d = describe(step, ctx);
  const payload = { ...(d.payload as Record<string, unknown>) };
  const entity = step.op.kind === "create_account" || step.op.kind === "rename_account" ? "account" : "item";

  // Changing an existing item's IncomeAccountRef is refused (error 6210) when
  // the item has transactions in a closed period — QBO requires the website
  // for that. So split it out: apply the name/parent change, which QBO does
  // allow, then attempt the account move on its own. If that half is refused
  // the step reports needs_qbo_ui and the run carries on, rather than one
  // closed-period item blocking the other twenty-four.
  const acctRef = (step.op.kind === "update_item" || step.op.kind === "reactivate_item")
    ? payload.IncomeAccountRef as Record<string, unknown> | undefined
    : undefined;
  const hasOtherChanges = acctRef
    ? Object.keys(payload).some((k) => !["Id", "SyncToken", "sparse", "Type", "IncomeAccountRef"].includes(k))
    : true;
  if (acctRef) delete payload.IncomeAccountRef;

  let rec: Record<string, unknown> | null = null;
  if (hasOtherChanges) {
    const resp = await qboFetch(entity, { method: "POST", body: JSON.stringify(payload) });
    if (!resp.ok) throw new Error(`${entity} write failed: ${resp.status} ${await resp.text()}`);
    const json = await resp.json();
    rec = (json.Account || json.Item) as Record<string, unknown>;
  }

  let needs_qbo_ui: string | undefined;
  if (acctRef) {
    const base = rec || (ctx.itemById.get((payload.Id as string)) as Record<string, unknown>);
    const second = { Id: base.Id, SyncToken: base.SyncToken, Name: base.Name, Type: base.Type, IncomeAccountRef: acctRef, sparse: true };
    const r2 = await qboFetch("item", { method: "POST", body: JSON.stringify(second) });
    if (r2.ok) {
      rec = (await r2.json()).Item as Record<string, unknown>;
    } else {
      const text = await r2.text();
      if (!text.includes("6210")) throw new Error(`item account write failed: ${r2.status} ${text}`);
      needs_qbo_ui = `income account move refused — closed period. Set it on the QBO website: account id ${acctRef.value}`;
      if (!rec) rec = base;
    }
  }

  if (!rec) throw new Error("no record returned");

  // Keep the in-memory view current so later steps resolve the things we
  // just made, without a second round trip per step.
  if (entity === "account") ctx.accByName.set(norm(rec.Name), rec);
  else {
    ctx.itemByName.set(norm(rec.Name), rec);
    ctx.itemById.set(String(rec.Id), rec);
  }
  return { qbo_id: String(rec.Id), qbo_name: String(rec.Name), needs_qbo_ui };
}

async function pageAll(entity: string, baseQuery: string): Promise<Array<Record<string, unknown>>> {
  let out: Array<Record<string, unknown>> = [];
  let start = 1;
  const pageSize = 1000;
  for (let i = 0; i < 50; i++) {
    const result = await qboQuery(`${baseQuery} STARTPOSITION ${start} MAXRESULTS ${pageSize}`) as Record<string, unknown>;
    const qr = (result?.QueryResponse as Record<string, unknown>) || {};
    const page = (qr[entity] || []) as Array<Record<string, unknown>>;
    if (page.length === 0) break;
    out = out.concat(page);
    if (page.length < pageSize) break;
    start += pageSize;
  }
  return out;
}
