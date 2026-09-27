// Per-client figures check for edge functions (sql/329).
//
// Staff & Permissions switches client figures on/off per person per client, and
// the database enforces it with RLS. An edge function running as service_role
// bypasses RLS, so a function that returns one client's figures to a staff
// caller must ask the same question itself, naming the caller:
//
//   const caller = await requireStaffOrService(req, "can_view_reports");
//   await requireClientFigures(caller, ["cw-dashboard", "cw-portfolio"], { realmId });
//
// Machines (pg_cron, function-to-function) pass, as they do in the database.
// Portal admins pass. Otherwise the caller needs one of the modules and the
// client switched on. A realm linked to no client follows the module alone.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { AuthError, type Caller } from "./require-staff.ts";

export async function requireClientFigures(
  caller: Caller,
  modules: string[],
  target: { entityId?: string | null; realmId?: string | null },
): Promise<void> {
  if (caller.kind === "service") return;
  const url = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !serviceKey) throw new AuthError(500, "Auth not configured");
  const service = createClient(url, serviceKey, { auth: { persistSession: false } });
  const { data, error } = await service.rpc("staff_figures_visible", {
    p_staff: caller.userId,
    p_modules: modules,
    p_entity: target.entityId ?? null,
    p_realm: target.realmId ?? null,
  });
  // Fail closed: if the question can't be answered, the figures aren't shown.
  if (error) throw new AuthError(500, "Access check failed");
  if (data !== true) throw new AuthError(403, "This client's figures are switched off for you");
}

// For functions that return many clients at once: the realms this caller may
// see, or null meaning "all" (machines and admins).
export async function visibleRealms(caller: Caller, modules: string[], realmIds: string[]): Promise<Set<string> | null> {
  if (caller.kind === "service") return null;
  const url = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const service = createClient(url, serviceKey, { auth: { persistSession: false } });
  const out = new Set<string>();
  for (const realmId of realmIds) {
    const { data, error } = await service.rpc("staff_figures_visible", {
      p_staff: caller.userId, p_modules: modules, p_entity: null, p_realm: realmId,
    });
    if (error) throw new AuthError(500, "Access check failed");
    if (data === true) out.add(realmId);
  }
  return out;
}
