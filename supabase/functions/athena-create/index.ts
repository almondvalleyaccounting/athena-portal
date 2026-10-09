// athena-create — Athena Portal
// The "+ Create" modal's writes: a quick task, an admin task (optionally
// with a draft bill), and a one-off draft bill. Meeting agenda items go
// through client-agenda and quotes open the quote form, so neither is here.
//
// Every insert runs as the CALLER (their JWT on the client below), so the
// tables' own RLS decides exactly as it does on the Work Planner, Admin Task
// List and Billing pages — work_planner for quick tasks, can_view_client_fees
// / can_view_billing + per-client figures for bills. Nothing here widens
// what anyone can do; it only gives the new modal one server path
// (CLAUDE.md: a new mutating path is an edge function).
//
// The rows mirror what those pages insert (AdminTasksPage.addManual,
// BillingPage.handleAdd, insertQuickTask) so a record made here is
// indistinguishable from one made there.
//
//   match_clients { emails[] }   which clients these addresses belong to
//   quick_task    { title, entity_id?, service, assignee_id, due_date?, planned_date?, duration?, notes? }
//   admin_task    { title, entity_id?, deadline?, detail?, urgent?, draft?, billable?, service_id?, net? }
//   bill          { entity_id, lines: [{ service, description?, net }], note? }
//
// verify_jwt ON; active staff only.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { requireStaffOrService, authErrorResponse } from "../_shared/require-staff.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const VAT_RATE = 0.2;

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (d: unknown, status = 200) =>
  new Response(JSON.stringify(d), { status, headers: { ...cors, "Content-Type": "application/json" } });

