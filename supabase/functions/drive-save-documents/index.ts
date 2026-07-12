// drive-save-documents — Athena Portal
// Saves an onboarding's received documents to Google Drive in one click:
// ensures the "Athena Client Documents/<Client Name>" folder exists inside
// the AV.Shared shared drive (drive.file scope — only app-created folders
// are visible to us), uploads every onboarding_documents row still at
// status 'received', stamps drive_file_id/drive_web_link and logs to the
// activity timeline.
//
// The connecting Google account must be a member of AV.Shared with at
// least Content manager access, or every upload below 403s.
//
// Auth: any active staff JWT. Body: { onboarding_id: string }

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const GOOGLE_CLIENT_ID = Deno.env.get("GOOGLE_CLIENT_ID")!;
const GOOGLE_CLIENT_SECRET = Deno.env.get("GOOGLE_CLIENT_SECRET")!;
const ROOT_FOLDER_NAME = "Athena Client Documents";
const SHARED_DRIVE_ID = "0ADCuEG7gsLOGUk9PVA"; // AV.Shared

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", ...corsHeaders } });
}

// deno-lint-ignore no-explicit-any
async function getValidDriveToken(sb: any): Promise<string> {
  const { data: conn, error } = await sb.from("gdrive_connections").select("*").eq("status", "active").maybeSingle();
  if (error) throw new Error(`gdrive_connections lookup failed: ${error.message}`);
  if (!conn) throw new Error("No active Google Drive connection. Connect Drive from the onboarding screen first.");

  if (new Date(conn.token_expires_at).getTime() - Date.now() > 5 * 60 * 1000) {
    return conn.access_token;
  }
  const resp = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      grant_type: "refresh_token",
      refresh_token: conn.refresh_token,
    }),
  });
  if (!resp.ok) {
    const errBody = await resp.text();
    await sb.from("gdrive_connections").update({
      status: "error", error_message: `Token refresh failed: ${resp.status} ${errBody}`, updated_at: new Date().toISOString(),
    }).eq("id", conn.id);
    throw new Error(`Drive token refresh failed: ${resp.status} ${errBody}`);
  }
  const tokens = await resp.json();
  await sb.from("gdrive_connections").update({
    access_token: tokens.access_token,
    token_expires_at: new Date(Date.now() + tokens.expires_in * 1000).toISOString(),
    last_refreshed_at: new Date().toISOString(),
    status: "active", error_message: null, updated_at: new Date().toISOString(),
  }).eq("id", conn.id);
  return tokens.access_token;
}

async function findOrCreateFolder(token: string, name: string, parentId: string): Promise<{ id: string; link: string }> {
  const safe = name.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
  const qParts = [`name = '${safe}'`, "mimeType = 'application/vnd.google-apps.folder'", "trashed = false", `'${parentId}' in parents`];
  const listParams = new URLSearchParams({
    q: qParts.join(" and "),
    fields: "files(id,webViewLink)",
    supportsAllDrives: "true",
    includeItemsFromAllDrives: "true",
    corpora: "drive",
    driveId: SHARED_DRIVE_ID,
  });
  const listResp = await fetch(`https://www.googleapis.com/drive/v3/files?${listParams.toString()}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!listResp.ok) throw new Error(`Drive folder search failed: ${listResp.status} ${await listResp.text()}`);
  const list = await listResp.json();
  if (list.files?.length) return { id: list.files[0].id, link: list.files[0].webViewLink };

  const createResp = await fetch(`https://www.googleapis.com/drive/v3/files?supportsAllDrives=true&fields=${encodeURIComponent("id,webViewLink")}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ name, mimeType: "application/vnd.google-apps.folder", parents: [parentId] }),
  });
  if (!createResp.ok) throw new Error(`Drive folder create failed: ${createResp.status} ${await createResp.text()}`);
  const created = await createResp.json();
  return { id: created.id, link: created.webViewLink };
}

