// quote-comments — Athena Portal
//
// The writes behind internal comments on quotes (sql/344 quote_comments) and
// on a client's fee review (sql/345 fee_review_comments). The browser holds
// SELECT on both and nothing else, because a new mutating path is an edge
// function (CLAUDE.md). Attribution is the JWT's user, never a field in the
// body.
//
// Body: { action, ...fields }
//   add     { quote_id, body }            anyone who can see the quote
//   add     { entity_id, body }           a fee review: fee staff who can see the client's figures
//   delete  { comment_id, kind? }         the author only; kind "quote" (default) | "review"
//
// Whether the caller can see the quote or review is decided by the database,
// not here: it is looked up through a client carrying the caller's own JWT,
// so the tables' own RLS (fee/quote staff, per-client figure scoping) applies.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { requireStaffOrService, authErrorResponse } from "../_shared/require-staff.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", ...cors } });
}

const MAX_TEXT = 4000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

class BadRequest extends Error {
  status: number;
  constructor(message: string, status = 400) { super(message); this.status = status; }
}
function uuid(v: unknown, field: string): string {
  const s = String(v ?? "");
  if (!UUID.test(s)) throw new BadRequest(`${field} must be a uuid`);
  return s;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ success: false, error: "POST required" }, 405);

  // Staff only: every comment is a person's, so there is no service path.
  let caller;
  try { caller = await requireStaffOrService(req, { allowService: false }); }
  catch (e) { return authErrorResponse(e, cors); }
  const me = caller.userId;

  const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  const asCaller = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false },
    global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
  });
  const p = await req.json().catch(() => ({}));

  try {
    switch (p.action) {
      case "add": {
        const body = String(p.body ?? "").trim();
        if (!body) throw new BadRequest("body required");
        if (body.length > MAX_TEXT) throw new BadRequest("body too long");

        if (p.entity_id != null) {
          const entityId = uuid(p.entity_id, "entity_id");
          // A fee review exists as a fee_proposals row or a live_billing line,
          // both fee-gated and figure-scoped; RLS decides whether it's visible.
          const [{ data: fp }, { data: lb }] = await Promise.all([
            asCaller.from("fee_proposals").select("id").eq("entity_id", entityId).limit(1),
            asCaller.from("live_billing").select("id").eq("entity_id", entityId).limit(1),
          ]);
          if (!fp?.length && !lb?.length) throw new BadRequest("Fee review not found", 404);
          const { data, error } = await db.from("fee_review_comments")
            .insert({ entity_id: entityId, author_id: me, body })
            .select("id, entity_id, author_id, body, created_at").single();
          if (error) throw new Error(error.message);
          return json({ success: true, comment: data });
        }

        const quoteId = uuid(p.quote_id, "quote_id");
        // RLS decides: a quote the caller can't read is "not found".
        const { data: q } = await asCaller.from("quotes").select("id").eq("id", quoteId).maybeSingle();
        if (!q) throw new BadRequest("Quote not found", 404);
        const { data, error } = await db.from("quote_comments")
          .insert({ quote_id: quoteId, author_id: me, body })
          .select("id, quote_id, author_id, body, created_at").single();
        if (error) throw new Error(error.message);
        return json({ success: true, comment: data });
      }

      case "delete": {
        const commentId = uuid(p.comment_id, "comment_id");
        const table = p.kind === "review" ? "fee_review_comments" : "quote_comments";
        const { data: c } = await db.from(table).select("id, author_id").eq("id", commentId).maybeSingle();
        if (!c) throw new BadRequest("Comment not found", 404);
        if (c.author_id !== me) throw new BadRequest("Only the author can delete a comment", 403);
        const { error } = await db.from(table).delete().eq("id", commentId);
        if (error) throw new Error(error.message);
        return json({ success: true });
      }

      default:
        throw new BadRequest("Unknown action");
    }
  } catch (e) {
    const status = e instanceof BadRequest ? e.status : 500;
    return json({ success: false, error: e instanceof Error ? e.message : String(e) }, status);
  }
});
