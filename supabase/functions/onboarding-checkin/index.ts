// onboarding-checkin — Athena Portal
// Automated 3-month client check-in (cron: run_onboarding_checkin, daily).
//
// The check-in panel schedules the check-in (onboardings.checkin_due, default
// started_at + 3 months). This function sends the email automatically when it
// falls due, so staff don't have to remember to click "send". It delegates the
// actual send to onboarding-emails (kind=checkin) via the cron secret, so the
// template + checkin_sent_at + activity side-effects stay in one place.
//
// Recency guard: only sends check-ins that became due within the last
// `max_overdue_days` (default 60). This deliberately skips the historical
// checkin_due backfill (onboardings set up long ago) so arming automation never
// mass-emails a backlog — those can still be sent by hand from the panel.
//
// Auth: x-cron-secret matching onboarding_chase_config.cron_secret, OR an
// active staff JWT (manual test runs).
// Body: { dry_run?: boolean, max_overdue_days?: number, limit?: number }

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const DEFAULT_MAX_OVERDUE_DAYS = 60;
const DEFAULT_LIMIT = 50;

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}
function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}
function isoDaysAgo(n: number): string {
  return new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
}

type Row = Record<string, unknown>;

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ success: false, error: "POST required" }, 405);
  const service = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  const { data: cfg } = await service.from("onboarding_chase_config")
    .select("cron_secret, checkin_auto_send_enabled").eq("id", true).maybeSingle();
  const expected = (cfg?.cron_secret as string) || "";
  const got = req.headers.get("x-cron-secret") || "";
  const cronAuthed = Boolean(expected && got === expected);
  if (!cronAuthed) {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return json({ success: false, error: "Missing authorization" }, 401);
    const anon = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { global: { headers: { Authorization: authHeader } } });
    const { data: { user }, error: authErr } = await anon.auth.getUser();
    if (authErr || !user) return json({ success: false, error: "Invalid token" }, 401);
    const { data: prof } = await service.from("staff_profiles").select("is_active").eq("id", user.id).single();
    if (!prof?.is_active) return json({ success: false, error: "Not authorised" }, 403);
  }

  const body = await req.json().catch(() => ({}));
  const dryRun = body.dry_run === true;
  const maxOverdue = Number.isFinite(body.max_overdue_days) ? Number(body.max_overdue_days) : DEFAULT_MAX_OVERDUE_DAYS;
  const limit = Number.isFinite(body.limit) ? Number(body.limit) : DEFAULT_LIMIT;

  // Self-gating: only cron (automated) runs respect the enable flag. A staff
  // JWT test run always proceeds so it can be exercised while disarmed.
  if (cronAuthed && !cfg?.checkin_auto_send_enabled) {
    return json({ success: true, skipped: "checkin_auto_send_enabled is off", sent: 0 });
  }

  const today = todayISO();
  const floor = isoDaysAgo(maxOverdue);

  // Due = checkin_due on/before today, not yet sent, still an active engagement,
  // and not older than the recency floor.
  const { data: due, error } = await service.from("onboardings")
    .select("id, checkin_due, entity:entities!onboardings_entity_id_fkey(name, billing_email, prospect_email)")
    .lte("checkin_due", today)
    .gte("checkin_due", floor)
    .is("checkin_sent_at", null)
    .in("status", ["active", "on_hold", "issues"])
    .order("checkin_due")
    .limit(limit);
  if (error) return json({ success: false, error: error.message }, 500);

  const rows = (due || []) as Row[];
  // Only those with a usable client email — mirrors onboarding-emails' own check.
  const sendable = rows.filter((o) => {
    const ent = o.entity as Row;
    const email = ((ent?.billing_email as string) || (ent?.prospect_email as string) || "").split(/[;,]/)[0]?.trim();
    return email && email.includes("@");
  });

  if (dryRun) {
    return json({
      success: true, dry_run: true, due: rows.length, sendable: sendable.length,
      window: { from: floor, to: today },
      preview: sendable.slice(0, 20).map((o) => ({ id: o.id, entity: (o.entity as Row)?.name, due: o.checkin_due })),
    });
  }

  const results: Array<{ id: string; ok: boolean; error?: string }> = [];
  for (const o of sendable) {
    try {
      const resp = await fetch(`${SUPABASE_URL}/functions/v1/onboarding-emails`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-cron-secret": expected,
          // Edge-to-edge call still needs an apikey/bearer for the gateway.
          "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
          "apikey": SUPABASE_SERVICE_ROLE_KEY,
        },
        body: JSON.stringify({ onboarding_id: o.id, kind: "checkin" }),
      });
      const jr = await resp.json().catch(() => ({}));
      results.push({ id: o.id as string, ok: resp.ok && jr?.success !== false, error: jr?.error });
    } catch (e) {
      results.push({ id: o.id as string, ok: false, error: String(e) });
    }
  }

  const sent = results.filter((r) => r.ok).length;
  return json({ success: true, due: rows.length, sendable: sendable.length, sent, failed: results.filter((r) => !r.ok) });
});
