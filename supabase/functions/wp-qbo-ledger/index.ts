// wp-qbo-ledger
//
// GeneralLedger DETAIL for one nominal in a client's QuickBooks: every posting
// to the account over a date range, with its date, type, document number, name,
// memo, amount and running balance.
//
// Why this exists. wp-qbo-accounts answers "what is the balance at a date"; it
// cannot answer "how did it get there". For CIS that second question is the only
// one worth asking, because HMRC never states the claim. HMRC's PAYE account
// shows credit CONSUMED — the EPS lines on a monthly bill equal the credit
// allocated to it, to the penny, on every year measured — so the gross CIS
// suffered has to come from the client's own ledger. See
// docs/hmrc-timing-and-cis-rules.md.
//
// "Not allocated" on HMRC's credits page is not a balance. It keeps that label
// after the money has gone: LJM Gas Glasgow's 2024-25 shows £19,173.29 not
// allocated, which is exactly the sum transferred to Corporation Tax on
// 18 Dec 2025 and still sitting there under the old label ten months later.
// Anything reading that figure as available credit overstates it.
//
// SIGN. Returned exactly as QuickBooks reports it — an asset's debit is
// positive. Nothing is flipped here; wp_nominal_map.sign is where a file that
// needs a flip declares it, and that belongs with the mapping, not the fetch.
//
// NOT CACHED. wp-qbo-accounts caches balances because a working paper is fixed
// at a date and re-reads it often. A ledger pull is a reconciliation, run when
// somebody is looking, and caching rows here would mean deciding when a range
// went stale. The caller gets what QuickBooks says now.
//
// Auth: staff or service only. verify_jwt is NOT authentication — the anon key
// is a valid JWT for this project and ships in the frontend bundle. Portal
// clients hold `authenticated` alongside staff, so a JWT alone must never reach
// a client's ledger.

import { qboFetch, jsonResponse, corsHeaders } from "../_shared/qbo-client.ts";
import { requireStaffOrService, authErrorResponse } from "../_shared/require-staff.ts";

const cors = corsHeaders();

/** The earliest date any UK client file could hold a transaction. */
const LEDGER_EPOCH = "1990-01-01";

// `balance` is asked for and QuickBooks drops it when the report is filtered to
// one account — it came back with seven columns for the eight requested. So the
// running balance is computed here from the opening rather than read, and the
// column lookup never assumes the columns it asked for are the columns it got.
const COLUMNS = [
  "tx_date", "txn_type", "doc_num", "name", "memo",
  "account_name", "subt_nat_amount", "balance",
].join(",");

type Row = {
  date: string | null;
  txn_type: string | null;
  doc_num: string | null;
  name: string | null;
  memo: string | null;
  amount: number | null;
  balance: number | null;
};

const num = (raw: unknown): number | null => {
  const s = String(raw ?? "").replace(/,/g, "").trim();
  if (s === "") return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};

/**
 * Walk the report for the rows belonging to one account.
 *
 * GeneralLedger nests: a section per account, whose Header carries the account
 * id, with the postings as ColData rows beneath and a Summary closing it. The
 * account id appears on the section, NOT on each posting, so the walk has to
 * carry it down rather than read it off the row — which is why this cannot be a
 * flat filter.
 */
