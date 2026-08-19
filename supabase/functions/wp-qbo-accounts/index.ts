// wp-qbo-accounts
//
// The QuickBooks leg of a working paper: a client's chart of accounts, and the
// balance on a chosen account at a chosen date.
//
// Two modes, because they answer different questions and cost very differently:
//
//   chart    — every account in the file. Feeds the nominal-mapping picker.
//              One Account query, cheap, and the result is cached in
//              wp_qbo_account so the picker never waits on QuickBooks.
//
//   balances — the balance on the mapped accounts AS AT a date. Feeds the paper
//              itself. Uses the GeneralLedger report rather than Account
//              .CurrentBalance, because CurrentBalance is as-at-now and a
//              working paper is never as-at-now.
//
// WHY NOT TrialBalance. TrialBalance would give every account in one call, which
// is tempting. It reports on a DATE RANGE though, and for a balance sheet
// account you want cumulative-to-date, not movement-in-period. GeneralLedger
// with a start date at the file's beginning gives the closing balance, and
// BalanceSheet gives the same figure but only for accounts QBO chooses to show —
// a nominal with a nil balance disappears from BalanceSheet entirely, and
// "account not on the report" and "account has no balance" are different facts.
//
// SIGN. QuickBooks reports a liability's closing balance as a POSITIVE number
// when money is owed, in the Balance column of GeneralLedger. That is already
// the paper's footing for paye_control, so nothing is flipped here — the flip,
// where a file needs one, is wp_nominal_map.sign and belongs with the mapping,
// not with the fetch.
//
// Auth: staff or service only. verify_jwt is not authentication — the anon key
// is a valid JWT and ships in the frontend bundle.

import {
  getServiceClient, qboFetch, qboQuery, jsonResponse, corsHeaders,
} from "../_shared/qbo-client.ts";
import { requireStaffOrService, authErrorResponse } from "../_shared/require-staff.ts";

const cors = corsHeaders();

/** The earliest date any UK client file could hold a transaction. */
const LEDGER_EPOCH = "1990-01-01";

type AccountRow = {
  Id: string;
  Name?: string;
  FullyQualifiedName?: string;
  AccountType?: string;
  AccountSubType?: string;
  Classification?: string;
  Active?: boolean;
  CurrentBalance?: number;
};

/** Every account in a realm, paged. QBO caps a query at 1000 rows. */
async function fetchChart(realmId: string): Promise<AccountRow[]> {
  const out: AccountRow[] = [];
  const PAGE = 1000;
  let pos = 1;
  for (let page = 0; page < 10; page++) {
    const json = await qboQuery(
      `select * from Account startposition ${pos} maxresults ${PAGE}`,
      realmId,
    ) as { QueryResponse?: { Account?: AccountRow[] } };
    const batch = json?.QueryResponse?.Account ?? [];
    out.push(...batch);
    if (batch.length < PAGE) break;
    pos += PAGE;
  }
  return out;
}

/**
 * Walk a QBO report's nested Rows and hand back every row that carries an
 * account reference, with its closing Balance.
 *
 * QBO report JSON is a tree of Section rows containing Data rows, nested to an
 * arbitrary depth for sub-accounts, and the account id lives on ColData[0].id.
 * A Summary row repeats a section total with no id, which is why rows without
 * an id are skipped rather than summed — including them double-counts every
 * parent account.
 */
function harvestBalances(report: unknown): Map<string, number> {
  const found = new Map<string, number>();
  const colTitles: string[] = (
    (report as { Columns?: { Column?: { ColTitle?: string }[] } })?.Columns?.Column ?? []
  ).map((c) => c?.ColTitle ?? "");
  // The closing figure is the column QBO titles "Balance"; fall back to the
  // last column, which is what it is on every report shape seen so far.
  let balanceIdx = colTitles.findIndex((t) => /^balance$/i.test(t));
  if (balanceIdx < 0) balanceIdx = colTitles.length - 1;

  const walk = (rows: unknown[]) => {
    for (const row of rows ?? []) {
      const r = row as {
        ColData?: { value?: string; id?: string }[];
        Rows?: { Row?: unknown[] };
        Header?: { ColData?: { value?: string; id?: string }[] };
        type?: string;
      };
      const cd = r?.ColData;
      const id = cd?.[0]?.id;
      if (id) {
        const raw = cd?.[balanceIdx]?.value ?? "";
        const n = Number(String(raw).replace(/,/g, ""));
        if (raw !== "" && Number.isFinite(n)) {
          // A GeneralLedger can emit several rows for one account across
          // sections; the last closing balance wins, not the sum.
          found.set(id, n);
        }
      }
      // A section's own account id can sit on its Header rather than a ColData
      // row — sub-account parents come through this way.
      const hid = r?.Header?.ColData?.[0]?.id;
      if (hid && !found.has(hid)) {
        const raw = r.Header?.ColData?.[balanceIdx]?.value ?? "";
        const n = Number(String(raw).replace(/,/g, ""));
        if (raw !== "" && Number.isFinite(n)) found.set(hid, n);
      }
      if (r?.Rows?.Row) walk(r.Rows.Row);
    }
  };
  walk(((report as { Rows?: { Row?: unknown[] } })?.Rows?.Row) ?? []);
  return found;
}

