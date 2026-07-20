// ch-ingest-officers (v8)
// Pulls officers + PSCs + company profile (status, Confirmation Statement due)
// from Companies House for limited companies.
//
// Two entry modes:
//   * Staff (JWT, can_manage_portal): manual refresh from the Data Import UI.
//     Body: { limit?, force?, only? } — same contract as before.
//   * Cron (x-cron-secret = ch_refresh_config.cron_secret): nightly mode.
//     Body: { mode: 'nightly' } — refreshes the ~35 stalest companies
//     (skips anything refreshed <20h ago) and logs into ch_refresh_runs.
//
// Rate limiting: CH allows 600 requests / 5 min. We fire 3 requests per
// company, so we pace to ~1.4s per company (~2.1 req/s worst case is capped
// by the pacing wait). On a 429 we read Retry-After, wait if it's short,
// otherwise stop the chunk WITHOUT blaming the in-flight company — the next
// invocation picks it up again.
//
// Status changes (entities.company_status/_detail) are recorded in
// ch_status_events for the Triage Board and the morning report email.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const CH_API_KEY = Deno.env.get("CH_API_KEY") ?? "";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders },
  });
}

const CH_BASE = "https://api.company-information.service.gov.uk";
const PACE_MS = 1400;          // per-company budget: 3 CH calls + breathing room
const NIGHTLY_CHUNK = 35;      // ~50s per 5-min cron tick
const RATE_WAIT_CAP_MS = 45000; // wait for Retry-After up to this, else stop the chunk

class RateLimited extends Error {
  retryAfterMs: number;
  constructor(retryAfterMs: number) { super("rate_limited"); this.retryAfterMs = retryAfterMs; }
}

async function chFetch(path: string): Promise<{ ok: boolean; status: number; body: any }> {
  const auth = btoa(`${CH_API_KEY}:`);
  const res = await fetch(`${CH_BASE}${path}`, {
    headers: { Authorization: `Basic ${auth}` },
  });
  if (res.status === 429) {
    const ra = Number(res.headers.get("Retry-After")) || 0;
    // CH's window is 5 min; without a header assume a conservative 60s.
    await res.body?.cancel().catch(() => {});
    throw new RateLimited((ra > 0 ? ra : 60) * 1000);
  }
  let body: any = null;
  try { body = await res.json(); } catch { /* ignore */ }
  return { ok: res.ok, status: res.status, body };
}

function friendlyError(err: any, cn: string): string {
  const msg = err?.message || String(err);
  if (msg === "rate_limited") return "Companies House temporarily limited our requests — this company will be retried automatically.";
  if (/404/.test(msg)) return `Company number ${cn} was not found at Companies House — check the number on the client record.`;
  return msg;
}