function harvestAccount(report: unknown, accountId: string) {
  const rows: Row[] = [];
  let stated: number | null = null;

  // The column's real name is in MetaData.ColKey. ColType is a datatype — four
  // of the seven columns come back as "String" — so matching on it silently
  // found nothing and the first version of this returned no rows at all.
  const cols = (report as {
    Columns?: {
      Column?: {
        ColType?: string;
        ColTitle?: string;
        MetaData?: { Name?: string; Value?: string }[];
      }[];
    };
  })?.Columns?.Column ?? [];
  const keys = cols.map((c) =>
    String(c?.MetaData?.find((m) => m?.Name === "ColKey")?.Value ?? c?.ColTitle ?? ""));
  const at = (k: string) => keys.findIndex((c) => c === k);

  const iDate = at("tx_date"), iType = at("txn_type"), iDoc = at("doc_num");
  const iName = at("name"), iMemo = at("memo");
  const iAmt = at("subt_nat_amount"), iBal = at("balance");

  const walk = (list: unknown[], inside: boolean) => {
    for (const raw of list ?? []) {
      const r = raw as {
        ColData?: { value?: string; id?: string }[];
        Header?: { ColData?: { value?: string; id?: string }[] };
        Summary?: { ColData?: { value?: string; id?: string }[] };
        Rows?: { Row?: unknown[] };
      };

      // A section for our account turns the walk on for its children only.
      const headerId = r?.Header?.ColData?.[0]?.id;
      const mine = inside || (headerId != null && headerId === accountId);

      if (mine && r?.ColData) {
        const cd = r.ColData;
        // The closing line has no date and carries the running total.
        const date = iDate >= 0 ? (cd[iDate]?.value ?? "") : "";
        if (date) {
          rows.push({
            date,
            txn_type: iType >= 0 ? (cd[iType]?.value ?? null) : null,
            doc_num: iDoc >= 0 ? (cd[iDoc]?.value ?? null) : null,
            name: iName >= 0 ? (cd[iName]?.value ?? null) : null,
            memo: iMemo >= 0 ? (cd[iMemo]?.value ?? null) : null,
            amount: iAmt >= 0 ? num(cd[iAmt]?.value) : null,
            balance: iBal >= 0 ? num(cd[iBal]?.value) : null,
          });
        }
      }

      // "Total for CIS suffered" — QuickBooks' own figure for the range. Kept to
      // check our sum against rather than to replace it: two numbers that agree
      // are evidence, one number is an assertion.
      if (mine && r?.Summary?.ColData) {
        const v = num(r.Summary.ColData[iAmt >= 0 ? iAmt : r.Summary.ColData.length - 1]?.value);
        if (v != null) stated = v;
      }

      if (r?.Rows?.Row) walk(r.Rows.Row, mine);
    }
  };
  walk(((report as { Rows?: { Row?: unknown[] } })?.Rows?.Row) ?? [], false);

  // Running balance, computed because QuickBooks drops the balance column on a
  // filtered report. With start at the epoch the running total IS the closing
  // balance; with a later start it is the movement, which is why the response
  // names both and lets the caller say which it wanted.
  if (iBal < 0) {
    let acc = 0;
    for (const r of rows) { acc += r.amount ?? 0; r.balance = Math.round(acc * 100) / 100; }
  }
  return { rows, stated };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  try { await requireStaffOrService(req, "can_view_reports"); }
  catch (e) { return authErrorResponse(e, cors); }

  try {
    const url = new URL(req.url);
    const body = req.method === "POST" ? await req.json().catch(() => ({})) : {};
    const pick = (k: string) => String(body[k] ?? url.searchParams.get(k) ?? "");

    const realmId = pick("realm_id");
    const accountId = pick("account_id");
    if (!realmId) return jsonResponse({ success: false, error: "realm_id is required" }, 400);
    if (!accountId) return jsonResponse({ success: false, error: "account_id is required" }, 400);

    const isDate = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s);
    const start = pick("start") || LEDGER_EPOCH;
    const end = pick("end") || new Date().toISOString().slice(0, 10);
    if (!isDate(start) || !isDate(end)) {
      return jsonResponse({ success: false, error: "start and end must be YYYY-MM-DD" }, 400);
    }
    if (start > end) {
      return jsonResponse({ success: false, error: "start is after end" }, 400);
    }

    // Asking QuickBooks for one account rather than filtering the whole file:
    // a GeneralLedger over 35 years of every nominal is large enough to time
    // out, and the report honours the filter.
    const path = `reports/GeneralLedger?start_date=${start}&end_date=${end}`
      + `&accounting_method=Accrual&columns=${COLUMNS}`
      + `&account=${encodeURIComponent(accountId)}&minorversion=75`;

    const resp = await qboFetch(path, {}, realmId);
    if (!resp.ok) {
      const detail = (await resp.text()).slice(0, 300);
      return jsonResponse({
        success: false,
        error: `GeneralLedger ${resp.status}: ${detail}`,
      }, 502);
    }

    const report = await resp.json();
    if (pick("debug") === "1") {
      return jsonResponse({ success: true, raw: report });
    }

    const { rows, stated } = harvestAccount(report, accountId);
    const movement = Math.round(rows.reduce((a, r) => a + (r.amount ?? 0), 0) * 100) / 100;

    return jsonResponse({
      success: true,
      realm_id: realmId,
      account_id: accountId,
      start, end,
      rows: rows.length,
      movement,
      // QuickBooks' own total for the range, kept beside ours rather than
      // instead of it. A disagreement means a row was dropped, and a ledger
      // that quietly loses a posting is worse than no ledger.
      stated_total: stated,
      ties: stated == null ? null : Math.abs(stated - movement) < 0.005,
      // Only a run from the epoch closes at a balance; a later start gives
      // movement in the window, so this is null rather than a wrong figure.
      closing_balance: start === LEDGER_EPOCH ? movement : null,
      ledger: rows,
    });
  } catch (e) {
    return jsonResponse({ success: false, error: (e as Error).message }, 500);
  }
});
