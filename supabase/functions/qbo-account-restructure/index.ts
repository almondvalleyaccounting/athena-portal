import { qboFetch, qboQuery, jsonResponse, corsHeaders } from "../_shared/qbo-client.ts";

// Give the income side of the chart of accounts a shape.
//
// qbo-catalog-audit (2026-08-07) read back 56 income accounts with not one
// parent/child relationship between them — the P&L was a 56-line wall with no
// subtotals. This nests the 37 fee-income accounts under eight parents that
// mirror the QBO item groups already cached in qbo_service_items.qbo_category
// (sql/189), so the P&L subtotals, the invoice grouping and Athena's service
// picker all read off one taxonomy.
//
// Also retires 'Statutory Accounts - Ltd Company' (#259): its one product,
// 'Business Accounts - Ltd Companies' (item #59), moves to 'Annual Accounts and
// Business Tax' (#205), where the combined accounts+CT product already posts.
// The item keeps its name, so the invoice wording a client reads is unchanged —
// only the nominal it codes to moves.
//
// Idempotent: every step checks the live state first and skips what is already
// right, so a partial run can simply be re-run. Nothing here writes to the
// Athena database.
//
// POST { dryRun: true }        -> plan only, no writes
// POST { phases: [1,2] }       -> run a subset
// POST {}                      -> run every phase

type Phase = 1 | 2 | 3 | 4 | 5 | 6;

// ── the target shape ─────────────────────────────────────────────────
//
// Parent names avoid colliding with an existing account: 'Payroll Services'
// rather than 'Payroll' (#202 owns that name) and 'Ancillary Income' rather
// than 'Other Services' (#271). QBO rejects duplicate account names outright.
const PARENTS: Array<{ name: string; children: string[] }> = [
  { name: "Annual Accounts",     children: ["205", "204", "260", "261", "262", "198"] },
  { name: "Tax Returns",         children: ["192", "263", "264", "265", "1150040017"] },
  { name: "Bookkeeping",         children: ["196", "258"] },
  { name: "Payroll Services",    children: ["202", "221"] },
  { name: "Advisory",            children: ["201", "248", "200", "266", "267", "195"] },
  { name: "Company Secretarial", children: ["194", "197", "270", "269", "252", "268"] },
  { name: "All Inclusive",       children: ["193", "254", "255", "256", "257"] },
  { name: "Ancillary Income",    children: ["203", "199", "34", "271", "162", "158"] },
];

// The item catalogue was renamed 'Statutory Accounts' -> 'Business Accounts' on
// 2026-08-06 (sql/186) but the nominals were left behind. Bring them into line.
// #259 is deliberately absent — it is being retired, not renamed.
const RENAMES: Array<{ id: string; from: string; to: string }> = [
  { id: "260", from: "Statutory Accounts - LLP",         to: "Business Accounts - LLP" },
  { id: "261", from: "Statutory Accounts - Partnership", to: "Business Accounts - Partnership" },
  { id: "262", from: "Statutory Accounts - Property",    to: "Business Accounts - Property" },
  // Not a sql/186 leftover — just a typo that has been in the chart since the
  // account was created, and reads back on the P&L.
  { id: "252", from: "ID Verifcation",                   to: "ID Verification" },
];

const ITEM_MOVES: Array<{ id: string; expectName: string; toAccountId: string }> = [
  { id: "59", expectName: "Business Accounts - Ltd Companies", toAccountId: "205" },
];

const RETIRE_ACCOUNTS: Array<{ id: string; expectName: string }> = [
  { id: "259", expectName: "Statutory Accounts - Ltd Company" },
];

// Both still post to Billable Expense Income, a catch-all. Athena stopped
// mapping to either (sql/178, sql/179) and neither is in ADHOC_SERVICES, so
// nothing can bill them from the app — but they stay pickable inside QBO until
// they are switched off. qbo-catalog-rebuild's phase 6 intended this and did
// not land; this is that step, run on its own.
const RETIRE_ITEMS: Array<{ id: string; expectName: string }> = [
  { id: "42", expectName: "Accounts Production" },
  { id: "45", expectName: "Admin" },
];

