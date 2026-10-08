// onboarding-actions — Athena Portal
//
// The writes behind the onboarding list's row actions (sql/359). New mutating
// paths are edge functions (CLAUDE.md); attribution is the JWT's user.
//
// Body: { action, ...fields }
//   render_email  { onboarding_id, kind, step_ids? }
//                 kind: ob_request | ob_follow_up | ob_final_chase | blank.
//                 Returns the draft (to, from, subject, text) plus every open
//                 client item, with any unreviewed reply finding against it so
//                 the modal can warn before asking again. step_ids = the items
//                 to list; omitted = every open item without such a finding.
//   send_email    { onboarding_id, to, subject, text, kind, step_ids? }
//                 Sends through the sender's own Gmail (else the practice
//                 mailbox with their name), logs it on the client and the
//                 onboarding, and marks listed client steps still at To do as
//                 requested today — the email is the formal ask.
//   log_call      { onboarding_id, outcome, note? }
//                 outcome: spoke | no_answer | voicemail | wrong_number.
//                 Spoke clears a "Call needed" escalation to "Call made".
//   park          { onboarding_id, parked, note? }  sinks it to the bottom of
//                 the list; the chaser skips it.
//   review_finding { finding_id, accept }  accept ticks the step Complete and
//                 copies what the client sent into the step note; dismiss
//                 just closes the finding.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { requireStaffOrService, authErrorResponse } from "../_shared/require-staff.ts";
import { sendGeneric, loadPrefs, primaryContact, closingVars, firstWord } from "../_shared/job-comms.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const CLIENT_PORTAL_URL = Deno.env.get("CLIENT_PORTAL_URL") || "https://clients.almondvalleyaccounting.co.uk";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", ...cors } });
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KINDS = ["ob_request", "ob_follow_up", "ob_final_chase", "blank"];
const OUTCOMES: Record<string, string> = {
  spoke: "Spoke to the client",
  no_answer: "No answer",
  voicemail: "Left a voicemail",
  wrong_number: "Wrong number",
};
const OPEN = ["pending", "waiting_client", "waiting_external", "blocked", "received"];

