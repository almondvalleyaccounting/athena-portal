// ch-ingest-officers
// Pulls officers + PSCs from Companies House for limited companies.
// Processes a chunk per call (default 20 entities) so the client can drive
// progress incrementally without hitting the edge function 150s wall.
//
// Body: { limit?: number, force?: boolean, only?: string[] }
//   limit: max entities to process this call (default 20, max 50)
//   force: re-ingest entities that already have officers loaded
//   only:  restrict to a list of entity ids
//
// Returns: { processed, skipped, total_remaining, errors, sample }

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const CH_API_KEY = Deno.env.get("CH_API_KEY") ?? "";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders },
  });
}

const CH_BASE = "https://api.company-information.service.gov.uk";

async function chFetch(path: string): Promise<{ ok: boolean; status: number; body: any }> {
  const auth = btoa(`${CH_API_KEY}:`);
  const res = await fetch(`${CH_BASE}${path}`, {
    headers: { Authorization: `Basic ${auth}` },
  });
  let body: any = null;
  try { body = await res.json(); } catch { /* ignore */ }
  return { ok: res.ok, status: res.status, body };
}

function normaliseName(s: string): string {
  return (s || "").toLowerCase().replace(/[\s,]+/g, " ").trim();
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

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);

  if (!CH_API_KEY) return jsonResponse({ error: "CH_API_KEY not configured" }, 500);

  try {
    // 1. Auth + caller permission check.
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return jsonResponse({ error: "Missing authorization" }, 401);

    const anonClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user: caller } } = await anonClient.auth.getUser();
    if (!caller) return jsonResponse({ error: "Invalid token" }, 401);

    const service = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const { data: callerProfile } = await service
      .from("staff_profiles")
      .select("can_manage_portal")
      .eq("id", caller.id)
      .single();
    if (!callerProfile?.can_manage_portal) return jsonResponse({ error: "Not authorised" }, 403);

    // 2. Parse request.
    const { limit = 20, force = false, only } = await req.json().catch(() => ({}));
    const cap = Math.min(Math.max(1, Number(limit) || 20), 50);

    // 3. Pick target entities: limited companies with company_number.
    let pick = service.from("entities")
      .select("id, name, company_number")
      .eq("type", "limited_company")
      .not("company_number", "is", null);

    if (only && Array.isArray(only) && only.length) {
      pick = pick.in("id", only);
    }
    const { data: candidates, error: candErr } = await pick;
    if (candErr) return jsonResponse({ error: candErr.message }, 500);

    // Skip those that have already been ingested unless force=true.
    let targets = candidates || [];
    if (!force && targets.length) {
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
    let skipped = 0;
    const errors: { entity_id: string; name: string; error: string }[] = [];

    for (const e of targets) {
      try {
        const cn = String(e.company_number).padStart(8, "0");
        const officersRes = await chFetch(`/company/${cn}/officers?items_per_page=35`);
        if (!officersRes.ok && officersRes.status === 429) {
          errors.push({ entity_id: e.id, name: e.name, error: "rate_limited" });
          break; // stop the run; client retries.
        }
        const officers = officersRes.body?.items ?? [];

        const pscRes = await chFetch(`/company/${cn}/persons-with-significant-control?items_per_page=35`);
        if (!pscRes.ok && pscRes.status === 429) {
          errors.push({ entity_id: e.id, name: e.name, error: "rate_limited" });
          break;
        }
        const pscs = pscRes.body?.items ?? [];

        // Confirmation Statement due date → deadlines (tag 'Confirmation
        // Statement'), so the CH personal-code chaser can prioritise by it.
        const profileRes = await chFetch(`/company/${cn}`);
        const csNextDue: string | null = profileRes.ok ? (profileRes.body?.confirmation_statement?.next_due ?? null) : null;
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

        // Officers (active only).
        for (const o of officers) {
          if (o.resigned_on) continue;
          const role = (o.officer_role || "").toLowerCase();
          if (!["director", "secretary"].includes(role)) continue;
          const mappedRole = role === "director" ? "director" : "contact";
          // Officer URL format: /officers/{id}/appointments — extract the id segment.
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

          // Match person: per-appointment entity_people id first, then the
          // legacy single id on people, else name + dob.
          //
          // Companies House assigns a DISTINCT officer id per company, so a
          // multi-company director needs the entity-scoped id — the single
          // (legacy) id on people can only hold one company's id and gets
          // overwritten/lost if that person is ever merged with another of
          // their own company appointments (see project-ch-code-data-quality
          // memory, Lewis Mckechnie — a "Re-sync all" without this check
          // would have silently recreated the duplicate it just fixed).
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
          // Strict name-based match: require both sides to have a full DOB
          // (year + month) and match exactly. Without that, common names
          // (e.g. "Robert Gallacher") collapse unrelated officers into one
          // person record. Sole-trader auto-seeded records have no DOB and
          // intentionally do NOT auto-link to CH directors — use the manual
          // merge UI in the group panel for those.
          if (!personId && dobYear != null && dobMonth != null) {
            const { data: byName } = await service.from("people")
              .select("id")
              .ilike("name", name)
              .eq("dob_year", dobYear)
              .eq("dob_month", dobMonth)
              .limit(1);
            if (byName && byName.length) personId = byName[0].id;
          }
          if (!personId) {
            const { data: ins, error: insErr } = await service.from("people")
              .insert({
                name, ch_officer_id: officerId ?? null,
                dob_year: dobYear, dob_month: dobMonth,
                source: "ch_officer",
              })
              .select("id").single();
            if (insErr) throw insErr;
            personId = ins!.id;
          } else if (officerId) {
            await service.from("people").update({ ch_officer_id: officerId }).eq("id", personId).is("ch_officer_id", null);
          }

          await service.from("entity_people").upsert({
            entity_id: e.id,
            person_id: personId,
            role: mappedRole,
            started_on: o.appointed_on ?? null,
            ended_on: null,
            source: "ch_officers",
            ch_officer_id: officerId ?? null,
          }, { onConflict: "entity_id,person_id,role" });
        }

        // PSCs (active only) — treat individuals as shareholders.
        for (const psc of pscs) {
          if (psc.ceased_on || psc.ceased) continue;
          const kind: string = psc.kind || "";
          if (!kind.startsWith("individual")) continue;
          const pscId: string | null = psc.links?.self
            ? psc.links.self.split("/").filter(Boolean).pop() ?? null
            : null;
          const ni = psc.name_elements
            ? `${psc.name_elements.forename ?? ""}${psc.name_elements.middle_name ? " " + psc.name_elements.middle_name : ""} ${psc.name_elements.surname ?? ""}`.trim()
            : (psc.name || "");
          const name = ni;
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
          if (!personId && dobYear != null && dobMonth != null) {
            const { data: byName } = await service.from("people")
              .select("id")
              .ilike("name", name)
              .eq("dob_year", dobYear)
              .eq("dob_month", dobMonth)
              .limit(1);
            if (byName && byName.length) personId = byName[0].id;
          }
          if (!personId) {
            const { data: ins, error: insErr } = await service.from("people")
              .insert({
                name, ch_psc_id: pscId ?? null,
                dob_year: dobYear, dob_month: dobMonth,
                source: "ch_psc",
              })
              .select("id").single();
            if (insErr) throw insErr;
            personId = ins!.id;
          } else if (pscId) {
            await service.from("people").update({ ch_psc_id: pscId }).eq("id", personId).is("ch_psc_id", null);
          }

          // Parse percentage from natures_of_control if available.
          const nature: string[] = psc.natures_of_control || [];
          const pctNature = nature.find((n) => /(?:75|50|25)/.test(n));
          let rolePct: number | null = null;
          if (pctNature) {
            if (pctNature.includes("75")) rolePct = 75;
            else if (pctNature.includes("50")) rolePct = 50;
            else if (pctNature.includes("25")) rolePct = 25;
          }

          await service.from("entity_people").upsert({
            entity_id: e.id,
            person_id: personId,
            role: "shareholder",
            role_pct: rolePct,
            started_on: psc.notified_on ?? null,
            ended_on: null,
            source: "ch_psc",
            ch_psc_id: pscId ?? null,
          }, { onConflict: "entity_id,person_id,role" });
        }

        processed++;
        // Light throttle: ~600/5min limit means we can hit ~2 req/sec safely.
        await new Promise((r) => setTimeout(r, 250));
      } catch (err: any) {
        errors.push({ entity_id: e.id, name: e.name, error: err?.message || String(err) });
      }
    }

    return jsonResponse({
      processed,
      skipped,
      total_remaining: Math.max(0, totalRemaining - processed),
      errors,
    });
  } catch (err: any) {
    return jsonResponse({ error: err?.message || String(err) }, 500);
  }
});
