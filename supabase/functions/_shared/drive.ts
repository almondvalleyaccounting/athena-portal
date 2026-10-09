// Google Drive + Docs client for Athena (sql/362).
//
// One token: the single active gdrive_connections row, which since sql/362 holds
// the full `drive` scope so Athena can see the practice's own client tree in the
// AV.Shared shared drive. That token can also see the connecting person's My
// Drive, so every call that takes an id from the browser goes through
// assertInSharedDrive() first: Athena only ever reads or writes inside AV.Shared.
//
// Callers run as service_role and must have authorised the human already
// (require-staff.ts). The token never leaves the edge function.

import { failureUpdate, refreshWithRetry } from "./oauth-refresh.ts";

export const SHARED_DRIVE_ID = "0ADCuEG7gsLOGUk9PVA"; // AV.Shared
export const CATEGORY_FOLDERS = ["Ltd_Cos", "Individuals", "Partnerships"] as const;
export const FOLDER_MIME = "application/vnd.google-apps.folder";
export const DOC_MIME = "application/vnd.google-apps.document";

const GOOGLE_CLIENT_ID = Deno.env.get("GOOGLE_CLIENT_ID")!;
const GOOGLE_CLIENT_SECRET = Deno.env.get("GOOGLE_CLIENT_SECRET")!;
const API = "https://www.googleapis.com/drive/v3";

export class DriveError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  webViewLink?: string;
  modifiedTime?: string;
  size?: string;
  parents?: string[];
  driveId?: string;
  iconLink?: string;
}

// deno-lint-ignore no-explicit-any
export async function getDriveToken(sb: any): Promise<{ token: string; scope: string; account: string }> {
  const { data: conn, error } = await sb.from("gdrive_connections").select("*").eq("status", "active").maybeSingle();
  if (error) throw new Error(`gdrive_connections lookup failed: ${error.message}`);
  if (!conn) throw new DriveError(409, "Google Drive is not connected. Connect it from Settings → Connections.");
  const scope = String(conn.scope || "");
  if (!/auth\/drive(\s|$)/.test(scope)) {
    throw new DriveError(409, "The Drive connection only has access to files Athena created. Reconnect it from Settings → Connections to let Athena read the client folders.");
  }
  if (new Date(conn.token_expires_at).getTime() - Date.now() > 5 * 60 * 1000) {
    return { token: conn.access_token, scope, account: conn.account_email };
  }
  // Transient failures keep the connection enabled; only a dead grant disables it.
  const outcome = await refreshWithRetry("https://oauth2.googleapis.com/token", new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    client_secret: GOOGLE_CLIENT_SECRET,
    grant_type: "refresh_token",
    refresh_token: conn.refresh_token,
  }));
  if (!outcome.ok) {
    await sb.from("gdrive_connections").update(failureUpdate(outcome)).eq("id", conn.id);
    throw new DriveError(502, `Drive token refresh failed: ${outcome.status}${outcome.permanent ? " — reconnect required" : " — transient, try again"}`);
  }
  // deno-lint-ignore no-explicit-any
  const tokens = outcome.tokens as Record<string, any>;
  await sb.from("gdrive_connections").update({
    access_token: tokens.access_token,
    token_expires_at: new Date(Date.now() + tokens.expires_in * 1000).toISOString(),
    last_refreshed_at: new Date().toISOString(),
    status: "active", error_message: null, updated_at: new Date().toISOString(),
  }).eq("id", conn.id);
  return { token: tokens.access_token, scope, account: conn.account_email };
}

async function gfetch(token: string, url: string, init: RequestInit = {}): Promise<Response> {
  const resp = await fetch(url, { ...init, headers: { Authorization: `Bearer ${token}`, ...(init.headers || {}) } });
  if (!resp.ok) {
    const body = await resp.text();
    let msg = body.slice(0, 400);
    try { msg = JSON.parse(body)?.error?.message || msg; } catch { /* keep raw */ }
    throw new DriveError(resp.status === 404 ? 404 : 502, `Google ${resp.status}: ${msg}`);
  }
  return resp;
}

const FILE_FIELDS = "id,name,mimeType,webViewLink,modifiedTime,size,parents,driveId,iconLink";

