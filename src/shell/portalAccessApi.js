import { supabase } from '../lib/supabase';

/*
  Data helpers for the Portal Clients admin screen (/admin/portal-clients).

  Lives here (not in src/modules/onboarding/api.js) because that file
  belongs to another workstream. The list/revoke calls go through
  SECURITY DEFINER RPCs from sql/123_settings_area.sql:
    • list_portal_clients()            — invites + claimed users + last sign-in
    • revoke_portal_access(invite_id)  — deletes invite AND entity_memberships
  Both are gated on can_manage_portal server-side.
*/

export async function listPortalClients() {
  const { data, error } = await supabase.rpc('list_portal_clients');
  if (!error) return data || [];

  // Fallback if sql/123 hasn't been applied yet: staff can read invites
  // and entities directly (client_portal_invites_staff policy). No
  // last-sign-in or membership info in this path.
  if (error.code === '42883' || /list_portal_clients/i.test(error.message || '')) {
    const { data: invites, error: invErr } = await supabase
      .from('client_portal_invites')
      .select('id, email, entity_id, created_at, claimed_at, claimed_user_id, entities(name)')
      .order('created_at');
    if (invErr) throw invErr;
    return (invites || []).map((i) => ({
      invite_id: i.id,
      email: i.email,
      entity_id: i.entity_id,
      entity_name: i.entities?.name || '(unknown client)',
      invited_at: i.created_at,
      claimed_at: i.claimed_at,
      claimed_user_id: i.claimed_user_id,
      last_sign_in_at: null,
      has_membership: null, // unknown without the RPC
    }));
  }
  throw error;
}

export async function revokePortalAccess(inviteId) {
  const { data, error } = await supabase.rpc('revoke_portal_access', {
    p_invite_id: inviteId,
  });
  if (error) {
    if (error.code === '42883' || /revoke_portal_access/i.test(error.message || '')) {
      throw new Error(
        'The revoke_portal_access function is missing — apply sql/123_settings_area.sql first. ' +
        'Deleting only the invite would leave the client\'s data access (entity_memberships) in place.'
      );
    }
    throw error;
  }
  return data;
}

// Re-issue an invite after a revoke (or for an email that never claimed).
// Staff can insert into client_portal_invites directly (RLS: is_active_staff).
// The client claims it automatically the next time they sign in.
export async function reinvitePortalUser(entityId, email, actorId) {
  const { error } = await supabase.from('client_portal_invites').insert({
    entity_id: entityId,
    email: (email || '').trim().toLowerCase(),
    invited_by: actorId || null,
  });
  if (error) throw error;
}

// Portal-client identifiers used by AdminPage to filter client sign-ins
// out of the "Accounts without profiles" warning. Staff can read both
// tables directly (users_staff_read + client_portal_invites_staff).
export async function fetchPortalClientIdentifiers() {
  const ids = new Set();
  const emails = new Set();
  try {
    const [{ data: portalUsers }, { data: invites }] = await Promise.all([
      supabase.from('users').select('id'),
      supabase.from('client_portal_invites').select('email, claimed_user_id'),
    ]);
    (portalUsers || []).forEach((u) => ids.add(u.id));
    (invites || []).forEach((i) => {
      if (i.email) emails.add(i.email.toLowerCase());
      if (i.claimed_user_id) ids.add(i.claimed_user_id);
    });
  } catch {
    // Best-effort — if the tables aren't readable the filter just no-ops.
  }
  return { ids, emails };
}