async function fetchBalancesAsAt(realmId: string, asAt: string) {
  // GeneralLedger from the epoch to the date: the Balance column is then the
  // closing balance at the date, which is what a working paper needs.
  const path = `reports/GeneralLedger?start_date=${LEDGER_EPOCH}&end_date=${asAt}`
    + `&accounting_method=Accrual&columns=account_name,subt_nat_amount,balance&minorversion=75`;
  const resp = await qboFetch(path, {}, realmId);
  if (!resp.ok) {
    throw new Error(`GeneralLedger ${resp.status}: ${(await resp.text()).slice(0, 300)}`);
  }
  return harvestBalances(await resp.json());
}

/**
 * BalanceSheet as a cross-check on GeneralLedger.
 *
 * Two independent reports agreeing is the only evidence available that a
 * closing balance was read correctly — there is no third source inside
 * QuickBooks. Where they disagree the paper must say so rather than pick one,
 * so both figures are returned.
 */
async function fetchBalanceSheetAsAt(realmId: string, asAt: string) {
  const path = `reports/BalanceSheet?start_date=${LEDGER_EPOCH}&end_date=${asAt}`
    + `&accounting_method=Accrual&minorversion=75`;
  const resp = await qboFetch(path, {}, realmId);
  if (!resp.ok) return new Map<string, number>();
  return harvestBalances(await resp.json());
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  let caller;
  try { caller = await requireStaffOrService(req); }
  catch (e) { return authErrorResponse(e, cors); }

  const sb = getServiceClient();

  try {
    const body = req.method === "POST" ? await req.json().catch(() => ({})) : {};
    const url = new URL(req.url);
    const mode = String(body.mode ?? url.searchParams.get("mode") ?? "chart");
    const realmId = String(body.realm_id ?? url.searchParams.get("realm_id") ?? "");
    if (!realmId) return jsonResponse({ success: false, error: "realm_id is required" }, 400);

    if (mode === "chart") {
      const accounts = await fetchChart(realmId);
      const rows = accounts.map((a) => ({
        realm_id: realmId,
        account_id: a.Id,
        name: a.Name ?? null,
        fully_qualified: a.FullyQualifiedName ?? null,
        account_type: a.AccountType ?? null,
        account_sub_type: a.AccountSubType ?? null,
        classification: a.Classification ?? null,
        active: a.Active ?? null,
        current_balance: a.CurrentBalance ?? null,
        pulled_at: new Date().toISOString(),
      }));
      if (rows.length) {
        const { error } = await sb.from("wp_qbo_account")
          .upsert(rows, { onConflict: "realm_id,account_id" });
        if (error) throw new Error(`Caching chart failed: ${error.message}`);
      }
      return jsonResponse({ success: true, mode, realm_id: realmId, accounts: rows.length });
    }

    if (mode === "balances") {
      const asAt = String(body.as_at ?? url.searchParams.get("as_at") ?? "");
      if (!/^\d{4}-\d{2}-\d{2}$/.test(asAt)) {
        return jsonResponse({ success: false, error: "as_at must be YYYY-MM-DD" }, 400);
      }
      // Only the accounts somebody has actually mapped. Storing a balance for
      // all 300 nominals in a file at every year end would be a lot of rows
      // nobody reads, and the mapping is the statement of what matters.
      const { data: mapped, error: mapErr } = await sb
        .from("wp_nominal_map")
        .select("qbo_account_id, entity_id, role")
        .in("entity_id", (
          await sb.from("qbo_report_connections").select("entity_id")
            .eq("realm_id", realmId).eq("status", "active")
        ).data?.map((r: { entity_id: string }) => r.entity_id).filter(Boolean) ?? []);
      if (mapErr) throw new Error(`Reading the mapping failed: ${mapErr.message}`);

      const wanted = [...new Set((mapped ?? []).map((m: { qbo_account_id: string }) => m.qbo_account_id))];
      if (!wanted.length) {
        return jsonResponse({
          success: true, mode, realm_id: realmId, as_at: asAt, stored: 0,
          note: "No nominals are mapped for this client yet, so there is nothing to value.",
        });
      }

      const gl = await fetchBalancesAsAt(realmId, asAt);
      const bs = await fetchBalanceSheetAsAt(realmId, asAt);

      const rows: Record<string, unknown>[] = [];
      const disagreements: Record<string, unknown>[] = [];
      const absent: string[] = [];
      for (const accountId of wanted) {
        const glv = gl.get(accountId);
        const bsv = bs.get(accountId);
        if (glv == null && bsv == null) { absent.push(accountId); continue; }
        const value = glv ?? bsv!;
        if (glv != null && bsv != null && Math.abs(glv - bsv) > 0.005) {
          disagreements.push({ account_id: accountId, general_ledger: glv, balance_sheet: bsv });
        }
        rows.push({
          realm_id: realmId, account_id: accountId, as_at: asAt,
          balance: value, pulled_at: new Date().toISOString(),
        });
      }

      if (rows.length) {
        const { error } = await sb.from("wp_qbo_balance")
          .upsert(rows, { onConflict: "realm_id,account_id,as_at" });
        if (error) throw new Error(`Storing balances failed: ${error.message}`);
      }

      return jsonResponse({
        success: true, mode, realm_id: realmId, as_at: asAt,
        stored: rows.length,
        // An account with no row on either report is not a zero balance — it is
        // an account QuickBooks did not report, which usually means the mapping
        // points at an id that no longer exists in the file.
        absent_from_reports: absent,
        // Two reports disagreeing on a closing balance is a real finding, not a
        // rounding note. It is returned rather than swallowed.
        report_disagreements: disagreements,
        caller: caller.kind,
      });
    }

    return jsonResponse({ success: false, error: `Unknown mode '${mode}'. Use chart or balances.` }, 400);
  } catch (e) {
    return jsonResponse({ success: false, error: (e as Error).message }, 500);
  }
});
