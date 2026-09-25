// client-agenda — Athena Portal
//
// The writes behind the "Next meeting agenda" card on the client page's Work
// tab (sql/301). The browser holds SELECT on client_agenda_items / _notes and
// nothing else, because a new mutating path is an edge function (CLAUDE.md).
// Attribution is the JWT's user, never a field in the body.
//
// Body: { action, ...fields }
//   add_item      { entity_id, body, bucket? }      bucket: "agenda" | "info"
//   edit_item     { item_id, body }
//   move          { item_id, bucket }                goes to the end of the bucket
//   reorder       { entity_id, bucket, ordered_ids } the full live order of one bucket
//   archive       { item_id }                        discussed — off the list, kept
//   restore       { item_id }
//   delete_item   { item_id }                        gone for good, private notes with it
//   add_note      { item_id, body }                  private, staff-only
//   delete_note   { note_id }                        author only
//   raise_action  { item_id, title?, assignee_id? }  a Work Planner task, due in 5 days
//
// Returns { success, ... }. The card refetches after every call, so responses
// carry only what the caller could not otherwise know.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { requireStaffOrService, authErrorResponse } from "../_shared/require-staff.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", ...cors } });
}

const BUCKETS = ["agenda", "info"];
const MAX_TEXT = 4000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

class BadRequest extends Error {
  status: number;
  constructor(message: string, status = 400) { super(message); this.status = status; }
}

