// Client folders and the year-end notes Doc (sql/362). Shared by the `drive`
// edge function and job-plan (which appends workflow comments to the Doc).
//
// The Doc is the single copy of a year end's notes. Athena appends; people may
// also type straight into it; Athena always reads it back as it stands. So there
// is nothing to merge and no second copy to drift.

import {
  appendToDoc, assertInSharedDrive, createDoc, DriveError, type DriveFile, exportDocText,
  findChildFolder, findOrCreateFolder, getDriveToken, listChildren, yearEndFolderName,
} from "./drive.ts";

// deno-lint-ignore no-explicit-any
type Db = any;

export async function clientFolder(db: Db, entityId: string, opts: { confirmedOnly: boolean }) {
  const { data } = await db.from("client_drive_folders").select("*").eq("entity_id", entityId).maybeSingle();
  if (!data) throw new DriveError(404, "This client has no Drive folder yet. Set it on the client's Drive tab.");
  if (opts.confirmedOnly && data.status !== "confirmed") {
    throw new DriveError(409, "This client's Drive folder is only a suggestion. Confirm it on the client's Drive tab first.");
  }
  return data as { entity_id: string; folder_id: string; folder_name: string; status: string; accounts_folder_id: string | null };
}

/**
 * The folder a year end's files belong in: <client>/04_Accounts/04_StatutoryAccounts/YYYY.MM.DD,
 * or <pinned accounts folder>/YYYY.MM.DD. Only the year folder is ever created —
 * a client laid out differently gets a reason back, not new 04_ folders.
 */
export async function resolveYearEndFolder(db: Db, token: string, entityId: string, periodEnd: string, opts: { create: boolean }) {
  const map = await clientFolder(db, entityId, { confirmedOnly: opts.create });
  const path: string[] = [map.folder_name];
  let parent: DriveFile | null = null;
  if (map.accounts_folder_id) {
    parent = await assertInSharedDrive(token, map.accounts_folder_id);
    path.push(`… ${parent.name}`);
  } else {
    const root = await assertInSharedDrive(token, map.folder_id);
    const kids = await listChildren(token, root.id, { foldersOnly: true });
    const accounts = kids.find((k) => /^\d*[_ ]?accounts$/i.test(k.name.trim()));
    if (accounts) {
      path.push(accounts.name);
      const sub = await listChildren(token, accounts.id, { foldersOnly: true });
      const stat = sub.find((k) => /statutory/i.test(k.name));
      if (stat) { parent = stat; path.push(stat.name); }
    }
  }
  if (!parent) {
    return { folder: null, path, created: false, reason: "No 04_Accounts/04_StatutoryAccounts folder for this client. Pin where its year ends live on the client's Drive tab." };
  }
  const name = yearEndFolderName(periodEnd);
  path.push(name);
  if (opts.create) {
    const { folder, created } = await findOrCreateFolder(token, parent.id, name);
    return { folder: { id: folder.id, name: folder.name, link: folder.webViewLink }, path, created, reason: null };
  }
  const folder = await findChildFolder(token, parent.id, name);
  return {
    folder: folder ? { id: folder.id, name: folder.name, link: folder.webViewLink } : null,
    path, created: false, parent: { id: parent.id, link: parent.webViewLink },
    reason: folder ? null : "The year-end folder does not exist yet; it is made when the notes are started.",
  };
}

function fmtPeriod(iso: string): string {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}
function stamp(): string {
  return new Date().toLocaleString("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "Europe/London" });
}

export async function ensureYearEndNotes(db: Db, a: { entityId: string; periodEnd: string; jobPlanId?: string | null; by: string | null; token?: string }) {
  const { data: existing } = await db.from("drive_documents").select("*")
    .eq("entity_id", a.entityId).eq("kind", "year_end_notes").eq("period_end", a.periodEnd).maybeSingle();
  if (existing) return existing;
  const token = a.token ?? (await getDriveToken(db)).token;
  const r = await resolveYearEndFolder(db, token, a.entityId, a.periodEnd, { create: true });
  if (!r.folder) throw new DriveError(409, r.reason || "No year-end folder");
  const { data: ent } = await db.from("entities").select("name").eq("id", a.entityId).maybeSingle();
  const client = ent?.name || "Client";
  const title = `Year End Notes – ${client} – ${yearEndFolderName(a.periodEnd)}`;
  const intro = `Year End Notes\n${client}\nPeriod end: ${fmtPeriod(a.periodEnd)}\n\n` +
    `Notes added in Athena are appended below with who wrote them and when. You can also type here directly — Athena shows this document as it stands.\n`;
  const doc = await createDoc(token, r.folder.id, title, intro);
  let planId = a.jobPlanId ?? null;
  if (!planId) {
    const { data: plan } = await db.from("job_plans").select("id").eq("entity_id", a.entityId).eq("period_end", a.periodEnd).limit(1).maybeSingle();
    planId = plan?.id ?? null;
  }
  const { data: row, error } = await db.from("drive_documents").insert({
    entity_id: a.entityId, kind: "year_end_notes", period_end: a.periodEnd, job_plan_id: planId,
    file_id: doc.id, folder_id: r.folder.id, web_link: doc.webViewLink ?? null, title, created_by: a.by,
  }).select("*").single();
  if (error) throw new Error(error.message);
  await db.from("audit_log").insert({ user_id: a.by, action: "drive_notes_created", entity_type: "entity", entity_id: a.entityId, detail: { file_id: doc.id, period_end: a.periodEnd } });
  return row;
}

export async function appendYearEndNote(db: Db, a: { entityId: string; periodEnd: string; text: string; label?: string | null; by: string | null; createIfMissing: boolean }) {
  const { token } = await getDriveToken(db);
  let doc = (await db.from("drive_documents").select("*")
    .eq("entity_id", a.entityId).eq("kind", "year_end_notes").eq("period_end", a.periodEnd).maybeSingle()).data;
  if (!doc) {
    if (!a.createIfMissing) return null;
    doc = await ensureYearEndNotes(db, { entityId: a.entityId, periodEnd: a.periodEnd, by: a.by, token });
  }
  let author = "Athena";
  if (a.by) {
    const { data: s } = await db.from("staff_profiles").select("name").eq("id", a.by).maybeSingle();
    if (s?.name) author = s.name;
  }
  const head = [stamp(), author, a.label].filter(Boolean).join(" · ");
  await appendToDoc(token, doc.file_id, `\n— ${head}\n${a.text.trim()}\n`);
  await db.from("drive_documents").update({ last_appended_at: new Date().toISOString() }).eq("id", doc.id);
  return doc;
}

export async function readYearEndNotes(db: Db, entityId: string, periodEnd: string) {
  const { data: doc } = await db.from("drive_documents").select("*")
    .eq("entity_id", entityId).eq("kind", "year_end_notes").eq("period_end", periodEnd).maybeSingle();
  const { data: map } = await db.from("client_drive_folders").select("folder_id, folder_name, status").eq("entity_id", entityId).maybeSingle();
  if (!doc) return { doc: null, text: null, mapping: map ?? null };
  const { token } = await getDriveToken(db);
  try {
    return { doc, text: await exportDocText(token, doc.file_id), mapping: map ?? null };
  } catch (e) {
    if (e instanceof DriveError && e.status === 404) return { doc, text: null, missing: true, mapping: map ?? null };
    throw e;
  }
}