class BadRequest extends Error {}
const str = (v: unknown, max = 2000) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const uuidOrNull = (v: unknown) => {
  const s = str(v, 64);
  if (!s) return null;
  if (!/^[0-9a-f-]{36}$/i.test(s)) throw new BadRequest("Bad id");
  return s;
};
const dateOrNull = (v: unknown) => {
  const s = str(v, 10);
  if (!s) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new BadRequest("Dates must be YYYY-MM-DD");
  return s;
};
const money = (n: number) => Math.round(n * 100) / 100;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ success: false, error: "POST required" }, 405);

  let me: string;
  try {
    const caller = await requireStaffOrService(req, { allowService: false });
    me = caller.userId!;
  } catch (e) {
    return authErrorResponse(e, cors);
  }

  // As the caller: their RLS, their permissions.
  const db = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: req.headers.get("Authorization")! } },
  });

  const p = await req.json().catch(() => ({}));
  try {
    switch (p.action) {
      case "match_clients": {
        // service_role only for the lookup function itself; the answer is
        // client names, which every member of staff can already see.
        const emails = (Array.isArray(p.emails) ? p.emails : []).map((e: unknown) => str(e, 200).toLowerCase())
          .filter((e: string) => e.includes("@")).slice(0, 20);
        if (!emails.length) return json({ success: true, clients: [] });
        const svc = createClient(SUPABASE_URL, SERVICE_KEY);
        const { data, error } = await svc.rpc("comms_recipient_entities", { p_emails: emails });
        if (error) throw new Error(error.message);
        const seen = new Map<string, string>();
        for (const r of data || []) if (!seen.has(r.entity_id)) seen.set(r.entity_id, r.entity_name);
        return json({ success: true, clients: [...seen].map(([id, name]) => ({ id, name })) });
      }

      case "quick_task": {
        const title = str(p.title, 300);
        if (!title) throw new BadRequest("Give the task a title.");
        const assignee = uuidOrNull(p.assignee_id);
        if (!assignee) throw new BadRequest("Choose who the task is for.");
        const duration = Math.round(Number(p.duration) || 15);
        if (duration < 5 || duration > 600) throw new BadRequest("Minutes must be between 5 and 600.");
        const row: Record<string, unknown> = {
          title, entity_id: uuidOrNull(p.entity_id), service: str(p.service, 60) || "Admin",
          assignee_id: assignee, duration, notes: str(p.notes, 5000), created_by: me, source: "manual",
        };
        const due = dateOrNull(p.due_date);
        if (due) row.due_date = due;
        const planned = dateOrNull(p.planned_date);
        if (planned) row.planned_date = planned;
        const { data, error } = await db.from("quick_tasks").insert(row).select("id").single();
        if (error) throw new Error(error.message);
        return json({ success: true, id: data.id });
      }

      case "admin_task": {
        const title = str(p.title, 300);
        if (!title) throw new BadRequest("Give the task a title.");
        const entityId = uuidOrNull(p.entity_id);
        const billable = !!p.billable;
        const serviceId = str(p.service_id, 120) || null;
        if (billable && !entityId) throw new BadRequest("A billable task needs a client.");
        if (billable && !serviceId) throw new BadRequest("Pick a service to bill. Admin isn't billable.");
        // Same staging as the Admin Task List: draft, else Bill & Hold if it
        // needs a bill, else To Do.
        const stage = p.draft ? "draft" : (billable ? "bill_hold" : "todo");
        const { data: task, error } = await db.from("admin_tasks").insert({
          kind: "manual", title, detail: str(p.detail, 5000) || null,
          entity_id: entityId, deadline: dateOrNull(p.deadline), urgent: !!p.urgent,
          source: "Added manually", created_by: me, billable, stage, service_id: serviceId,
        }).select("id").single();
        if (error) throw new Error(error.message);
        if (!billable) return json({ success: true, id: task.id });

        // Amount left blank → the price book's standard fee (a typed 0 is 0).
        let net: number;
        const typed = p.net === null || p.net === undefined ? "" : String(p.net).trim();
        if (typed === "") {
          const { data: fee } = await db.from("standard_fees").select("standard_net").eq("service_id", serviceId).maybeSingle();
          net = Number(fee?.standard_net) || 0;
        } else {
          net = Number(typed);
          if (!Number.isFinite(net) || net < 0) throw new BadRequest("Amount must be a number.");
        }
        const vat = money(net * VAT_RATE);
        const { data: bill, error: billErr } = await db.from("billing_items").insert({
          entity_id: entityId, service: serviceId, description: title,
          net_amount: money(net), vat_amount: vat, gross_amount: money(net + vat),
          status: "draft", created_by: me,
        }).select("id").single();
        if (billErr) {
          // The task stands; say plainly the bill didn't (usually: no billing access).
          return json({ success: true, id: task.id, billError: billErr.message });
        }
        await db.from("admin_tasks").update({ billing_item_id: bill.id }).eq("id", task.id);
        return json({ success: true, id: task.id, billId: bill.id });
      }

      case "bill": {
        const entityId = uuidOrNull(p.entity_id);
        if (!entityId) throw new BadRequest("Choose the client to bill.");
        const lines = (Array.isArray(p.lines) ? p.lines : []).slice(0, 30).map((l: Record<string, unknown>) => {
          const service = str(l.service, 120);
          const net = Number(l.net);
          if (!service) throw new BadRequest("Every line needs a service.");
          if (!Number.isFinite(net) || net < 0) throw new BadRequest("Every line needs an amount.");
          const vat = money(net * VAT_RATE);
          return {
            service, description: str(l.description, 500) || null, hours: null,
            qty: 1, rate: money(net), net: money(net), vat, gross: money(net + vat),
          };
        });
        if (!lines.length) throw new BadRequest("Add at least one line.");
        const totals = lines.reduce((t, l) => ({ net: t.net + l.net, vat: t.vat + l.vat, gross: t.gross + l.gross }),
          { net: 0, vat: 0, gross: 0 });
        const summary = lines.length === 1 ? lines[0].service : `${lines[0].service} +${lines.length - 1} more`;
        const { data: bill, error } = await db.from("billing_items").insert({
          entity_id: entityId, service: summary, description: null,
          net_amount: money(totals.net), vat_amount: money(totals.vat), gross_amount: money(totals.gross),
          lines, status: "draft", created_by: me,
        }).select("id").single();
        if (error) throw new Error(error.message);
        const note = str(p.note, 5000);
        if (note) await db.from("billing_item_comments").insert({ billing_item_id: bill.id, author_id: me, body: note });
        return json({ success: true, id: bill.id });
      }

      default:
        throw new BadRequest("Unknown action");
    }
  } catch (e) {
    if (e instanceof BadRequest) return json({ success: false, error: e.message }, 400);
    const msg = (e as Error).message || "Failed";
    // RLS refusals read as gibberish to a user; say what it means.
    const friendly = /row-level security|permission denied/i.test(msg)
      ? "You don't have access to create that (or to this client's figures)."
      : msg;
    return json({ success: false, error: friendly }, 500);
  }
});