// CH gives officer names as "DUNCAN, Graeme" — normalise to "Graeme Duncan".
function reformatChName(s: string): string {
  if (!s) return s;
  if (!s.includes(",")) return s;
  const [last, ...rest] = s.split(",");
  return `${rest.join(",").trim()} ${last.trim()}`
    .split(/\s+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(" ");
}

const TITLES = new Set(["dr", "mr", "mrs", "ms", "miss", "sir", "dame", "prof", "professor", "rev", "lord", "lady"]);
function nameTokens(s: string): string[] {
  return (s || "").toLowerCase().replace(/[^a-z\s]/g, " ").split(/\s+/)
    .filter((t) => t && !TITLES.has(t));
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);

  if (!CH_API_KEY) return jsonResponse({ error: "CH_API_KEY not configured" }, 500);

  try {
    const service = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const bodyIn = await req.json().catch(() => ({}));
    const cronSecret = req.headers.get("x-cron-secret");

    // 1. Auth: cron secret OR staff JWT with can_manage_portal.
    let isCron = false;
    if (cronSecret) {
      const { data: cfg } = await service.from("ch_refresh_config").select("cron_secret, refresh_enabled").eq("id", true).maybeSingle();
      if (!cfg || cfg.cron_secret !== cronSecret) return jsonResponse({ error: "Bad cron secret" }, 401);
      if (!cfg.refresh_enabled) return jsonResponse({ skipped: true, reason: "refresh disabled in config" });
      isCron = true;
    } else {
      const authHeader = req.headers.get("Authorization");
      if (!authHeader) return jsonResponse({ error: "Missing authorization" }, 401);
      const anonClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
        global: { headers: { Authorization: authHeader } },
      });
      const { data: { user: caller } } = await anonClient.auth.getUser();
      if (!caller) return jsonResponse({ error: "Invalid token" }, 401);
      const { data: callerProfile } = await service
        .from("staff_profiles").select("can_manage_portal").eq("id", caller.id).single();
      if (!callerProfile?.can_manage_portal) return jsonResponse({ error: "Not authorised" }, 403);
    }

    // 2. Parse request.
    const nightly = isCron && bodyIn?.mode === "nightly";
    const { limit = 20, force = false, only } = bodyIn || {};
    const cap = nightly ? NIGHTLY_CHUNK : Math.min(Math.max(1, Number(limit) || 20), 50);

    // 3. Pick target entities: limited companies with company_number.
    //    Nightly: the stalest first, skipping anything refreshed <20h ago.
    //    Manual: previous behaviour (not-yet-ingested first unless force),
    //    but now deterministically ordered so progress always advances.
    let pick = service.from("entities")
      .select("id, name, company_number, company_status, company_status_detail, ch_last_refreshed_at")
      .eq("type", "limited_company")
      .not("company_number", "is", null)
      .order("ch_last_refreshed_at", { ascending: true, nullsFirst: true })
      .order("name", { ascending: true });

    if (only && Array.isArray(only) && only.length) pick = pick.in("id", only);
    if (nightly) {
      pick = pick.or(`ch_last_refreshed_at.is.null,ch_last_refreshed_at.lt.${new Date(Date.now() - 20 * 3600 * 1000).toISOString()}`);
    }
    const { data: candidates, error: candErr } = await pick;
    if (candErr) return jsonResponse({ error: candErr.message }, 500);

    let targets = candidates || [];
    if (!nightly && !force && targets.length) {
      const { data: ingested } = await service
        .from("entity_people")
        .select("entity_id")
        .in("source", ["ch_officers", "ch_psc"]);
      const done = new Set((ingested || []).map((r) => r.entity_id));
      targets = targets.filter((e) => !done.has(e.id));
    }

    const totalRemaining = targets.length;
    targets = targets.slice(0, cap);

    let processed = 0;
    let statusChanges = 0;
    const errors: { entity_id: string; name: string; error: string }[] = [];
    const warnings: string[] = [];
    const runDate = new Date().toISOString().slice(0, 10);

    // Person matcher: exact CH-id first, then strict name+DOB, then a
    // conservative fuzzy pass (same surname + same DOB + same first initial,
    // titles stripped) so CH's own misspellings ("Guiseppe"/"Giuseppe",
    // "Dr Stephen"/"Stephen Thomas") stop creating duplicate people.
    async function matchPersonByName(name: string, dobYear: number | null, dobMonth: number | null): Promise<string | null> {
      if (dobYear == null || dobMonth == null) return null;
      const { data: exact } = await service.from("people")
        .select("id").ilike("name", name)
        .eq("dob_year", dobYear).eq("dob_month", dobMonth).limit(1);
      if (exact && exact.length) return exact[0].id;

      const toks = nameTokens(name);
      if (toks.length < 2) return null;
      const first = toks[0], last = toks[toks.length - 1];
      const { data: dobMatches } = await service.from("people")
        .select("id, name").eq("dob_year", dobYear).eq("dob_month", dobMonth).limit(50);
      for (const p of dobMatches || []) {
        const pt = nameTokens(p.name);
        if (pt.length < 2) continue;
        if (pt[pt.length - 1] === last && pt[0][0] === first[0]) return p.id;
      }
      return null;
    }

    entityLoop:
    for (const e of targets) {
      const started = Date.now();
      const cn = String(e.company_number).padStart(8, "0");
      try {
        // Profile first: company status + Confirmation Statement due date.
        const profileRes = await chFetch(`/company/${cn}`);
        if (profileRes.ok) {
          const newStatus: string | null = profileRes.body?.company_status ?? null;
          const newDetail: string | null = profileRes.body?.company_status_detail ?? null;
          if (newStatus && (newStatus !== e.company_status || (newDetail || null) !== (e.company_status_detail || null))) {
            if (e.company_status != null) {
              await service.from("ch_status_events").insert({
                entity_id: e.id, old_status: e.company_status, new_status: newStatus,
                old_detail: e.company_status_detail, new_detail: newDetail, run_date: runDate,
              });
              statusChanges++;
            }
          }
          await service.from("entities").update({
            company_status: newStatus, company_status_detail: newDetail,
            ch_last_refreshed_at: new Date().toISOString(),
          }).eq("id", e.id);

          const csNextDue: string | null = profileRes.body?.confirmation_statement?.next_due ?? null;
          if (csNextDue) {
            const { data: existingDeadline } = await service.from("deadlines")
              .select("id, due_date").eq("entity_id", e.id).eq("tag", "Confirmation Statement")
              .neq("status", "complete").maybeSingle();
            if (existingDeadline) {
              if (existingDeadline.due_date !== csNextDue) {
                await service.from("deadlines").update({ due_date: csNextDue, updated_at: new Date().toISOString() }).eq("id", existingDeadline.id);
              }
            } else {
              await service.from("deadlines").insert({
                entity_id: e.id, title: "Confirmation Statement", due_date: csNextDue, tag: "Confirmation Statement",
              });
            }
          }
        } else if (profileRes.status === 404) {
          errors.push({ entity_id: e.id, name: e.name, error: friendlyError(new Error("404"), cn) });
          await service.from("entities").update({ ch_last_refreshed_at: new Date().toISOString() }).eq("id", e.id);
          continue;
        }

        const officersRes = await chFetch(`/company/${cn}/officers?items_per_page=35`);
        const officers = officersRes.ok ? (officersRes.body?.items ?? []) : [];

        const pscRes = await chFetch(`/company/${cn}/persons-with-significant-control?items_per_page=35`);
        const pscs = pscRes.ok ? (pscRes.body?.items ?? []) : [];

        // Officers (active only).
        for (const o of officers) {
          if (o.resigned_on) continue;
          const role = (o.officer_role || "").toLowerCase();
          if (!["director", "secretary"].includes(role)) continue;
          const mappedRole = role === "director" ? "director" : "contact";
          const officerId: string | null = (() => {
            const url = o.links?.officer?.appointments;
            if (!url) return null;
            const m = String(url).match(/\/officers\/([^/]+)\//);
            return m ? m[1] : null;
          })();
          const name = reformatChName(o.name || "");
          if (!name) continue;
          const dobYear = o.date_of_birth?.year ?? null;
          const dobMonth = o.date_of_birth?.month ?? null;

          // Per-appointment id first (CH assigns a distinct officer id per
          // company — see project-ch-code-data-quality), then the legacy
          // single id on people, then name+DOB (strict, then fuzzy).
          let personId: string | null = null;
          if (officerId) {
            const { data: byAppointment } = await service.from("entity_people")
              .select("person_id").eq("entity_id", e.id).eq("ch_officer_id", officerId).maybeSingle();
            if (byAppointment) personId = byAppointment.person_id;
          }
          if (!personId && officerId) {
            const { data: byOfficer } = await service.from("people").select("id").eq("ch_officer_id", officerId).maybeSingle();
            if (byOfficer) personId = byOfficer.id;
          }
          if (!personId) personId = await matchPersonByName(name, dobYear, dobMonth);
          if (!personId) {
            const { data: ins, error: insErr } = await service.from("people")
              .insert({ name, ch_officer_id: officerId ?? null, dob_year: dobYear, dob_month: dobMonth, source: "ch_officer" })
              .select("id").single();
            if (insErr) throw insErr;
            personId = ins!.id;
          } else if (officerId) {
            await service.from("people").update({ ch_officer_id: officerId }).eq("id", personId).is("ch_officer_id", null);
          }

          await service.from("entity_people").upsert({
            entity_id: e.id, person_id: personId, role: mappedRole,
            started_on: o.appointed_on ?? null, ended_on: null, source: "ch_officers",
            ch_officer_id: officerId ?? null,
          }, { onConflict: "entity_id,person_id,role" });
        }

        // PSCs (active individuals) — shareholders.
        for (const psc of pscs) {
          if (psc.ceased_on || psc.ceased) continue;
          const kind: string = psc.kind || "";
          if (!kind.startsWith("individual")) continue;
          const pscId: string | null = psc.links?.self
            ? psc.links.self.split("/").filter(Boolean).pop() ?? null
            : null;
          const name = (psc.name_elements
            ? `${psc.name_elements.forename ?? ""}${psc.name_elements.middle_name ? " " + psc.name_elements.middle_name : ""} ${psc.name_elements.surname ?? ""}`.trim()
            : (psc.name || ""));
          if (!name) continue;
          const dobYear = psc.date_of_birth?.year ?? null;
          const dobMonth = psc.date_of_birth?.month ?? null;

          let personId: string | null = null;
          if (pscId) {
            const { data: byAppointment } = await service.from("entity_people")
              .select("person_id").eq("entity_id", e.id).eq("ch_psc_id", pscId).maybeSingle();
            if (byAppointment) personId = byAppointment.person_id;
          }
          if (!personId && pscId) {
            const { data: byPsc } = await service.from("people").select("id").eq("ch_psc_id", pscId).maybeSingle();
            if (byPsc) personId = byPsc.id;
          }
          if (!personId) personId = await matchPersonByName(name, dobYear, dobMonth);
          if (!personId) {
            const { data: ins, error: insErr } = await service.from("people")
              .insert({ name, ch_psc_id: pscId ?? null, dob_year: dobYear, dob_month: dobMonth, source: "ch_psc" })
              .select("id").single();
            if (insErr) throw insErr;
            personId = ins!.id;
          } else if (pscId) {
            await service.from("people").update({ ch_psc_id: pscId }).eq("id", personId).is("ch_psc_id", null);
          }

          const nature: string[] = psc.natures_of_control || [];
          const pctNature = nature.find((n) => /(?:75|50|25)/.test(n));
          let rolePct: number | null = null;
          if (pctNature) {
            if (pctNature.includes("75")) rolePct = 75;
            else if (pctNature.includes("50")) rolePct = 50;
            else if (pctNature.includes("25")) rolePct = 25;
          }

          await service.from("entity_people").upsert({
            entity_id: e.id, person_id: personId, role: "shareholder",
            role_pct: rolePct, started_on: psc.notified_on ?? null, ended_on: null, source: "ch_psc",
            ch_psc_id: pscId ?? null,
          }, { onConflict: "entity_id,person_id,role" });
        }

        processed++;
        // Pace to the per-company budget so we stay under CH's 600/5min.
        const elapsed = Date.now() - started;
        if (elapsed < PACE_MS) await new Promise((r) => setTimeout(r, PACE_MS - elapsed));
      } catch (err: any) {
        if (err instanceof RateLimited) {
          // Not this company's fault. Wait if the penalty is short, else stop
          // the chunk — the next invocation resumes from the same place.
          if (err.retryAfterMs <= RATE_WAIT_CAP_MS) {
            warnings.push(`Companies House asked us to slow down — waited ${Math.round(err.retryAfterMs / 1000)}s.`);
            await new Promise((r) => setTimeout(r, err.retryAfterMs));
            continue; // retry loop moves on; this company is picked up next run
          }
          warnings.push("Companies House rate limit reached — stopped this chunk early; the refresh resumes automatically.");
          break entityLoop;
        }
        errors.push({ entity_id: e.id, name: e.name, error: friendlyError(err, cn) });
      }
    }

    // Nightly bookkeeping: one ch_refresh_runs row per night, updated per chunk.
    if (nightly) {
      const { data: run } = await service.from("ch_refresh_runs").select("*").eq("run_date", runDate).maybeSingle();
      if (run) {
        await service.from("ch_refresh_runs").update({
          last_chunk_at: new Date().toISOString(),
          chunks: run.chunks + 1,
          processed: run.processed + processed,
          status_changes: run.status_changes + statusChanges,
          errors: [...(run.errors || []), ...errors],
          warnings: [...(run.warnings || []), ...warnings].slice(-50),
        }).eq("run_date", runDate);
      } else {
        await service.from("ch_refresh_runs").insert({
          run_date: runDate, last_chunk_at: new Date().toISOString(), chunks: 1,
          processed, status_changes: statusChanges, errors, warnings,
        });
      }
    }

    return jsonResponse({
      processed,
      status_changes: statusChanges,
      total_remaining: Math.max(0, totalRemaining - processed),
      errors,
      warnings,
    });
  } catch (err: any) {
    return jsonResponse({ error: err?.message || String(err) }, 500);
  }
});
