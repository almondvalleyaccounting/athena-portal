import { getServiceClient, qboFetch, jsonResponse, corsHeaders } from "../_shared/qbo-client.ts";

// Pulls last 12 months Profit & Loss from QBO, flattens expense rows,
// and writes them to plan_qbo_pl_cache keyed on the LTM period.
// Returns the flattened accounts so the caller can seed overhead lines.

type Row = Record<string, unknown> & {
  type?: string;
  group?: string;
  Header?: { ColData?: Array<{ value?: string }> };
  ColData?: Array<{ value?: string }>;
  Summary?: { ColData?: Array<{ value?: string }> };
  Rows?: { Row?: Row[] };
};

function firstDayOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}
function addMonths(d: Date, m: number): Date {
  return new Date(d.getFullYear(), d.getMonth() + m, 1);
}
function fmtDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function flattenExpenseRows(rows: Row[] | undefined, out: Array<{ name: string; amount: number }>) {
  if (!rows) return;
  for (const r of rows) {
    // Detail row with a name + amount
    if (r.ColData && Array.isArray(r.ColData)) {
      const name = r.ColData[0]?.value?.trim();
      const amtStr = r.ColData[r.ColData.length - 1]?.value;
      const amt = parseFloat(amtStr || "0");
      if (name && !isNaN(amt)) {
        out.push({ name, amount: amt });
      }
    }
    // Nested section
    if (r.Rows?.Row) {
      flattenExpenseRows(r.Rows.Row, out);
    }
  }
}

function findSection(rows: Row[] | undefined, groupName: string): Row | null {
  if (!rows) return null;
  for (const r of rows) {
    if (r.group === groupName) return r;
    const inner = findSection(r.Rows?.Row, groupName);
    if (inner) return inner;
  }
  return null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders() });
  if (req.method !== "POST") return jsonResponse({ success: false, error: "POST required" }, 405);

  try {
    // Period = last 12 full months ending last month
    const now = new Date();
    const endMonthStart = firstDayOfMonth(new Date(now.getFullYear(), now.getMonth() - 1, 1));
    const startMonthStart = addMonths(endMonthStart, -11);
    const endDate = new Date(endMonthStart.getFullYear(), endMonthStart.getMonth() + 1, 0); // last day of end month
    const start = fmtDate(startMonthStart);
    const end = fmtDate(endDate);

    const resp = await qboFetch(
      `reports/ProfitAndLoss?start_date=${start}&end_date=${end}&accounting_method=Accrual&minorversion=75`,
    );
    if (!resp.ok) {
      const body = await resp.text();
      return jsonResponse({ success: false, error: `QBO P&L failed: ${resp.status} ${body}` }, 500);
    }
    const report = await resp.json() as Record<string, unknown>;
    const rows = ((report.Rows as Record<string, unknown>)?.Row as Row[]) || [];

    // Find expense sections — QBO P&L typically has "Expenses" and sometimes "OtherExpenses" / "COGS"
    const expensesSection = findSection(rows, "Expenses");
    const cogsSection = findSection(rows, "COGS");
    const otherExpensesSection = findSection(rows, "OtherExpenses");

    const expenses: Array<{ name: string; amount: number; section: string }> = [];
    if (expensesSection?.Rows?.Row) {
      const tmp: Array<{ name: string; amount: number }> = [];
      flattenExpenseRows(expensesSection.Rows.Row, tmp);
      for (const e of tmp) expenses.push({ ...e, section: "Expenses" });
    }
    if (cogsSection?.Rows?.Row) {
      const tmp: Array<{ name: string; amount: number }> = [];
      flattenExpenseRows(cogsSection.Rows.Row, tmp);
      for (const e of tmp) expenses.push({ ...e, section: "COGS" });
    }
    if (otherExpensesSection?.Rows?.Row) {
      const tmp: Array<{ name: string; amount: number }> = [];
      flattenExpenseRows(otherExpensesSection.Rows.Row, tmp);
      for (const e of tmp) expenses.push({ ...e, section: "OtherExpenses" });
    }

    // Income for reference
    const incomeSection = findSection(rows, "Income");
    const income: Array<{ name: string; amount: number }> = [];
    if (incomeSection?.Rows?.Row) flattenExpenseRows(incomeSection.Rows.Row, income);

    // Write to cache
    const sb = getServiceClient();
    // Clear existing cache for this period
    await sb.from("plan_qbo_pl_cache").delete().eq("period_start", start).eq("period_end", end);
    const rowsToInsert = [
      ...expenses.map((e) => ({
        period_start: start,
        period_end: end,
        account_name: e.name,
        account_type: e.section,
        amount: e.amount,
      })),
      ...income.map((i) => ({
        period_start: start,
        period_end: end,
        account_name: i.name,
        account_type: "Income",
        amount: i.amount,
      })),
    ];
    if (rowsToInsert.length > 0) {
      await sb.from("plan_qbo_pl_cache").insert(rowsToInsert);
    }

    return jsonResponse({
      success: true,
      period: { start, end },
      expenses,
      income,
      total_expenses: expenses.reduce((s, e) => s + e.amount, 0),
      total_income: income.reduce((s, i) => s + i.amount, 0),
    });
  } catch (err) {
    return jsonResponse({ success: false, error: (err as Error).message }, 500);
  }
});
