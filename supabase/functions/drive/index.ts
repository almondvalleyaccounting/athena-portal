// drive — Athena Portal (sql/362)
//
// Athena's door into the practice Google Drive (AV.Shared). Reads the client
// tree, keeps the client ↔ folder map, finds or makes a year end's folder, and
// keeps the year-end notes Google Doc: Athena appends to it, and reads it back,
// so the Doc is the one copy of the notes and edits made in Drive show here.
//
// Auth: active staff (JWT). `scan` additionally needs can_manage_portal.
// Every id that comes from the browser is checked to be inside AV.Shared
// (assertInSharedDrive) because the connection's token can see more than that.
//
// Actions (POST { action, ... }):
//   status                                       connection + map counts
//   scan                                         index client folders, suggest matches
//   confirm      { entity_ids: [] }              suggested → confirmed
//   set_folder   { entity_id, folder_id }        pin a client's folder (confirmed)
//   set_accounts_folder { entity_id, folder_id|null }  where its year-end folders live
//   clear        { entity_id }                   forget the mapping
//   roots                                        the top-level folders of AV.Shared
//   path         { folder_id }                   folder names from AV.Shared down (for athena-open)
//   browse       { entity_id?, folder_id?, folders_only? }  a folder's contents
//   year_end     { entity_id, period_end, create? }  the year end's folder
//   notes_get    { entity_id, period_end }       the notes Doc + its text now
//   notes_create { entity_id, period_end, job_plan_id? }
//   notes_append { entity_id, period_end, text, label? }
//   upload       { entity_id, period_end?|folder_id?, name, mime, base64 }

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { authErrorResponse, requireStaffOrService } from "../_shared/require-staff.ts";
import {
  assertInSharedDrive, CATEGORY_FOLDERS, DriveError, type DriveFile, folderPath, getDriveToken, listChildren,
  normaliseName, SHARED_DRIVE_ID, uploadFile,
} from "../_shared/drive.ts";
import {
  appendYearEndNote, clientFolder, ensureYearEndNotes, readYearEndNotes, resolveYearEndFolder,
} from "../_shared/drive-notes.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", ...corsHeaders } });
}

