import { supabase } from '../../lib/supabase';

// Google Drive (sql/362). Reads of the map are direct (staff-only RLS); every
// Drive call and every write goes through the `drive` edge function.

/** Call the drive function. Resolves to the JSON body; throws with the server's message. */
export async function callDrive(payload) {
  const { data, error } = await supabase.functions.invoke('drive', { body: payload });
  if (error || !data?.success) {
    let msg = data?.error || 'Google Drive request failed';
    try { const j = await error?.context?.json?.(); if (j?.error) msg = j.error; } catch { /* body already read */ }
    throw new Error(msg);
  }
  return data;
}

export async function fetchClientFolder(entityId) {
  const { data, error } = await supabase.from('client_drive_folders').select('*').eq('entity_id', entityId).maybeSingle();
  if (error) throw error;
  return data;
}

/** Folders from the last scan whose name contains the text. */
export async function searchFolderIndex(text) {
  let q = supabase.from('drive_folder_index').select('folder_id, name, category, web_link').order('name').limit(40);
  if (text) q = q.ilike('name', `%${text.replace(/[%_]/g, '')}%`);
  const { data, error } = await q;
  if (error) throw error;
  return data || [];
}

/** A File → base64 (no data: prefix) for the upload action. */
export function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] || '');
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

export const folderLink = (id) => `https://drive.google.com/drive/folders/${id}`;