async function uploadToDrive(token: string, folderId: string, name: string, mime: string, bytes: Uint8Array): Promise<{ id: string; link: string }> {
  const boundary = "athena_" + crypto.randomUUID().replace(/-/g, "");
  const meta = JSON.stringify({ name, parents: [folderId] });
  const encoder = new TextEncoder();
  const head = encoder.encode(
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n--${boundary}\r\nContent-Type: ${mime || "application/octet-stream"}\r\n\r\n`,
  );
  const tail = encoder.encode(`\r\n--${boundary}--`);
  const body = new Uint8Array(head.length + bytes.length + tail.length);
  body.set(head, 0); body.set(bytes, head.length); body.set(tail, head.length + bytes.length);

  const resp = await fetch(
    `https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true&fields=${encodeURIComponent("id,webViewLink")}`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": `multipart/related; boundary=${boundary}` },
      body,
    },
  );
  if (!resp.ok) throw new Error(`Drive upload failed for ${name}: ${resp.status} ${await resp.text()}`);
  const f = await resp.json();
  return { id: f.id, link: f.webViewLink };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ success: false, error: "POST required" }, 405);

  const service = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  // Auth: any active staff member
  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return json({ success: false, error: "Missing authorization" }, 401);
  const anon = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { global: { headers: { Authorization: authHeader } } });
  const { data: { user }, error: authErr } = await anon.auth.getUser();
  if (authErr || !user) return json({ success: false, error: "Invalid token" }, 401);
  const { data: prof } = await service.from("staff_profiles").select("is_active").eq("id", user.id).single();
  if (!prof?.is_active) return json({ success: false, error: "Not authorised" }, 403);

  const body = await req.json().catch(() => ({}));
  const onboardingId: string | null = body.onboarding_id || null;
  if (!onboardingId) return json({ success: false, error: "onboarding_id required" }, 400);

  const { data: ob, error: obErr } = await service
    .from("onboardings")
    .select("id, entity_id, entity:entities!onboardings_entity_id_fkey(id, name)")
    .eq("id", onboardingId)
    .single();
  if (obErr || !ob) return json({ success: false, error: obErr?.message || "Onboarding not found" }, 404);

  const { data: docs, error: docsErr } = await service
    .from("onboarding_documents")
    .select("*")
    .eq("onboarding_id", onboardingId)
    .eq("status", "received");
  if (docsErr) return json({ success: false, error: docsErr.message }, 500);

  let token: string;
  try {
    token = await getValidDriveToken(service);
  } catch (e) {
    return json({ success: false, error: String((e as Error).message || e) }, 409);
  }

  // Ensure Athena Client Documents/<Client Name>
  const entityName = ((ob.entity as Record<string, unknown>)?.name as string) || "Unknown client";
  let folder: { id: string; link: string };
  try {
    const root = await findOrCreateFolder(token, ROOT_FOLDER_NAME, SHARED_DRIVE_ID);
    folder = await findOrCreateFolder(token, entityName, root.id);
  } catch (e) {
    return json({ success: false, error: String((e as Error).message || e) }, 502);
  }

  const results: Array<Record<string, unknown>> = [];
  let saved = 0;
  for (const doc of docs || []) {
    try {
      const { data: blob, error: dlErr } = await service.storage.from("client-documents").download(doc.storage_path);
      if (dlErr || !blob) throw new Error(`storage download failed: ${dlErr?.message || "no data"}`);
      const bytes = new Uint8Array(await blob.arrayBuffer());
      const up = await uploadToDrive(token, folder.id, doc.original_name, doc.mime_type, bytes);
      await service.from("onboarding_documents").update({
        status: "saved_to_drive", drive_file_id: up.id, drive_web_link: up.link,
      }).eq("id", doc.id);
      saved++;
      results.push({ name: doc.original_name, ok: true, link: up.link });
    } catch (e) {
      results.push({ name: doc.original_name, ok: false, error: String((e as Error).message || e) });
    }
  }

  if (saved > 0) {
    await service.from("onboarding_activity").insert({
      onboarding_id: onboardingId, kind: "system",
      body: `${saved} document${saved === 1 ? "" : "s"} saved to Google Drive → ${ROOT_FOLDER_NAME} / ${entityName}`,
      created_by: user.id,
    });
    await service.from("audit_log").insert({
      user_id: user.id, action: "onboarding_docs_saved_to_drive", entity_type: "onboarding",
      entity_id: onboardingId, detail: { saved, folder: folder.link },
    });
  }

  return json({ success: true, saved, total: (docs || []).length, folder_link: folder.link, results });
});
