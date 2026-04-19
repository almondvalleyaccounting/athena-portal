import { supabase } from '../../../lib/supabase';

export async function fetchStatusCounts() {
  const { count: total } = await supabase
    .from('entities')
    .select('*', { count: 'exact', head: true });

  const { count: active } = await supabase
    .from('entities')
    .select('*', { count: 'exact', head: true })
    .eq('entity_status', 'active');

  const { count: prospects } = await supabase
    .from('entities')
    .select('*', { count: 'exact', head: true })
    .eq('entity_status', 'prospect');

  const { data: latest } = await supabase
    .from('import_log')
    .select('triggered_at')
    .order('triggered_at', { ascending: false })
    .limit(1);

  return {
    total: total ?? 0,
    active: active ?? 0,
    prospects: prospects ?? 0,
    lastImport: latest?.[0]?.triggered_at || null,
  };
}

export async function fetchLatestPerSource() {
  const { data, error } = await supabase
    .from('import_log')
    .select('*')
    .in('status', ['complete', 'failed'])
    .order('triggered_at', { ascending: false });
  if (error) {
    if (error.code === '42P01') return {};
    throw error;
  }
  const bySource = {};
  for (const row of data || []) {
    if (!bySource[row.source_key]) bySource[row.source_key] = row;
  }
  return bySource;
}

export async function fetchImportHistory({ source, status, sinceDays = 30 } = {}) {
  let q = supabase
    .from('import_log')
    .select('*')
    .order('triggered_at', { ascending: false })
    .limit(200);
  if (source && source !== 'all') q = q.eq('source_key', source);
  if (status && status !== 'all') q = q.eq('status', status);
  if (sinceDays && sinceDays !== 'all') {
    const since = new Date();
    since.setDate(since.getDate() - sinceDays);
    q = q.gte('triggered_at', since.toISOString());
  }
  const { data, error } = await q;
  if (error) {
    if (error.code === '42P01') return [];
    throw error;
  }
  return data || [];
}

export async function fetchStaffNames(ids) {
  const unique = [...new Set(ids.filter(Boolean))];
  if (!unique.length) return {};
  const { data } = await supabase
    .from('staff_profiles')
    .select('id, name')
    .in('id', unique);
  const map = {};
  for (const s of data || []) map[s.id] = s.name;
  return map;
}

export async function fetchImportAccessStaff() {
  const { data, error } = await supabase
    .from('staff_profiles')
    .select('id, name, email, can_import_data, is_portal_admin')
    .order('name');
  if (error) return [];
  return (data || []).filter((s) => s.can_import_data || s.is_portal_admin);
}

// Compute SHA-256 hex of a File.
export async function computeFileHash(file) {
  const buf = await file.arrayBuffer();
  const digest = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

// Create an import_log row in the 'validating' state.
export async function createImportRun({ sourceKey, file, fileHash, sourceRowCount, triggeredBy }) {
  const { data, error } = await supabase
    .from('import_log')
    .insert({
      source_key: sourceKey,
      file_name: file.name,
      file_hash: fileHash,
      file_size: file.size,
      source_row_count: sourceRowCount,
      triggered_by: triggeredBy,
      status: 'validating',
    })
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function markValidated(runId, { rowCounts, warnings, skippedRows, conversions }) {
  const { data, error } = await supabase
    .from('import_log')
    .update({
      status: 'ready',
      validated_at: new Date().toISOString(),
      row_counts: rowCounts || {},
      warnings: warnings || [],
      skipped_rows: skippedRows || [],
      conversions: conversions || [],
    })
    .eq('id', runId)
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function approveAndStart(runId, approvedBy) {
  const { data, error } = await supabase
    .from('import_log')
    .update({
      approved_by: approvedBy,
      approved_at: new Date().toISOString(),
      status: 'running',
    })
    .eq('id', runId)
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function markComplete(runId, { rowCounts, errors } = {}) {
  const patch = {
    status: 'complete',
    completed_at: new Date().toISOString(),
  };
  if (rowCounts) patch.row_counts = rowCounts;
  if (errors) patch.errors = errors;
  const { data, error } = await supabase
    .from('import_log')
    .update(patch)
    .eq('id', runId)
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function markFailed(runId, errs) {
  const { data, error } = await supabase
    .from('import_log')
    .update({
      status: 'failed',
      completed_at: new Date().toISOString(),
      errors: errs || [],
    })
    .eq('id', runId)
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function markCancelled(runId) {
  const { data, error } = await supabase
    .from('import_log')
    .update({ status: 'cancelled' })
    .eq('id', runId)
    .select()
    .single();
  if (error) throw error;
  return data;
}

// Concurrent-import guard (migration 021 Q3).
export async function findRunningRun(sourceKey) {
  const { data } = await supabase
    .from('import_log')
    .select('id, triggered_by, triggered_at')
    .eq('source_key', sourceKey)
    .eq('status', 'running')
    .limit(1);
  return data?.[0] || null;
}
