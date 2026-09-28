// quote-comments — Athena Portal
//
// The writes behind the Comments panel on a quote (sql/344). The browser holds
// SELECT on quote_comments and nothing else, because a new mutating path is an
// edge function (CLAUDE.md). Attribution is the JWT's user, never a field in
// the body.
//
// Body: { action, ...fields }
//   add     { quote_id, body }   anyone who can see the quote
//   delete  { comment_id }       the author only
//
// Whether the caller can see the quote is decided by the database, not here:
// the quote is looked up through a client carrying the caller's own JWT, so
// quotes' RLS (fee staff, quote staff, per-client figure scoping) applies.

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
        const quoteId = uuid(p.quote_id, "quote_id");
        const body = String(p.body ?? "").trim();
        if (!body) throw new BadRequest("body required");
        if (body.length > MAX_TEXT) throw new BadRequest("body too long");
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
        const { data: c } = await db.from("quote_comments").select("id, author_id").eq("id", commentId).maybeSingle();
        if (!c) throw new BadRequest("Comment not found", 404);
        if (c.author_id !== me) throw new BadRequest("Only the author can delete a comment", 403);
        const { error } = await db.from("quote_comments").delete().eq("id", commentId);
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