function text(v: unknown, field: string): string {
  const s = String(v ?? "").trim();
  if (!s) throw new BadRequest(`${field} required`);
  if (s.length > MAX_TEXT) throw new BadRequest(`${field} too long`);
  return s;
}
function uuid(v: unknown, field: string): string {
  const s = String(v ?? "");
  if (!UUID.test(s)) throw new BadRequest(`${field} must be a uuid`);
  return s;
}
function bucket(v: unknown): string {
  const s = String(v ?? "");
  if (!BUCKETS.includes(s)) throw new BadRequest("bucket must be agenda or info");
  return s;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ success: false, error: "POST required" }, 405);

  // Staff only. Nothing automated writes an agenda, and every write is
  // attributed to a person, so there is no service-role path to keep open.
  let caller;
  try { caller = await requireStaffOrService(req, { allowService: false }); }
  catch (e) { return authErrorResponse(e, cors); }
  const me = caller.userId;

  const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  const p = await req.json().catch(() => ({}));
  const now = new Date().toISOString();

  async function loadItem(id: string) {
    const { data, error } = await db.from("client_agenda_items").select("*").eq("id", id).maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) throw new BadRequest("Agenda item not found", 404);
    return data;
  }
  async function nextSort(entityId: string, b: string) {
    const { data, error } = await db
      .from("client_agenda_items")
      .select("sort_order")
      .eq("entity_id", entityId).eq("bucket", b).is("archived_at", null)
      .order("sort_order", { ascending: false }).limit(1);
    if (error) throw new Error(error.message);
    return (data?.[0]?.sort_order ?? -1) + 1;
  }
  async function patchItem(id: string, patch: Record<string, unknown>) {
    const { error } = await db.from("client_agenda_items")
      .update({ ...patch, updated_by: me, updated_at: now }).eq("id", id);
    if (error) throw new Error(error.message);
  }

  try {
    switch (p.action) {
      case "add_item": {
        const entityId = uuid(p.entity_id, "entity_id");
        const b = p.bucket == null ? "agenda" : bucket(p.bucket);
        const body = text(p.body, "body");
        const { data: ent } = await db.from("entities").select("id").eq("id", entityId).maybeSingle();
        if (!ent) throw new BadRequest("Client not found", 404);
        const { data, error } = await db.from("client_agenda_items").insert({
          entity_id: entityId, bucket: b, body, sort_order: await nextSort(entityId, b),
          created_by: me, updated_by: me,
        }).select("id").single();
        if (error) throw new Error(error.message);
        return json({ success: true, id: data.id });
      }

      case "edit_item": {
        const item = await loadItem(uuid(p.item_id, "item_id"));
        await patchItem(item.id, { body: text(p.body, "body") });
        return json({ success: true });
      }

      case "move": {
        const item = await loadItem(uuid(p.item_id, "item_id"));
        const b = bucket(p.bucket);
        if (item.bucket === b) return json({ success: true });
        await patchItem(item.id, { bucket: b, sort_order: await nextSort(item.entity_id, b) });
        return json({ success: true });
      }

      case "reorder": {
        const entityId = uuid(p.entity_id, "entity_id");
        const b = bucket(p.bucket);
        const ids: string[] = Array.isArray(p.ordered_ids) ? p.ordered_ids.map((x: unknown) => uuid(x, "ordered_ids")) : [];
        // The caller must send exactly the live items of that bucket. A stale
        // tab missing an item someone else just added gets a 409 and refetches,
        // rather than silently renumbering around a row it cannot see.
        const { data: live, error } = await db.from("client_agenda_items")
          .select("id").eq("entity_id", entityId).eq("bucket", b).is("archived_at", null);
        if (error) throw new Error(error.message);
        const liveIds = new Set((live || []).map((r) => r.id));
        if (ids.length !== liveIds.size || new Set(ids).size !== ids.length || !ids.every((id) => liveIds.has(id))) {
          throw new BadRequest("The list changed — refresh and try again", 409);
        }
        for (let i = 0; i < ids.length; i++) {
          const { error: uErr } = await db.from("client_agenda_items").update({ sort_order: i }).eq("id", ids[i]);
          if (uErr) throw new Error(uErr.message);
        }
        return json({ success: true });
      }

      case "archive": {
        const item = await loadItem(uuid(p.item_id, "item_id"));
        if (item.archived_at) return json({ success: true });
        await patchItem(item.id, { archived_at: now, archived_by: me });
        return json({ success: true });
      }

      case "restore": {
        const item = await loadItem(uuid(p.item_id, "item_id"));
        if (!item.archived_at) return json({ success: true });
        await patchItem(item.id, {
          archived_at: null, archived_by: null,
          sort_order: await nextSort(item.entity_id, item.bucket),
        });
        return json({ success: true });
      }

      // Archive is "we discussed it"; delete is "this should never have been
      // here" — a test, a duplicate, the wrong client. Any staff member, as
      // with every other write here; the notes cascade (sql/301).
      case "delete_item": {
        const item = await loadItem(uuid(p.item_id, "item_id"));
        const { error } = await db.from("client_agenda_items").delete().eq("id", item.id);
        if (error) throw new Error(error.message);
        return json({ success: true });
      }

      case "add_note": {
        const item = await loadItem(uuid(p.item_id, "item_id"));
        const { data, error } = await db.from("client_agenda_notes")
          .insert({ item_id: item.id, author_id: me, body: text(p.body, "body") })
          .select("id").single();
        if (error) throw new Error(error.message);
        return json({ success: true, id: data.id });
      }

      case "delete_note": {
        const noteId = uuid(p.note_id, "note_id");
        const { data: note } = await db.from("client_agenda_notes").select("id, author_id").eq("id", noteId).maybeSingle();
        if (!note) throw new BadRequest("Note not found", 404);
        if (note.author_id !== me) throw new BadRequest("Only the author can delete a note", 403);
        const { error } = await db.from("client_agenda_notes").delete().eq("id", noteId);
        if (error) throw new Error(error.message);
        return json({ success: true });
      }

      case "raise_action": {
        const item = await loadItem(uuid(p.item_id, "item_id"));
        const assignee = p.assignee_id ? uuid(p.assignee_id, "assignee_id") : me;
        const { data: staff } = await db.from("staff_profiles").select("id, is_active").eq("id", assignee).maybeSingle();
        if (!staff?.is_active) throw new BadRequest("Assignee must be an active team member");
        const { data: ent } = await db.from("entities").select("name").eq("id", item.entity_id).maybeSingle();
        const what = p.title ? text(p.title, "title") : item.body;
        const title = `Action: ${ent?.name ?? "Client"} — ${what}`.slice(0, 500);
        const { data: task, error } = await db.from("quick_tasks").insert({
          title, entity_id: item.entity_id, service: "Admin", assignee_id: assignee,
          due_date: new Date(Date.now() + 5 * 86400000).toISOString(),
          planned_date: null, duration: 15,
          notes: "Raised from the client meeting agenda", sort_order: 0, created_by: me,
        }).select("id").single();
        if (error) throw new Error(error.message);
        await patchItem(item.id, { action_task_id: task.id, action_title: title, action_raised_at: now });
        return json({ success: true, task_id: task.id });
      }

      default:
        throw new BadRequest("Unknown action");
    }
  } catch (e) {
    if (e instanceof BadRequest) return json({ success: false, error: e.message }, e.status);
    return json({ success: false, error: (e as Error).message }, 500);
  }
});