const norm = (s: unknown) => String(s ?? "").trim().toLowerCase();

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders() });
  if (req.method !== "POST") return jsonResponse({ success: false, error: "POST required" }, 405);

  const body = await req.json().catch(() => ({})) as { dryRun?: boolean; phases?: number[] };
  const dryRun = body.dryRun === true;
  const wanted = new Set<number>(body.phases && body.phases.length ? body.phases : [1, 2, 3, 4, 5, 6]);

  const steps: Array<Record<string, unknown>> = [];
  const record = (phase: Phase, label: string, rest: Record<string, unknown>) =>
    steps.push({ phase, label, ...rest });

  try {
    // Inactive accounts included: an account we mean to re-parent or retire may
    // already be switched off, and a "not found" there would be misleading.
    let accounts = await pageAll("Account", "SELECT * FROM Account WHERE AccountType IN ('Income', 'Other Income')");
    const byId = new Map(accounts.map((a) => [String(a.Id), a]));
    const byName = new Map(accounts.map((a) => [norm(a.Name), a]));

    // ── phase 1: create the parents ──────────────────────────────────
    if (wanted.has(1)) {
      for (const p of PARENTS) {
        const existing = byName.get(norm(p.name));
        if (existing) {
          record(1, `Parent "${p.name}"`, { action: "skip", reason: "already exists", qbo_id: String(existing.Id) });
          continue;
        }
        if (dryRun) {
          record(1, `Parent "${p.name}"`, { action: "create", payload: { Name: p.name, AccountType: "Income", AccountSubType: "ServiceFeeIncome" } });
          continue;
        }
        const rec = await write("account", { Name: p.name, AccountType: "Income", AccountSubType: "ServiceFeeIncome" });
        byId.set(String(rec.Id), rec);
        byName.set(norm(rec.Name), rec);
        record(1, `Parent "${p.name}"`, { action: "create", qbo_id: String(rec.Id) });
      }
      // A dry run creates nothing, so phase 2 would find no parents and report
      // eight blocks that say nothing about whether the nesting is sound. Stand
      // in a placeholder for each so the plan can be read end to end.
      if (dryRun) {
        for (const p of PARENTS) {
          if (!byName.get(norm(p.name))) byName.set(norm(p.name), { Id: "(pending)", Name: p.name, AccountType: "Income" });
        }
      }
    }

    // ── phase 2: nest the children ───────────────────────────────────
    //
    // A sub-account must share its parent's AccountType. All 37 are Income, so
    // the mismatch that would bite here is a child QBO reports as Other Income;
    // that is caught per-child rather than assumed away.
    if (wanted.has(2)) {
      for (const p of PARENTS) {
        const parent = byName.get(norm(p.name));
        if (!parent) {
          record(2, `Nest under "${p.name}"`, { action: "blocked", reason: "parent not found — run phase 1 first" });
          continue;
        }
        for (const childId of p.children) {
          const child = byId.get(childId);
          const label = `${child?.Name ?? `#${childId}`} -> ${p.name}`;
          if (!child) {
            record(2, label, { action: "blocked", reason: `account #${childId} not found` });
            continue;
          }
          if (child.SubAccount === true && String((child.ParentRef as Record<string, unknown>)?.value) === String(parent.Id)) {
            record(2, label, { action: "skip", reason: "already nested here" });
            continue;
          }
          if (child.SubAccount === true) {
            // Re-parenting an account that already sits somewhere else is a
            // different decision from filing a loose one. Report, don't move.
            record(2, label, { action: "blocked", reason: `already a sub-account of "${(child.ParentRef as Record<string, unknown>)?.name}"` });
            continue;
          }
          if (norm(child.AccountType) !== norm(parent.AccountType)) {
            record(2, label, { action: "blocked", reason: `type mismatch: child is ${child.AccountType}, parent is ${parent.AccountType}` });
            continue;
          }
          const payload = {
            Id: child.Id,
            SyncToken: child.SyncToken,
            Name: child.Name,
            AccountType: child.AccountType,
            SubAccount: true,
            ParentRef: { value: String(parent.Id) },
            sparse: true,
          };
          if (dryRun) { record(2, label, { action: "update", payload }); continue; }
          const rec = await write("account", payload);
          byId.set(String(rec.Id), rec);
          record(2, label, { action: "update", qbo_id: String(rec.Id), fully_qualified_name: rec.FullyQualifiedName });
        }
      }
    }

    // ── phase 3: rename the leftover 'Statutory Accounts' nominals ────
    if (wanted.has(3)) {
      for (const r of RENAMES) {
        const acc = byId.get(r.id);
        if (!acc) { record(3, `Rename #${r.id}`, { action: "blocked", reason: "not found" }); continue; }
        if (norm(acc.Name) === norm(r.to)) { record(3, `Rename #${r.id}`, { action: "skip", reason: "already renamed" }); continue; }
        // Guard against renaming the wrong account if ids ever shift under us.
        if (norm(acc.Name) !== norm(r.from)) {
          record(3, `Rename #${r.id}`, { action: "blocked", reason: `is "${acc.Name}", expected "${r.from}"` });
          continue;
        }
        const payload = { Id: acc.Id, SyncToken: acc.SyncToken, Name: r.to, AccountType: acc.AccountType, sparse: true };
        if (dryRun) { record(3, `${r.from} -> ${r.to}`, { action: "update", payload }); continue; }
        const rec = await write("account", payload);
        byId.set(String(rec.Id), rec);
        byName.set(norm(rec.Name), rec);
        record(3, `${r.from} -> ${r.to}`, { action: "update", qbo_id: String(rec.Id) });
      }
    }

    // ── phase 4: move the Ltd accounts product onto #205 ─────────────
    if (wanted.has(4)) {
      for (const m of ITEM_MOVES) {
        const q = await qboQuery(`SELECT * FROM Item WHERE Id = '${m.id}'`) as Record<string, unknown>;
        const it = (((q.QueryResponse as Record<string, unknown>)?.Item as Array<Record<string, unknown>>) || [])[0];
        const label = `Item #${m.id} ${m.expectName} -> account #${m.toAccountId}`;
        if (!it) { record(4, label, { action: "blocked", reason: "item not found" }); continue; }
        if (norm(it.Name) !== norm(m.expectName)) {
          record(4, label, { action: "blocked", reason: `item #${m.id} is "${it.Name}", expected "${m.expectName}"` });
          continue;
        }
        if (String((it.IncomeAccountRef as Record<string, unknown>)?.value) === m.toAccountId) {
          record(4, label, { action: "skip", reason: "already posting there" });
          continue;
        }
        const payload = { Id: it.Id, SyncToken: it.SyncToken, Name: it.Name, Type: it.Type, IncomeAccountRef: { value: m.toAccountId }, sparse: true };
        if (dryRun) { record(4, label, { action: "update", payload }); continue; }
        // QBO refuses an IncomeAccountRef change with error 6210 when the item
        // has transactions in a closed period. That is a lock-date problem, not
        // a bad request — surface it and carry on rather than failing the run.
        const resp = await qboFetch("item", { method: "POST", body: JSON.stringify(payload) });
        if (resp.ok) {
          record(4, label, { action: "update", qbo_id: String(((await resp.json()).Item as Record<string, unknown>).Id) });
        } else {
          const text = await resp.text();
          if (!text.includes("6210")) throw new Error(`item write failed: ${resp.status} ${text}`);
          record(4, label, {
            action: "needs_qbo_ui",
            reason: "closed period — QBO refuses the account move over the API (6210). Set it on the QBO website.",
          });
        }
      }
    }

    // ── phase 5: retire the emptied account ──────────────────────────
    //
    // Runs after phase 4 on purpose: deactivating #259 while item #59 still
    // points at it would leave a live product coding to a switched-off nominal.
    if (wanted.has(5)) {
      for (const r of RETIRE_ACCOUNTS) {
        const acc = byId.get(r.id);
        if (!acc) { record(5, `Retire #${r.id}`, { action: "blocked", reason: "not found" }); continue; }
        if (acc.Active === false) { record(5, `Retire #${r.id}`, { action: "skip", reason: "already inactive" }); continue; }
        if (norm(acc.Name) !== norm(r.expectName)) {
          record(5, `Retire #${r.id}`, { action: "blocked", reason: `is "${acc.Name}", expected "${r.expectName}"` });
          continue;
        }
        // Refuse to switch off an account something still posts to. QBO will
        // not filter on IncomeAccountRef — it is not a queryable property — so
        // the whole catalogue comes back and the match happens here.
        const allItems = await pageAll("Item", "SELECT * FROM Item WHERE Active IN (true, false)");
        const holders = allItems.filter((i) => String((i.IncomeAccountRef as Record<string, unknown>)?.value ?? "") === r.id);
        if (holders.length) {
          record(5, `Retire #${r.id} ${r.expectName}`, {
            action: "blocked",
            reason: `${holders.length} item(s) still post here: ${holders.map((h) => h.Name).join(", ")}`,
          });
          continue;
        }
        const payload = { Id: acc.Id, SyncToken: acc.SyncToken, Name: acc.Name, AccountType: acc.AccountType, Active: false, sparse: true };
        if (dryRun) { record(5, `Retire #${r.id} ${r.expectName}`, { action: "update", payload }); continue; }
        const rec = await write("account", payload);
        record(5, `Retire #${r.id} ${r.expectName}`, { action: "update", qbo_id: String(rec.Id) });
      }
    }

    // ── phase 6: retire the two catch-all items ──────────────────────
    if (wanted.has(6)) {
      for (const r of RETIRE_ITEMS) {
        const q = await qboQuery(`SELECT * FROM Item WHERE Id = '${r.id}'`) as Record<string, unknown>;
        const it = (((q.QueryResponse as Record<string, unknown>)?.Item as Array<Record<string, unknown>>) || [])[0];
        const label = `Retire item #${r.id} ${r.expectName}`;
        if (!it) { record(6, label, { action: "blocked", reason: "not found" }); continue; }
        if (it.Active === false) { record(6, label, { action: "skip", reason: "already inactive" }); continue; }
        if (norm(it.Name) !== norm(r.expectName)) {
          record(6, label, { action: "blocked", reason: `item #${r.id} is "${it.Name}", expected "${r.expectName}"` });
          continue;
        }
        const payload = { Id: it.Id, SyncToken: it.SyncToken, Name: it.Name, Type: it.Type, Active: false, sparse: true };
        if (dryRun) { record(6, label, { action: "update", payload }); continue; }
        const rec = await write("item", payload);
        record(6, label, { action: "update", qbo_id: String(rec.Id) });
      }
    }

    const tally: Record<string, number> = {};
    for (const s of steps) tally[String(s.action)] = (tally[String(s.action)] || 0) + 1;

    return jsonResponse({ success: true, dryRun, phases: [...wanted].sort(), tally, steps });
  } catch (e) {
    return jsonResponse({ success: false, error: (e as Error).message, steps }, 500);
  }
});

async function write(entity: "account" | "item", payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  const resp = await qboFetch(entity, { method: "POST", body: JSON.stringify(payload) });
  if (!resp.ok) throw new Error(`${entity} write failed: ${resp.status} ${await resp.text()}`);
  const json = await resp.json();
  const rec = (json.Account || json.Item) as Record<string, unknown>;
  if (!rec) throw new Error(`${entity} write returned no record`);
  return rec;
}

// STARTPOSITION pagination — without it QBO caps at 100 results. Same
// treatment as qbo-pull, qbo-catalog-audit and qbo-diagnose-templates.
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