function q(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

/** Every child of a folder (all pages). foldersOnly narrows to subfolders. */
export async function listChildren(token: string, folderId: string, opts: { foldersOnly?: boolean; max?: number } = {}): Promise<DriveFile[]> {
  const out: DriveFile[] = [];
  let pageToken: string | undefined;
  const max = opts.max ?? 5000;
  do {
    const params = new URLSearchParams({
      q: [`'${q(folderId)}' in parents`, "trashed = false", ...(opts.foldersOnly ? [`mimeType = '${FOLDER_MIME}'`] : [])].join(" and "),
      fields: `nextPageToken,files(${FILE_FIELDS})`,
      pageSize: "1000",
      orderBy: "folder,name",
      supportsAllDrives: "true",
      includeItemsFromAllDrives: "true",
      corpora: "drive",
      driveId: SHARED_DRIVE_ID,
    });
    if (pageToken) params.set("pageToken", pageToken);
    const resp = await gfetch(token, `${API}/files?${params}`);
    const page = await resp.json();
    out.push(...(page.files || []));
    pageToken = page.nextPageToken;
  } while (pageToken && out.length < max);
  return out;
}

export async function getFile(token: string, fileId: string): Promise<DriveFile> {
  const resp = await gfetch(token, `${API}/files/${encodeURIComponent(fileId)}?supportsAllDrives=true&fields=${FILE_FIELDS}`);
  return await resp.json();
}

/**
 * Folder names from the top of AV.Shared down to this folder (inclusive), e.g.
 * ["Individuals", "Agnew.James", "04_Accounts"]. Drive for desktop shows the same
 * tree at <letter>:\Shared drives\AV.Shared\…, which is how athena-open finds it.
 */
export async function folderPath(token: string, folderId: string): Promise<string[]> {
  const names: string[] = [];
  let id = folderId;
  for (let depth = 0; depth < 20 && id && id !== SHARED_DRIVE_ID; depth++) {
    const f = await getFile(token, id);
    if (f.driveId !== SHARED_DRIVE_ID) throw new DriveError(403, "That folder is not in the AV.Shared drive.");
    names.unshift(f.name);
    id = f.parents?.[0] ?? "";
  }
  return names;
}

/** The one guard that keeps a full-scope token inside AV.Shared. */
export async function assertInSharedDrive(token: string, fileId: string): Promise<DriveFile> {
  const f = await getFile(token, fileId);
  if (f.driveId !== SHARED_DRIVE_ID) throw new DriveError(403, "That file is not in the AV.Shared drive.");
  return f;
}

/** A direct child folder by name (case-insensitive), or null. */
export async function findChildFolder(token: string, parentId: string, name: string): Promise<DriveFile | null> {
  const kids = await listChildren(token, parentId, { foldersOnly: true });
  const want = name.trim().toLowerCase();
  return kids.find((k) => k.name.trim().toLowerCase() === want) ?? null;
}

export async function createFolder(token: string, parentId: string, name: string): Promise<DriveFile> {
  const resp = await gfetch(token, `${API}/files?supportsAllDrives=true&fields=${FILE_FIELDS}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, mimeType: FOLDER_MIME, parents: [parentId] }),
  });
  return await resp.json();
}

export async function findOrCreateFolder(token: string, parentId: string, name: string): Promise<{ folder: DriveFile; created: boolean }> {
  const existing = await findChildFolder(token, parentId, name);
  if (existing) return { folder: existing, created: false };
  return { folder: await createFolder(token, parentId, name), created: true };
}

/** Multipart upload. Google-native conversion when convertTo is set. */
export async function uploadFile(token: string, parentId: string, name: string, mime: string, bytes: Uint8Array, convertTo?: string): Promise<DriveFile> {
  const boundary = "athena_" + crypto.randomUUID().replace(/-/g, "");
  const meta = JSON.stringify({ name, parents: [parentId], ...(convertTo ? { mimeType: convertTo } : {}) });
  const enc = new TextEncoder();
  const head = enc.encode(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n--${boundary}\r\nContent-Type: ${mime || "application/octet-stream"}\r\n\r\n`);
  const tail = enc.encode(`\r\n--${boundary}--`);
  const body = new Uint8Array(head.length + bytes.length + tail.length);
  body.set(head, 0); body.set(bytes, head.length); body.set(tail, head.length + bytes.length);
  const resp = await gfetch(token, `https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true&fields=${FILE_FIELDS}`, {
    method: "POST",
    headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
    body,
  });
  return await resp.json();
}

/** A new Google Doc whose body starts as the given plain text. */
export function createDoc(token: string, parentId: string, title: string, text: string): Promise<DriveFile> {
  return uploadFile(token, parentId, title, "text/plain", new TextEncoder().encode(text), DOC_MIME);
}

/** Append plain text to the end of a Google Doc (Docs API). */
export async function appendToDoc(token: string, docId: string, text: string): Promise<void> {
  await gfetch(token, `https://docs.googleapis.com/v1/documents/${encodeURIComponent(docId)}:batchUpdate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ requests: [{ insertText: { endOfSegmentLocation: {}, text } }] }),
  });
}

/** A Google Doc as plain text, as it stands now (edits made in Drive included). */
export async function exportDocText(token: string, docId: string): Promise<string> {
  const resp = await gfetch(token, `${API}/files/${encodeURIComponent(docId)}/export?mimeType=text/plain`);
  return (await resp.text()).replace(/^﻿/, "");
}

/** How a client folder name compares to an entity name. */
export function normaliseName(s: string): string {
  return s
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/\(.*?\)/g, " ")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\b(limited|ltd|llp|plc|the|t\/a|ta|and)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Year-end folders are named after the period end: 2025.12.31. */
export function yearEndFolderName(periodEnd: string): string {
  return periodEnd.replace(/-/g, ".");
}
