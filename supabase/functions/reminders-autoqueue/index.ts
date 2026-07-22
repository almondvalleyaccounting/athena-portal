// reminders-autoqueue — Athena Portal
// Cron-driven filler for the Client Reminders queue. It QUEUES only —
// never sends. A human still reviews and releases from the queue.
//
// Triggered by pg_cron (run_reminders_autoqueue) every 15 minutes during
// January and July. Authenticated by an x-cron-secret header matched
// against reminder_autoqueue_config; gated on that row's `enabled` flag.
//
// Each run, against the MOST RECENT tax_payment_batches upload:
//   * opted-in + unpaid clients  → on or after the trigger working day,
//                                   queue the 'reminder' (figure + bank
//                                   details), once per batch — so late
//                                   opt-ins are still caught;
//   * undecided clients          → queue the 'promo' opt-in invite,
//                                   once per batch (a client who has opted
//                                   in/out never lands here again);
//   * opted-out / former clients → skipped.
// Opt-in decisions persist, so an opt-in received in (say) November is
// recognised in the January run and that client gets the reminder direct.
//
// Body: { dry_run?: boolean, force?: boolean }  (force bypasses the
// Jan/Jul month gate — for a manual test run).

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", ...corsHeaders } });
}

// ── Render helpers (mirror reminders-send; copy lives in comm_templates) ──
function esc(s: unknown): string {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function greetingName(name: string | null | undefined): string {
  const n = String(name ?? "").trim();
  if (!n) return "there";
  if (/\b(ltd|limited|llp|plc|lp|partnership|associates|company|co\.)\b/i.test(n)) return n;
  // Names are often stored "Surname, Forename" — take the forename part.
  let base = n;
  if (n.includes(",")) {
    const after = n.split(",")[1];
    if (after && after.trim()) base = after.trim();
  }
  return base.split(/\s+/)[0];
}
function wrapShell(innerHtml: string): string {
  return `<!doctype html><html><body style="margin:0;padding:0;background:#ffffff;">
    <div style="max-width:640px;margin:0;padding:14px 6px;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;color:#222222;">
      ${innerHtml}
    </div>
  </body></html>`;
}
function fmtMoney(amount: number): string {
  return Number(amount).toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function fmtDateLong(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(`${String(iso).slice(0, 10)}T00:00:00Z`);
  if (isNaN(d.getTime())) return String(iso);
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
}
const PAY_URL = "https://www.gov.uk/pay-self-assessment-tax-bill";
const PTA_URL = "https://www.gov.uk/personal-tax-account";
function taxPaymentRef(raw: string | null | undefined): string {
  const digits = String(raw ?? "").replace(/\D/g, "");
  if (digits.length >= 10) return `${digits.slice(0, 10)}K`;
  return "";
}
// Bare 10-digit UTR (tax_reminder_ignore key), or '' if fewer than 10.
function utr10(raw: string | null | undefined): string {
  const d = String(raw ?? "").replace(/\D/g, "");
  return d.length >= 10 ? d.slice(0, 10) : "";
}
function renderStr(s: string, vars: Record<string, string>): string {
  return String(s ?? "").replace(/\{\{\s*(\w+)\s*\}\}/g, (_m, k) => (k in vars ? String(vars[k] ?? "") : ""));
}
function genToken(): string {
  const b = crypto.getRandomValues(new Uint8Array(18));
  return Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join("");
}
function renderEmail(tmpl: { subject: string; body_html: string; body_text: string }, vars: Record<string, string>) {
  const htmlVars: Record<string, string> = {};
  for (const [k, v] of Object.entries(vars)) htmlVars[k] = esc(v);
  return {
    subject: renderStr(tmpl.subject, vars),
    html: wrapShell(renderStr(tmpl.body_html, htmlVars)),
    text: renderStr(tmpl.body_text, vars),
  };
}

// Nth working day (Mon–Fri, excluding the given holiday dates) of a month,
// returned as 'YYYY-MM-DD'. Used for the payment-reminder trigger day.
function nthWorkingDay(year: number, month: number, n: number, holidays: Set<string>): string | null {
  let count = 0;
  for (let day = 1; day <= 31; day++) {
    const d = new Date(Date.UTC(year, month - 1, day));
    if (d.getUTCMonth() !== month - 1) break; // rolled into next month
    const dow = d.getUTCDay();
    if (dow === 0 || dow === 6) continue; // weekend
    const iso = d.toISOString().slice(0, 10);
    if (holidays.has(iso)) continue; // bank holiday
    if (++count === n) return iso;
  }
  return null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ success: false, error: "POST required" }, 405);

  const service = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  const { data: cfg } = await service.from("reminder_autoqueue_config").select("*").eq("id", true).maybeSingle();
  if (!cfg) return json({ success: false, error: "not configured" }, 400);

  const secret = req.headers.get("x-cron-secret") || "";
  if (!cfg.cron_secret || secret !== cfg.cron_secret) return json({ success: false, error: "bad cron secret" }, 401);

  let body: { dry_run?: boolean; force?: boolean } = {};
  try { body = await req.json(); } catch { /* empty body ok */ }
  const dryRun = !!body.dry_run;
  const force = !!body.force;

  if (!cfg.enabled) return json({ success: true, skipped: "auto-queue disabled" });

  // "Today" in UK local time (Jan = GMT, Jul = BST).
  const londonToday = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London" }).format(new Date());
  const [ty, tm] = londonToday.split("-").map(Number);
  if (!force && tm !== 1 && tm !== 7) return json({ success: true, skipped: `not a run month (${tm})` });

  // Payment reminders start on a trigger working day and then keep filling
  // for the rest of the run month — 5th working day of January, 1st working
  // day of July (weekends + Scottish bank holidays excluded). It's ON OR
  // AFTER, not just that one day: opt-ins arrive throughout the month (the
  // offer campaign runs all month), so anyone who opts in after the trigger
  // day still gets their reminder on the next run. Dedup keeps it to one per
  // client per batch. (Offers are queued throughout the month regardless.)
  const reminderN = tm === 1 ? 5 : tm === 7 ? 1 : 0;
  let triggerDate: string | null = null;
  if (reminderN) {
    try {
      const hjson = await (await fetch("https://www.gov.uk/bank-holidays.json")).json();
      const events = (hjson?.scotland?.events || []) as Array<{ date: string }>;
      triggerDate = nthWorkingDay(ty, tm, reminderN, new Set(events.map((e) => e.date)));
    } catch (_e) {
      triggerDate = null; // holidays unavailable → don't risk the wrong day
    }
  }
  // YYYY-MM-DD strings compare correctly with >=.
  const remindersOpen = !!triggerDate && londonToday >= triggerDate;

  const commType = (cfg.comm_type as string) || "tax_reminders";

  // Most recent uploaded batch.
  const { data: batch } = await service.from("tax_payment_batches")
    .select("id, due_date").order("created_at", { ascending: false }).limit(1).maybeSingle();
  if (!batch) return json({ success: true, skipped: "no batch uploaded" });

  // Templates (single source of copy).
  const { data: tmpls } = await service.from("comm_templates")
    .select("kind, subject, body_html, body_text").eq("comm_type", commType);
  const tmplByKind: Record<string, { subject: string; body_html: string; body_text: string }> = {};
  for (const t of tmpls || []) tmplByKind[t.kind] = t;
  if (!tmplByKind.promo || !tmplByKind.reminder) return json({ success: false, error: "templates missing" }, 400);

  // Payable rows in this batch (matched + unpaid + has amount).
  const { data: rows } = await service.from("tax_payments_due")
    .select("id, entity_id, amount, status, reference_raw")
    .eq("batch_id", batch.id).eq("status", "unpaid").not("entity_id", "is", null);
  if (!rows || !rows.length) return json({ success: true, skipped: "no payable rows in latest batch" });

  const entityIds = [...new Set(rows.map((r) => r.entity_id))];

  // Entities, preferences, BM emails, and the dedup ledger.
  const [{ data: ents }, { data: prefs }, { data: bm }, { data: existing }, { data: ign }] = await Promise.all([
    service.from("entities").select("id, name, utr, billing_email, prospect_email, entity_status").in("id", entityIds),
    service.from("client_comm_preferences").select("entity_id, status").eq("comm_type", commType).in("entity_id", entityIds),
    service.from("v_email_reconciliation").select("entity_id, bm_contact_email").in("entity_id", entityIds),
    service.from("reminder_emails").select("entity_id, kind, batch_id, status").eq("comm_type", commType).in("entity_id", entityIds),
    service.from("tax_reminder_ignore").select("utr"),
  ]);
  // Manual exclusions (not-a-client OR client-excluded) — never send them
  // anything, keyed by the effective UTR (TaxCalc row or the entity's).
  const ignoreSet = new Set(((ign || []) as Array<{ utr: string }>).map((x) => x.utr));

  const entById: Record<string, { name: string; utr: string | null; billing_email: string; prospect_email: string; entity_status: string }> = {};
  for (const e of ents || []) entById[e.id] = e as never;
  const prefById: Record<string, string> = {};
  for (const p of prefs || []) prefById[p.entity_id] = p.status;
  const bmById: Record<string, string> = {};
  for (const b of bm || []) if (b.entity_id && !bmById[b.entity_id] && (b.bm_contact_email || "").trim()) bmById[b.entity_id] = b.bm_contact_email.trim();
  // One offer AND one reminder per client per batch. Offers go only to the
  // still-undecided (the pref check below), and once a client opts in/out
  // they never reach the promo branch again — so this is the per-batch cap
  // on repeat offers to people who haven't yet responded.
  const promoedThisBatch = new Set<string>();
  const remindedThisBatch = new Set<string>();
  for (const x of existing || []) {
    if (x.status === "dropped") continue;
    if (x.batch_id !== batch.id) continue;
    if (x.kind === "promo") promoedThisBatch.add(x.entity_id);
    if (x.kind === "reminder" || x.kind === "no_utr") remindedThisBatch.add(x.entity_id);
  }

  const now = new Date().toISOString();
  const toInsert: Record<string, unknown>[] = [];
  const counts = { promo: 0, reminder: 0, no_utr: 0, skipped_ignored: 0, skipped_no_email: 0, skipped_optout: 0, skipped_former: 0, skipped_dup: 0, skipped_no_ref: 0, skipped_not_trigger: 0 };

  for (const r of rows) {
    const ent = entById[r.entity_id];
    if (!ent) continue;
    if (["nlac", "archived"].includes(ent.entity_status)) { counts.skipped_former++; continue; }
    // Manually excluded (not a client, or client we've chosen not to remind).
    if (ignoreSet.has(utr10(r.reference_raw) || utr10(ent.utr))) { counts.skipped_ignored++; continue; }
    const to = (ent.billing_email || "").trim() || (ent.prospect_email || "").trim() || bmById[r.entity_id] || "";
    if (!to || !to.includes("@")) { counts.skipped_no_email++; continue; }

    const pref = prefById[r.entity_id]; // 'opted_in' | 'opted_out' | 'pending' | undefined
    if (pref === "opted_out") { counts.skipped_optout++; continue; }

    if (pref === "opted_in") {
      // Reminders are open from the trigger working day onward (one per
      // batch, deduped below). force bypasses the date gate for a test run.
      if (!remindersOpen && !force) { counts.skipped_not_trigger++; continue; }
      if (remindedThisBatch.has(r.entity_id)) { counts.skipped_dup++; continue; }
      // Reference from the TaxCalc row, falling back to the client's UTR on
      // the entity (e.g. added to BM after the file was uploaded).
      const paymentRef = taxPaymentRef(r.reference_raw as string | null) || taxPaymentRef(ent.utr);
      // No UTR anywhere → not registered with HMRC yet; use 'no_utr' variant.
      let effKind = "reminder";
      let effTmpl = tmplByKind.reminder;
      if (!paymentRef) {
        if (!tmplByKind.no_utr) { counts.skipped_no_ref++; continue; }
        effKind = "no_utr"; effTmpl = tmplByKind.no_utr;
      }
      const tok = genToken();
      // Payment-reminder links go through the click-tracking redirect.
      const clickBase = `${SUPABASE_URL}/functions/v1/comm-click?token=${encodeURIComponent(tok)}`;
      const vars = {
        first_name: greetingName(ent.name), amount: fmtMoney(Number(r.amount)),
        due_date: fmtDateLong(batch.due_date), payment_ref: paymentRef,
        pay_url: `${clickBase}&to=pay`, pta_url: `${clickBase}&to=pta`, opt_in_url: "", opt_out_url: "",
      };
      const c = renderEmail(effTmpl, vars);
      toInsert.push({
        kind: effKind, comm_type: commType, entity_id: r.entity_id, batch_id: batch.id, payment_id: r.id,
        to_email: to, subject: c.subject, token: tok, body_html: c.html, body_text: c.text,
        status: "queued", queued_at: now,
      });
      remindedThisBatch.add(r.entity_id);
      if (effKind === "no_utr") counts.no_utr++; else counts.reminder++;
    } else {
      // undecided / pending / never asked → opt-in (once per batch; once
      // they opt in/out they no longer land here at all).
      if (promoedThisBatch.has(r.entity_id)) { counts.skipped_dup++; continue; }
      const tok = genToken();
      const optBase = `${SUPABASE_URL}/functions/v1/comm-optin?token=${encodeURIComponent(tok)}`;
      const vars = {
        first_name: greetingName(ent.name), amount: "", due_date: fmtDateLong(batch.due_date),
        payment_ref: "", pay_url: PAY_URL, pta_url: PTA_URL,
        opt_in_url: `${optBase}&choice=in`, opt_out_url: `${optBase}&choice=out`,
      };
      const c = renderEmail(tmplByKind.promo, vars);
      toInsert.push({
        kind: "promo", comm_type: commType, entity_id: r.entity_id, batch_id: batch.id, payment_id: r.id,
        to_email: to, subject: c.subject, token: tok, body_html: c.html, body_text: c.text,
        status: "queued", queued_at: now,
      });
      promoedThisBatch.add(r.entity_id);
      counts.promo++;
    }
  }

  if (dryRun) return json({ success: true, dry_run: true, batch_id: batch.id, trigger_date: triggerDate, reminders_open: remindersOpen, would_queue: toInsert.length, counts });

  // Insert row-by-row so a single unique-index hit (the queue-uniqueness
  // backstop catching a dup from a concurrent run) skips just that row
  // rather than rolling back the whole queue-fill.
  let inserted = 0;
  for (const row of toInsert) {
    const { error } = await service.from("reminder_emails").insert(row);
    if (error) {
      if ((error as { code?: string }).code === "23505") { counts.skipped_dup++; continue; }
      return json({ success: false, error: `Queue insert failed: ${error.message}`, counts }, 500);
    }
    inserted++;
  }
  await service.from("reminder_autoqueue_config").update({ last_run_at: now }).eq("id", true);

  return json({ success: true, batch_id: batch.id, trigger_date: triggerDate, reminders_open: remindersOpen, queued: inserted, counts });
});