class BadRequest extends Error {
  status: number;
  constructor(message: string, status = 400) { super(message); this.status = status; }
}
function uuid(v: unknown, field: string): string {
  const s = String(v ?? "");
  if (!UUID.test(s)) throw new BadRequest(`${field} must be a uuid`);
  return s;
}
function uuidList(v: unknown): string[] | null {
  if (v == null) return null;
  if (!Array.isArray(v)) throw new BadRequest("step_ids must be a list");
  return v.map((x, i) => uuid(x, `step_ids[${i}]`));
}
function renderStr(s: string, vars: Record<string, string>): string {
  return String(s ?? "").replace(/\{\{\s*(\w+)\s*\}\}/g, (_m, k) => (k in vars ? String(vars[k] ?? "") : ""));
}
function firstEmail(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const e = String(raw).split(/[;,]/)[0].trim().toLowerCase();
  return e.includes("@") ? e : null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ success: false, error: "POST required" }, 405);

  // Staff only: every action is a person's (an email from them, a call they
  // made), so there is no service-role path.
  let caller;
  try { caller = await requireStaffOrService(req, { allowService: false }); }
  catch (e) { return authErrorResponse(e, cors); }
  const me = caller.userId as string;

  const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  const p = await req.json().catch(() => ({}));
  const now = new Date().toISOString();
  const today = now.slice(0, 10);

  async function loadOnboarding(id: string) {
    const { data, error } = await db.from("onboardings")
      .select("id, entity_id, status, escalation_status, parked_at, entity:entities!onboardings_entity_id_fkey(id, name, billing_email, prospect_email), steps:onboarding_steps(id, name, client_label, owner_type, status, requested_at, group_sort, sort)")
      .eq("id", id).maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) throw new BadRequest("Onboarding not found", 404);
    return data as Record<string, any>;
  }
  async function activity(onboardingId: string, kind: string, body: string, extra: Record<string, unknown> = {}) {
    const { error } = await db.from("onboarding_activity").insert({
      onboarding_id: onboardingId, kind, body, created_by: me, ...extra,
    });
    if (error) throw new Error(error.message);
  }

  // Open client items, in checklist order, each with any finding still waiting
  // for a person — the "they may already have sent this" warning.
  async function openItems(ob: Record<string, any>) {
    const steps = ((ob.steps || []) as Record<string, any>[])
      .filter((s) => s.owner_type === "client" && OPEN.includes(s.status))
      .sort((a, b) => a.group_sort - b.group_sort || a.sort - b.sort);
    const { data: finds } = await db.from("onboarding_reply_findings")
      .select("id, step_id, found_value, created_at, communication:client_communications(occurred_at)")
      .eq("onboarding_id", ob.id).eq("status", "suggested");
    return steps.map((s) => {
      const f = (finds || []).find((x) => x.step_id === s.id) as Record<string, any> | undefined;
      return {
        step_id: s.id as string,
        label: (s.client_label || s.name) as string,
        status: s.status as string,
        requested_at: s.requested_at as string | null,
        finding: f ? { id: f.id, value: f.found_value, received_at: f.communication?.occurred_at || f.created_at } : null,
      };
    });
  }

  try {
    switch (p.action) {
      case "render_email": {
        const ob = await loadOnboarding(uuid(p.onboarding_id, "onboarding_id"));
        const kind = String(p.kind || "");
        if (!KINDS.includes(kind)) throw new BadRequest("Unknown template");
        const items = await openItems(ob);
        const chosen = uuidList(p.step_ids);
        const listed = chosen ? items.filter((i) => chosen.includes(i.step_id)) : items.filter((i) => !i.finding);

        const ent = ob.entity as Record<string, any>;
        const [contact, { data: sp }, { data: gc }, { data: invites }] = await Promise.all([
          primaryContact(db, ob.entity_id),
          db.from("staff_profiles").select("name").eq("id", me).maybeSingle(),
          db.from("gmail_connections").select("account_email").eq("owner_staff_id", me).eq("status", "active").limit(1),
          db.from("client_portal_invites").select("email").eq("entity_id", ob.entity_id),
        ]);
        const toOptions = [...new Set([
          contact?.email?.toLowerCase(), firstEmail(ent?.billing_email), firstEmail(ent?.prospect_email),
          ...(invites || []).map((i: Record<string, string>) => firstEmail(i.email)),
        ].filter(Boolean) as string[])];
        const fromName = sp?.name || "";
        const fromEmail = gc?.[0]?.account_email || null;
        const prefs = await loadPrefs(db, me, p.prefs);
        const closing = await closingVars(db, me, fromEmail, firstWord(fromName) || "Almond Valley Accounting", prefs);
        const greeting = contact?.greeting || "there";

        let subject = "";
        let text = "";
        if (kind === "blank") {
          subject = ent?.name || "";
          text = `Hi ${greeting},\n\n${closing.opener.trim()}${closing.opener ? "\n\n" : ""}\n\n${closing.signoff}`;
        } else {
          const { data: tmpl } = await db.from("comm_templates").select("subject, body_text")
            .eq("comm_type", "onboarding").eq("kind", kind).maybeSingle();
          if (!tmpl) throw new BadRequest("That template is missing — add it under the onboarding email templates");
          const vars: Record<string, string> = {
            ...closing, greeting, client_name: ent?.name || "your business", portal_url: CLIENT_PORTAL_URL,
            sender_first_name: firstWord(fromName) || "Almond Valley Accounting",
            items: listed.length ? listed.map((i) => `• ${i.label}`).join("\n") : "• (nothing outstanding — untick this or pick items)",
          };
          subject = renderStr(tmpl.subject, vars);
          text = renderStr(tmpl.body_text, vars);
        }
        return json({
          success: true, kind, subject, text,
          to: toOptions[0] || null, to_options: toOptions,
          from_email: fromEmail, from_name: fromName,
          items, listed: listed.map((i) => i.step_id),
        });
      }

      case "send_email": {
        const ob = await loadOnboarding(uuid(p.onboarding_id, "onboarding_id"));
        const to = String(p.to || "").trim();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) throw new BadRequest("A valid To address is needed");
        const subject = String(p.subject || "").trim().slice(0, 200);
        const text = String(p.text || "").slice(0, 20000);
        if (!subject || !text.trim()) throw new BadRequest("Subject and message are needed");
        const chosen = uuidList(p.step_ids) || [];

        const sent = await sendGeneric(db, { entityId: ob.entity_id, to, subject, text, ownerId: me });
        let communicationId: string | null = null;
        if (sent.gmail_message_id) {
          const { data: comm } = await db.from("client_communications").select("id")
            .eq("entity_id", ob.entity_id).eq("gmail_message_id", sent.gmail_message_id).limit(1);
          communicationId = comm?.[0]?.id || null;
        }

        // Listed items still at To do become formally requested today, so the
        // portal shows them as needed and the waiting clock starts.
        const steps = (ob.steps || []) as Record<string, any>[];
        const release = steps.filter((s) => chosen.includes(s.id) && s.owner_type === "client" && s.status === "pending").map((s) => s.id);
        if (release.length) {
          await db.from("onboarding_steps").update({ status: "waiting_client", requested_at: today, updated_at: now }).in("id", release);
        }
        const asked = steps.filter((s) => chosen.includes(s.id)).map((s) => s.client_label || s.name);
        await activity(ob.id, "email_out",
          `Email sent to ${to} — “${subject}”` + (asked.length ? `\nAsked for: ${asked.join("; ")}` : ""),
          { communication_id: communicationId });
        return json({ success: true, to, from: sent.from, released: release.length });
      }

      case "log_call": {
        const ob = await loadOnboarding(uuid(p.onboarding_id, "onboarding_id"));
        const outcome = String(p.outcome || "");
        if (!OUTCOMES[outcome]) throw new BadRequest("Unknown call outcome");
        const note = String(p.note || "").trim().slice(0, 4000);
        await activity(ob.id, "call", `Call — ${OUTCOMES[outcome]}${note ? `\n${note}` : ""}`);
        if (outcome === "spoke" && ob.escalation_status === "call_needed") {
          await db.from("onboardings").update({ escalation_status: "call_made" }).eq("id", ob.id);
        }
        return json({ success: true });
      }

      case "park": {
        const ob = await loadOnboarding(uuid(p.onboarding_id, "onboarding_id"));
        const parked = Boolean(p.parked);
        const note = String(p.note || "").trim().slice(0, 1000) || null;
        const { error } = await db.from("onboardings").update(parked
          ? { parked_at: now, parked_by: me, parked_note: note }
          : { parked_at: null, parked_by: null, parked_note: null }).eq("id", ob.id);
        if (error) throw new Error(error.message);
        await activity(ob.id, "status_change", parked
          ? `Onboarding parked${note ? ` — ${note}` : ""}. Moved to the bottom of the list; chasers paused.`
          : "Onboarding unparked.");
        return json({ success: true, parked });
      }

      case "review_finding": {
        const id = uuid(p.finding_id, "finding_id");
        const accept = Boolean(p.accept);
        const { data: f, error } = await db.from("onboarding_reply_findings")
          .select("id, onboarding_id, step_id, item_label, found_value, status, communication:client_communications(occurred_at)")
          .eq("id", id).maybeSingle();
        if (error) throw new Error(error.message);
        if (!f) throw new BadRequest("Finding not found", 404);
        if (f.status !== "suggested") throw new BadRequest("Already reviewed");
        await db.from("onboarding_reply_findings").update({
          status: accept ? "accepted" : "dismissed", reviewed_by: me, reviewed_at: now,
        }).eq("id", id);
        const when = String((f.communication as Record<string, any>)?.occurred_at || "").slice(0, 10);
        if (accept && f.step_id) {
          const { data: step } = await db.from("onboarding_steps").select("id, name, status, note").eq("id", f.step_id).maybeSingle();
          if (step && step.status !== "complete") {
            const line = `From the client's email${when ? ` of ${when}` : ""}: ${f.found_value || f.item_label}`;
            await db.from("onboarding_steps").update({
              status: "complete", completed_at: now, completed_by: me, updated_at: now,
              note: step.note ? `${step.note}\n${line}` : line,
            }).eq("id", step.id);
            await activity(f.onboarding_id, "status_change",
              `${step.name}: ticked Complete from the client's email${when ? ` of ${when}` : ""}`, { step_id: step.id });
          }
        } else if (!accept) {
          await activity(f.onboarding_id, "system", `Reply finding dismissed — ${f.item_label}${f.found_value ? ` (${f.found_value})` : ""}`);
        }
        return json({ success: true });
      }

      default:
        throw new BadRequest("Unknown action");
    }
  } catch (e) {
    const status = e instanceof BadRequest ? e.status : 500;
    return json({ success: false, error: (e as Error).message || String(e) }, status);
  }
});
