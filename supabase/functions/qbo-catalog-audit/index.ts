import { qboQuery, jsonResponse, corsHeaders } from "../_shared/qbo-client.ts";

// Read-only audit of where sales revenue actually lands: every income account
// in the chart of accounts, and every QBO item grouped by the income account
// it posts to.
//
// Athena has never held this. qbo-pull mirrors the item catalog but drops
// IncomeAccountRef, so nothing in the app could tell you that a product was
// coding to a catch-all — which is exactly how several services ended up on
// Billable Expense Income unnoticed. This is the missing lens; it makes no
// writes to QBO or to the database.
//
// GET/POST -> {
//   accounts: [{ id, name, fully_qualified_name, type, subtype, active, current_balance }],
//   items:    [{ id, name, active, income_account_id, income_account_name }],
//   by_account: [{ account_id, account_name, item_count, items: [names] }],
//   unassigned: [items with no IncomeAccountRef]
// }
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders() });
  if (req.method !== "POST" && req.method !== "GET") {
    return jsonResponse({ success: false, error: "POST or GET required" }, 405);
  }

  try {
    // Income and Other Income only — the accounts a sales item can post to.
    // Inactive accounts are included deliberately: an item can still point at
    // one, and that's a finding rather than something to hide.
    const accounts = await pageAll("Account", "SELECT * FROM Account WHERE AccountType IN ('Income', 'Other Income')");
    // Active IN (true, false) — a bare SELECT returns only active items, which
    // would hide exactly the deactivated ones we need to see (a retired item
    // still carries the history posted against its income account).
    const items = await pageAll("Item", "SELECT * FROM Item WHERE Active IN (true, false)");

    const accById = new Map<string, Record<string, unknown>>();
    for (const a of accounts) accById.set(String(a.Id), a);

    const itemRows = items.map((it) => {
      const ref = (it.IncomeAccountRef as Record<string, unknown>) || null;
      const accId = ref?.value ? String(ref.value) : null;
      return {
        id: String(it.Id),
        name: String(it.Name || ""),
        active: it.Active !== false,
        type: it.Type ? String(it.Type) : null,
        income_account_id: accId,
        // Prefer the live account name over the ref's cached one.
        income_account_name: accId
          ? String((accById.get(accId)?.Name as string) || ref?.name || `Account ${accId}`)
          : null,
      };
    });

    const groups = new Map<string, { account_id: string; account_name: string; item_count: number; items: string[] }>();
    const unassigned: string[] = [];
    for (const r of itemRows) {
      if (!r.income_account_id) { unassigned.push(r.name); continue; }
      const g = groups.get(r.income_account_id) || {
        account_id: r.income_account_id,
        account_name: r.income_account_name || "",
        item_count: 0,
        items: [],
      };
      g.item_count += 1;
      g.items.push(r.active ? r.name : `${r.name} [inactive]`);
      groups.set(r.income_account_id, g);
    }

    return jsonResponse({
      success: true,
      accounts: accounts.map((a) => ({
        id: String(a.Id),
        name: String(a.Name || ""),
        fully_qualified_name: a.FullyQualifiedName ? String(a.FullyQualifiedName) : null,
        type: a.AccountType ? String(a.AccountType) : null,
        subtype: a.AccountSubType ? String(a.AccountSubType) : null,
        active: a.Active !== false,
        current_balance: a.CurrentBalance != null ? Number(a.CurrentBalance) : null,
      })),
      items: itemRows,
      by_account: [...groups.values()].sort((x, y) => y.item_count - x.item_count),
      unassigned,
    });
  } catch (e) {
    return jsonResponse({ success: false, error: `QBO query failed: ${(e as Error).message}` }, 500);
  }
});

// STARTPOSITION pagination — without it QBO caps at 100 results, or 1000
// when MAXRESULTS is given. Same treatment as qbo-pull and qbo-diagnose-templates.
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
