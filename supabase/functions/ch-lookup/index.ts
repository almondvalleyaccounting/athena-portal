// ch-lookup — Athena Portal
// Automates the "Companies House search" onboarding step: resolves the
// company (entities.company_number, or a CH name search — saving the number
// back to the entity), fetches the profile + active officers, caches them on
// onboardings.ch_data, auto-completes the search step and posts a summary
// to the activity timeline.
//
// Auth: active staff JWT, OR x-cron-secret (onboarding automation secret)
// so it can be fired automatically when an onboarding is created.
// Body: { onboarding_id: string }

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const CH_API_KEY = Deno.env.get("CH_API_KEY") ?? "";
const CH_BASE = "https://api.company-information.service.gov.uk";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", ...corsHeaders } });
}

function chAuth() {
  return { Authorization: `Basic ${btoa(CH_API_KEY + ":")}` };
}

// CH returns "SMITH, John Alexander" — flip to "John Alexander Smith"
function friendlyName(raw: string): string {
  const m = String(raw || "").split(",");
  const flipped = m.length === 2 ? `${m[1].trim()} ${m[0].trim()}` : String(raw || "");
  return flipped.toLowerCase().replace(/(^|[\s\-'])\w/g, (c) => c.toUpperCase());
}

function fmtAddress(a: Record<string, unknown> | null): string {
  if (!a) return "";
  return [a.address_line_1, a.address_line_2, a.locality, a.region, a.postal_code]
    .filter(Boolean).join(", ");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ success: false, error: "POST required" }, 405);

  const service = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  // ── Auth: automation secret OR active-staff JWT ──
  const cronHeader = req.headers.get("x-cron-secret") || "";
  const { data: cfg } = await service.from("onboarding_chase_config").select("cron_secret").eq("id", true).maybeSingle();
  const expectedSecret = (cfg?.cron_secret as string) || "";
  if (!(expectedSecret && cronHeader && cronHeader === expectedSecret)) {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return json({ success: false, error: "Missing authorization" }, 401);
    const anon = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { global: { headers: { Authorization: authHeader } } });
    const { data: { user }, error: authErr } = await anon.auth.getUser();
    if (authErr || !user) return json({ success: false, error: "Invalid token" }, 401);
    const { data: prof } = await service.from("staff_profiles").select("is_active").eq("id", user.id).single();
    if (!prof?.is_active) return json({ success: false, error: "Not authorised" }, 403);
  }

  if (!CH_API_KEY) return json({ success: false, error: "CH_API_KEY secret is not set." }, 500);

  const body = await req.json().catch(() => ({}));
  const onboardingId: string | null = body.onboarding_id || null;
  if (!onboardingId) return json({ success: false, error: "onboarding_id required" }, 400);

  const { data: ob, error: obErr } = await service
    .from("onboardings")
    .select("id, entity_id, entity:entities!onboardings_entity_id_fkey(id, name, company_number)")
    .eq("id", onboardingId)
    .single();
  if (obErr || !ob) return json({ success: false, error: obErr?.message || "Onboarding not found" }, 404);

  const ent = ob.entity as Record<string, unknown>;
  let companyNumber: string | null = ent?.company_number ? String(ent.company_number).padStart(8, "0") : null;
  let matchedBy = "entity company_number";

  // No number on file → search CH by name and take a confident top match
  if (!companyNumber) {
    const q = encodeURIComponent(String(ent?.name || ""));
    const searchResp = await fetch(`${CH_BASE}/search/companies?q=${q}&items_per_page=5`, { headers: chAuth() });
    if (!searchResp.ok) return json({ success: false, error: `CH search failed: ${searchResp.status}` }, 502);
    const search = await searchResp.json();
    const norm = (s: string) => s.toLowerCase().replace(/\b(ltd|limited|llp)\b/g, "").replace(/[^a-z0-9]/g, "");
    const top = (search.items || []).find((it: Record<string, unknown>) =>
      norm(String(it.title || "")) === norm(String(ent?.name || "")));
    if (!top) {
      await service.from("onboarding_activity").insert({
        onboarding_id: onboardingId, kind: "system",
        body: `Companies House lookup: no confident match found for "${ent?.name}" — complete the search step manually.`,
      });
      return json({ success: false, error: "No confident Companies House match — check the company name or add the company number to the client." }, 404);
    }
    companyNumber = String(top.company_number);
    matchedBy = "name search";
    // Save the number back so every later integration has it
    await service.from("entities").update({ company_number: companyNumber }).eq("id", ob.entity_id);
  }

  // Profile + active officers
  const [profileResp, officersResp] = await Promise.all([
    fetch(`${CH_BASE}/company/${companyNumber}`, { headers: chAuth() }),
    fetch(`${CH_BASE}/company/${companyNumber}/officers?items_per_page=50`, { headers: chAuth() }),
  ]);
  if (!profileResp.ok) return json({ success: false, error: `CH profile failed: ${profileResp.status}` }, 502);
  const p = await profileResp.json();
  const officersRaw = officersResp.ok ? await officersResp.json() : { items: [] };
  const officers = ((officersRaw.items || []) as Array<Record<string, unknown>>)
    .filter((o) => !o.resigned_on && ["director", "llp-member", "member"].includes(String(o.officer_role)))
    .map((o) => ({
      name: friendlyName(String(o.name)),
      role: o.officer_role,
      appointed_on: o.appointed_on || null,
    }));

  const chData = {
    fetched_at: new Date().toISOString(),
    matched_by: matchedBy,
    profile: {
      company_name: p.company_name,
      company_number: p.company_number,
      company_status: p.company_status,
      date_of_creation: p.date_of_creation,
      registered_office: fmtAddress(p.registered_office_address || null),
      accounts_next_due: p.accounts?.next_due || null,
      confirmation_statement_next_due: p.confirmation_statement?.next_due || null,
      sic_codes: p.sic_codes || [],
    },
    officers,
  };

  await service.from("onboardings").update({ ch_data: chData }).eq("id", onboardingId);

  // Auto-complete the "Companies House search" step if still open
  const { data: step } = await service
    .from("onboarding_steps")
    .select("id, status")
    .eq("onboarding_id", onboardingId)
    .ilike("name", "%companies house search%")
    .maybeSingle();
  let stepCompleted = false;
  if (step && !["complete", "na"].includes(step.status)) {
    await service.from("onboarding_steps").update({
      status: "complete", completed_at: new Date().toISOString(),
      note: "Completed automatically — profile and officers pulled from the Companies House API.",
    }).eq("id", step.id);
    stepCompleted = true;
  }

  const warn = p.company_status !== "active" ? ` ⚠ Company status is "${p.company_status}".` : "";
  await service.from("onboarding_activity").insert({
    onboarding_id: onboardingId, kind: "system",
    body: `Companies House lookup (${matchedBy}): ${p.company_name} (${p.company_number}), incorporated ${p.date_of_creation}.` +
      ` Registered office: ${chData.profile.registered_office}.` +
      (chData.profile.accounts_next_due ? ` Accounts next due ${chData.profile.accounts_next_due}.` : "") +
      ` Directors: ${officers.map((o) => o.name).join(", ") || "none found"}.${warn}` +
      (stepCompleted ? "\nThe Companies House search step was completed automatically." : ""),
  });

  return json({ success: true, company_number: p.company_number, officers: officers.length, step_completed: stepCompleted, status: p.company_status });
});
