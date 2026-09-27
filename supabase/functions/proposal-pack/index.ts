// proposal-pack — Athena Portal
//
// Saves the proposal pack's edited pages (sql/327). The browser reads
// proposal_pack_pages directly; writes come here.
//
//   { action: "save_page",  page_key, content }  → store this page's edit
//   { action: "reset_page", page_key }           → back to the standard text
//
// Staff with can_edit_fee_schedule only (the Pricing & Proposals screen's
// permission). No service-role path: nothing automated edits the pack.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { requireStaffOrService, authErrorResponse } from "../_shared/require-staff.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", ...cors } });

const KEY = /^[a-z0-9_]{1,60}$/;
const MAX_TEXT = 2000;
const MAX_ITEMS = 12;
// A page may carry one uploaded picture as a data URL, resized in the
// browser; cap it so a page stays a sensible size.
const MAX_IMAGE = 1_500_000;

class BadRequest extends Error {}

const str = (v: unknown, field: string, max = MAX_TEXT) => {
  const s = v == null ? "" : String(v);
  if (s.length > max) throw new BadRequest(`${field} is too long`);
  return s;
};
const list = (v: unknown, field: string) => {
  if (v == null) return [];
  if (!Array.isArray(v) || v.length > MAX_ITEMS) throw new BadRequest(`${field} must be a list of up to ${MAX_ITEMS}`);
  return v.map((x, i) => str(x, `${field}[${i}]`, 400));
};

// Only the fields a page has; anything else is dropped.
function cleanContent(c: Record<string, unknown>) {
  if (!c || typeof c !== "object") throw new BadRequest("content required");
  const image = c.image == null ? null : str(c.image, "image", MAX_IMAGE);
  if (image && !/^data:image\/(jpeg|png|webp);base64,/.test(image)) throw new BadRequest("image must be a JPEG, PNG or WebP data URL");
  return {
    title: str(c.title, "title", 120),
    tagline: str(c.tagline, "tagline", 300),
    intro: str(c.intro, "intro"),
    weDo: list(c.weDo, "weDo"),
    youProvide: list(c.youProvide, "youProvide"),
    icon: str(c.icon, "icon", 40),
    graphic: str(c.graphic, "graphic", 40),
    accent: str(c.accent, "accent", 40),
    image,
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ success: false, error: "POST required" }, 405);

  let caller;
  try { caller = await requireStaffOrService(req, { flag: "can_edit_fee_schedule", allowService: false }); }
  catch (e) { return authErrorResponse(e, cors); }

  try {
    const body = await req.json().catch(() => ({})) as Record<string, unknown>;
    const key = String(body.page_key || "");
    if (!KEY.test(key)) throw new BadRequest("page_key must be lower-case letters, digits and underscores");
    const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

    if (body.action === "save_page") {
      const content = cleanContent(body.content as Record<string, unknown>);
      const { error } = await db.from("proposal_pack_pages").upsert({
        page_key: key, content, updated_at: new Date().toISOString(), updated_by: caller.userId,
      });
      if (error) return json({ success: false, error: error.message }, 500);
      return json({ success: true });
    }
    if (body.action === "reset_page") {
      const { error } = await db.from("proposal_pack_pages").delete().eq("page_key", key);
      if (error) return json({ success: false, error: error.message }, 500);
      return json({ success: true });
    }
    throw new BadRequest("unknown action");
  } catch (e) {
    if (e instanceof BadRequest) return json({ success: false, error: e.message }, 400);
    return json({ success: false, error: String((e as Error)?.message || e) }, 500);
  }
});
