import { qboFetch, qboQuery, logSync, jsonResponse, corsHeaders } from "../_shared/qbo-client.ts";

// Rename product/service items in QBO. Bobby, 6 Aug 2026: "Statutory Accounts"
// becomes "Business Accounts" across the accounts products, and #13 becomes
// "Business Accounts and Corporation Tax Combined". The Athena-side names live
// in qbo_service_items (sql/186) — this half keeps QBO in step, so the term the
// client reads on an invoice matches the term the team uses.
//
// POST { dry_run: true }  (or no body) -> what would change, no writes
// POST { apply: true }                 -> apply it
//
// Every rename is checked against live QBO first: an item already carrying the
// new name is skipped, an item whose current name isn't the expected one is
// blocked rather than renamed on trust (ids could have shifted), and a target
// name already held by a different item is blocked — QBO enforces unique item
// names, so that write would fail anyway.
//
// Names only. Parents and income accounts are deliberately untouched: nothing
// about this change moves where revenue codes, and an income-account write on
// an item with transactions in a closed period is refused by QBO (error 6210).

type Rename = { id: string; from: string; to: string };

const RENAMES: Rename[] = [
  // #59 is the Ltd accounts product — what the ad-hoc label "Accounts
  // Production" has been billing to all along. Bobby's wording for it, hence
  // the plural, which also matches the All Inclusive items already in QBO.
  { id: "59", from: "Statutory Accounts - Ltd Company", to: "Business Accounts - Ltd Companies" },
  { id: "25", from: "Statutory Accounts - Dormant Ltd Company", to: "Business Accounts - Dormant Ltd Company" },
  { id: "60", from: "Statutory Accounts - LLP", to: "Business Accounts - LLP" },
  { id: "61", from: "Statutory Accounts - Partnership", to: "Business Accounts - Partnership" },
  { id: "62", from: "Statutory Accounts - Property", to: "Business Accounts - Property" },
  { id: "33", from: "Statutory Accounts - Sole Trader", to: "Business Accounts - Sole Trader" },
  { id: "13", from: "Accounts & Corporation Tax", to: "Business Accounts and Corporation Tax Combined" },
];

const norm = (s: unknown) => String(s ?? "").trim().toLowerCase();

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders() });
  if (req.method !== "POST") return jsonResponse({ success: false, error: "POST required" }, 405);

  const body = await req.json().catch(() => ({}));

  try {
    // Inactive items are included: a retired item still holds its name against
    // the uniqueness rule, so it has to be visible to the collision check.
    const items = await pageAll("Item", "SELECT * FROM Item WHERE Active IN (true, false)");
    const byId = new Map(items.map((i) => [String(i.Id), i]));
    const byName = new Map(items.map((i) => [norm(i.Name), i]));

    const plan = RENAMES.map((r) => {
      const it = byId.get(r.id);
      if (!it) return { ...r, action: "blocked", reason: `item #${r.id} not found in QBO` };
      if (norm(it.Name) === norm(r.to)) return { ...r, action: "skip", reason: "already renamed" };
      if (norm(it.Name) !== norm(r.from)) {
        return { ...r, action: "blocked", reason: `item #${r.id} is "${it.Name}", expected "${r.from}"` };
      }
      const clash = byName.get(norm(r.to));
      if (clash && String(clash.Id) !== r.id) {
        return { ...r, action: "blocked", reason: `"${r.to}" is already item #${clash.Id}${clash.Active === false ? " (inactive)" : ""}` };
      }
      return {
        ...r,
        action: "update",
        // sparse keeps this to the name — parent, account and pricing stay put.
        payload: { Id: it.Id, SyncToken: it.SyncToken, Name: r.to, Type: it.Type, sparse: true },
      };
    });

    if (!body.apply) {
      return jsonResponse({
        success: true,
        dry_run: true,
        total: plan.length,
        would_write: plan.filter((p) => p.action === "update").length,
        would_skip: plan.filter((p) => p.action === "skip").length,
        blocked: plan.filter((p) => p.action === "blocked"),
        plan,
      });
    }

    const results: Array<Record<string, unknown>> = [];
    for (const p of plan) {
      if (p.action !== "update") { results.push({ ...p, status: p.action === "skip" ? "skipped" : "blocked" }); continue; }
      try {
        const resp = await qboFetch("item", { method: "POST", body: JSON.stringify(p.payload) });
        if (!resp.ok) throw new Error(`${resp.status} ${await resp.text()}`);
        const rec = (await resp.json()).Item as Record<string, unknown>;
        results.push({ ...p, status: "ok", qbo_name: String(rec.Name) });
      } catch (e) {
        // Renames are independent of each other — one refusal shouldn't hold
        // back the rest, unlike the rebuild's name-chained phases.
        results.push({ ...p, status: "error", error: (e as Error).message });
      }
    }

    const errors = results.filter((r) => r.status === "error").length;
    await logSync({
      direction: "push",
      qbo_entity_type: "Item",
      status: errors ? "error" : "success",
      detail: { catalogue_rename: true, results },
      error_message: errors ? `${errors} rename(s) failed` : undefined,
      initiated_by: body.initiated_by || undefined,
    });

    return jsonResponse({
      success: errors === 0,
      applied: results.filter((r) => r.status === "ok").length,
      skipped: results.filter((r) => r.status === "skipped").length,
      blocked: results.filter((r) => r.status === "blocked").length,
      failed: errors,
      results,
    });
  } catch (e) {
    return jsonResponse({ success: false, error: (e as Error).message }, 500);
  }
});

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