class BadRequest extends Error {}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DRIVE_ID = /^[A-Za-z0-9_-]{10,100}$/;
function uuid(v: unknown, name: string): string {
  const s = String(v || "");
  if (!UUID.test(s)) throw new BadRequest(`${name} must be a uuid`);
  return s;
}
function driveId(v: unknown, name: string): string {
  const s = String(v || "");
  if (!DRIVE_ID.test(s)) throw new BadRequest(`${name} is not a Drive id`);
  return s;
}
function isoDate(v: unknown, name: string): string {
  const s = String(v || "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new BadRequest(`${name} must be YYYY-MM-DD`);
  return s;
}

// Company numbers as they appear in folder names: 8 chars, optional 2-letter prefix.
const CO_NUMBER = /\b((?:SC|NI|OC|SO|NC|R0|LP|SL)?\d{6,8})\b/i;
function tokenKey(n: string): string {
  return n.split(" ").filter(Boolean).sort().join(" ");
}

const ENTITY_CATEGORY: Record<string, string> = {
  limited_company: "Ltd_Cos", llp: "Ltd_Cos", partnership: "Partnerships", sole_trader: "Individuals", personal: "Individuals",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });
  if (req.method !== "POST") return json({ success: false, error: "POST required" }, 405);

  let caller;
  try {
    caller = await requireStaffOrService(req, { allowService: false });
  } catch (e) {
    return authErrorResponse(e, corsHeaders);
  }
  const me = caller.userId!;
  const db = createClient(SUPABASE_URL, SERVICE_KEY);
  const p = await req.json().catch(() => ({})) as Record<string, unknown>;
  const now = new Date().toISOString();

  try {
    switch (String(p.action || "")) {
      case "status": {
        const { data: conn } = await db.from("gdrive_connections").select("account_email, scope, status, connected_at, error_message").eq("status", "active").maybeSingle();
        const [{ count: folders }, { count: confirmed }, { count: suggested }] = await Promise.all([
          db.from("drive_folder_index").select("folder_id", { count: "exact", head: true }),
          db.from("client_drive_folders").select("entity_id", { count: "exact", head: true }).eq("status", "confirmed"),
          db.from("client_drive_folders").select("entity_id", { count: "exact", head: true }).eq("status", "suggested"),
        ]);
        return json({
          success: true,
          connection: conn ? { account_email: conn.account_email, connected_at: conn.connected_at, full_access: /auth\/drive(\s|$)/.test(conn.scope || ""), error: conn.error_message } : null,
          folders: folders ?? 0, confirmed: confirmed ?? 0, suggested: suggested ?? 0,
        });
      }

      case "scan": {
        const { data: prof } = await db.from("staff_profiles").select("can_manage_portal").eq("id", me).maybeSingle();
        if (!prof?.can_manage_portal) return json({ success: false, error: "Scanning Drive needs the System admin permission" }, 403);
        const { token } = await getDriveToken(db);

        // 1. Index the client folders one level under each category folder.
        const top = await listChildren(token, SHARED_DRIVE_ID, { foldersOnly: true });
        const index: Array<DriveFile & { category: string }> = [];
        for (const cat of CATEGORY_FOLDERS) {
          const catFolder = top.find((f) => f.name === cat);
          if (!catFolder) continue;
          const kids = await listChildren(token, catFolder.id, { foldersOnly: true });
          kids.forEach((k) => index.push({ ...k, category: cat }));
        }
        if (!index.length) throw new Error("No client folders found under Ltd_Cos / Individuals / Partnerships");
        const rows = index.map((f) => ({ folder_id: f.id, name: f.name, category: f.category, web_link: f.webViewLink ?? null, modified_at: f.modifiedTime ?? null, scanned_at: now }));
        for (let i = 0; i < rows.length; i += 500) {
          const { error } = await db.from("drive_folder_index").upsert(rows.slice(i, i + 500));
          if (error) throw new Error(error.message);
        }
        await db.from("drive_folder_index").delete().lt("scanned_at", now);

        // 2. Suggest a folder for each client without a confirmed one. A match must
        //    be unique both ways, so a doubtful pairing is left for a person.
        const { data: ents } = await db.from("entities").select("id, name, type, company_number, entity_status").in("entity_status", ["active", "prospect"]);
        const { data: existing } = await db.from("client_drive_folders").select("entity_id, status");
        const confirmedSet = new Set((existing || []).filter((r) => r.status === "confirmed").map((r) => r.entity_id));

        const byNumber = new Map<string, typeof index>();
        const byName = new Map<string, typeof index>();
        const byTokens = new Map<string, typeof index>();
        const add = (m: Map<string, typeof index>, k: string, f: typeof index[number]) => { if (!k) return; m.set(k, [...(m.get(k) || []), f]); };
        for (const f of index) {
          const num = f.name.match(CO_NUMBER)?.[1]?.toUpperCase();
          if (num) add(byNumber, num.padStart(8, "0"), f);
          const n = normaliseName(f.name.replace(CO_NUMBER, " "));
          add(byName, n, f);
          add(byTokens, tokenKey(n), f);
        }
        const entNameCount = new Map<string, number>();
        (ents || []).forEach((e) => { const n = normaliseName(e.name || ""); entNameCount.set(n, (entNameCount.get(n) || 0) + 1); });

        const pick = (cands: typeof index | undefined, type: string) => {
          if (!cands?.length) return null;
          if (cands.length === 1) return cands[0];
          const inCat = cands.filter((c) => c.category === ENTITY_CATEGORY[type]);
          return inCat.length === 1 ? inCat[0] : null;
        };
        const suggestions: Record<string, unknown>[] = [];
        for (const e of ents || []) {
          if (confirmedSet.has(e.id)) continue;
          const n = normaliseName(e.name || "");
          let hit: typeof index[number] | null = null;
          let method = "name";
          const num = String(e.company_number || "").trim().toUpperCase();
          if (num) { hit = pick(byNumber.get(num.padStart(8, "0")), e.type); method = "company_number"; }
          if (!hit && n && entNameCount.get(n) === 1) { hit = pick(byName.get(n), e.type) ?? pick(byTokens.get(tokenKey(n)), e.type); method = "name"; }
          if (hit) suggestions.push({ entity_id: e.id, folder_id: hit.id, folder_name: hit.name, category: hit.category, status: "suggested", match_method: method, set_by: me, updated_at: now });
        }
        // Fresh suggestions replace stale ones; confirmed rows are never touched.
        await db.from("client_drive_folders").delete().eq("status", "suggested");
        for (let i = 0; i < suggestions.length; i += 500) {
          const { error } = await db.from("client_drive_folders").upsert(suggestions.slice(i, i + 500));
          if (error) throw new Error(error.message);
        }
        await db.from("audit_log").insert({ user_id: me, action: "drive_scan", entity_type: "client_drive_folders", detail: { folders: index.length, suggested: suggestions.length, confirmed: confirmedSet.size } });
        return json({ success: true, folders: index.length, suggested: suggestions.length, confirmed: confirmedSet.size, clients: (ents || []).length });
      }

      case "confirm": {
        const ids = (Array.isArray(p.entity_ids) ? p.entity_ids : []).map((x) => uuid(x, "entity_ids[]")).slice(0, 1000);
        if (!ids.length) throw new BadRequest("entity_ids is empty");
        const { data, error } = await db.from("client_drive_folders")
          .update({ status: "confirmed", confirmed_by: me, confirmed_at: now, updated_at: now })
          .in("entity_id", ids).eq("status", "suggested").select("entity_id");
        if (error) throw new Error(error.message);
        return json({ success: true, confirmed: data?.length ?? 0 });
      }

      case "set_folder": {
        const entityId = uuid(p.entity_id, "entity_id");
        const { token } = await getDriveToken(db);
        const f = await assertInSharedDrive(token, driveId(p.folder_id, "folder_id"));
        if (f.mimeType !== "application/vnd.google-apps.folder") throw new BadRequest("That is a file, not a folder");
        const { data: idx } = await db.from("drive_folder_index").select("category").eq("folder_id", f.id).maybeSingle();
        const { error } = await db.from("client_drive_folders").upsert({
          entity_id: entityId, folder_id: f.id, folder_name: f.name, category: idx?.category ?? null,
          status: "confirmed", match_method: "manual", accounts_folder_id: null,
          set_by: me, confirmed_by: me, confirmed_at: now, updated_at: now,
        });
        if (error) throw new Error(error.message);
        await db.from("audit_log").insert({ user_id: me, action: "drive_folder_set", entity_type: "entity", entity_id: entityId, detail: { folder_id: f.id, name: f.name } });
        return json({ success: true, folder: { id: f.id, name: f.name, link: f.webViewLink } });
      }

      case "set_accounts_folder": {
        const entityId = uuid(p.entity_id, "entity_id");
        let folderId: string | null = null;
        if (p.folder_id) {
          const { token } = await getDriveToken(db);
          const f = await assertInSharedDrive(token, driveId(p.folder_id, "folder_id"));
          if (f.mimeType !== "application/vnd.google-apps.folder") throw new BadRequest("That is a file, not a folder");
          folderId = f.id;
        }
        const { data, error } = await db.from("client_drive_folders").update({ accounts_folder_id: folderId, updated_at: now })
          .eq("entity_id", entityId).eq("status", "confirmed").select("entity_id");
        if (error) throw new Error(error.message);
        if (!data?.length) throw new BadRequest("Confirm the client's folder first");
        return json({ success: true });
      }

      case "clear": {
        const entityId = uuid(p.entity_id, "entity_id");
        await db.from("client_drive_folders").delete().eq("entity_id", entityId);
        await db.from("audit_log").insert({ user_id: me, action: "drive_folder_cleared", entity_type: "entity", entity_id: entityId, detail: {} });
        return json({ success: true });
      }

      // The top of AV.Shared, for the folder explorer.
      case "roots": {
        const { token } = await getDriveToken(db);
        const top = await listChildren(token, SHARED_DRIVE_ID, { foldersOnly: true });
        return json({ success: true, folders: top.map((f) => ({ id: f.id, name: f.name, link: f.webViewLink })) });
      }

      // A folder's place in AV.Shared, for opening it on the PC (athena-open).
      case "path": {
        const { token } = await getDriveToken(db);
        const f = await assertInSharedDrive(token, driveId(p.folder_id, "folder_id"));
        return json({ success: true, path: await folderPath(token, f.id) });
      }

      case "browse": {
        const { token } = await getDriveToken(db);
        let folderId: string;
        if (p.folder_id) {
          folderId = driveId(p.folder_id, "folder_id");
        } else {
          const map = await clientFolder(db, uuid(p.entity_id, "entity_id"), { confirmedOnly: false });
          folderId = map.folder_id;
        }
        const folder = await assertInSharedDrive(token, folderId);
        const [items, path] = await Promise.all([
          listChildren(token, folder.id, { max: 2000, foldersOnly: p.folders_only === true }),
          p.folders_only === true ? Promise.resolve(null) : folderPath(token, folder.id),
        ]);
        return json({
          success: true,
          folder: { id: folder.id, name: folder.name, link: folder.webViewLink, parent: folder.parents?.[0] ?? null, path },
          items: items.map((f) => ({ id: f.id, name: f.name, mime: f.mimeType, link: f.webViewLink, modified: f.modifiedTime, size: f.size ? Number(f.size) : null, is_folder: f.mimeType === "application/vnd.google-apps.folder" })),
        });
      }

      case "year_end": {
        const { token } = await getDriveToken(db);
        const r = await resolveYearEndFolder(db, token, uuid(p.entity_id, "entity_id"), isoDate(p.period_end, "period_end"), { create: p.create === true });
        return json({ success: true, ...r });
      }

      case "notes_get": {
        const out = await readYearEndNotes(db, uuid(p.entity_id, "entity_id"), isoDate(p.period_end, "period_end"));
        return json({ success: true, ...out });
      }

      case "notes_create": {
        const doc = await ensureYearEndNotes(db, {
          entityId: uuid(p.entity_id, "entity_id"), periodEnd: isoDate(p.period_end, "period_end"),
          jobPlanId: p.job_plan_id ? uuid(p.job_plan_id, "job_plan_id") : null, by: me,
        });
        return json({ success: true, doc });
      }

      case "notes_append": {
        const text = String(p.text || "").trim().slice(0, 20000);
        if (!text) throw new BadRequest("Nothing to add");
        const doc = await appendYearEndNote(db, {
          entityId: uuid(p.entity_id, "entity_id"), periodEnd: isoDate(p.period_end, "period_end"),
          text, label: p.label ? String(p.label).slice(0, 160) : null, by: me, createIfMissing: true,
        });
        return json({ success: true, doc });
      }

      case "upload": {
        const entityId = uuid(p.entity_id, "entity_id");
        const name = String(p.name || "").trim().slice(0, 240);
        if (!name) throw new BadRequest("name is needed");
        const b64 = String(p.base64 || "");
        if (!b64) throw new BadRequest("No file");
        if (b64.length > 14_000_000) throw new BadRequest("Files over 10 MB go into Drive directly");
        const { token } = await getDriveToken(db);
        let folderId: string;
        if (p.folder_id) {
          folderId = (await assertInSharedDrive(token, driveId(p.folder_id, "folder_id"))).id;
        } else if (p.period_end) {
          const r = await resolveYearEndFolder(db, token, entityId, isoDate(p.period_end, "period_end"), { create: true });
          if (!r.folder) throw new BadRequest(r.reason || "No year-end folder");
          folderId = r.folder.id;
        } else {
          folderId = (await clientFolder(db, entityId, { confirmedOnly: true })).folder_id;
        }
        const bin = atob(b64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        const f = await uploadFile(token, folderId, name, String(p.mime || "application/octet-stream"), bytes);
        await db.from("audit_log").insert({ user_id: me, action: "drive_upload", entity_type: "entity", entity_id: entityId, detail: { file_id: f.id, name, folder_id: folderId } });
        return json({ success: true, file: { id: f.id, name: f.name, link: f.webViewLink } });
      }

      default:
        throw new BadRequest(`Unknown action: ${p.action}`);
    }
  } catch (e) {
    if (e instanceof BadRequest) return json({ success: false, error: e.message }, 400);
    if (e instanceof DriveError) return json({ success: false, error: e.message }, e.status);
    console.error("[drive]", (e as Error).message);
    return json({ success: false, error: (e as Error).message || String(e) }, 500);
  }
});
