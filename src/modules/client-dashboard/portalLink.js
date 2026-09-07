import { supabase } from '../../lib/supabase';

/*
  Telling a client they have access — shared by the two screens that grant it.

  There are two of those on purpose. /admin/dashboard-access answers "who can
  see anything?" across the practice, which is the auditing question; the Client
  access tab answers it for the client already on screen, which is the question
  you have when you are on the phone to them. Both grant, both revoke, both
  preview — so both have to be able to tell somebody, or the one you happen to
  be standing on is the wrong one.

  The email itself is portal-send-link (an edge function: it needs the Resend
  key, and a new mutating path is an edge function). It carries no token, so it
  authenticates nobody and is harmless if it goes astray.
*/

/** shortDate-alike used by both callers, kept here so the status text matches. */
const dayMonth = (d) =>
  (d ? new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '—');

/**
 * A non-2xx from an edge function arrives as FunctionsHttpError with the body
 * unread on error.context — the readable reason is in there, not in .message.
 */
export async function fnError(error) {
  try {
    const body = await error?.context?.json?.();
    if (body?.error) return String(body.error);
  } catch { /* not JSON, or the body was already consumed */ }
  return String(error?.message || 'The request failed');
}

/*
  What the line under someone's email should say.

  "invited — not signed in yet" was the whole story before, and it quietly
  blamed the client for a silence that was ours: granting access sends nothing,
  so a person could hold a full dashboard grant for a month having never been
  told the portal existed. Not signed in because they are ignoring us and not
  signed in because nobody has told them are different problems with different
  fixes, so they read differently — and only one of them is amber.
*/
export function personStatus(r) {
  if (r.has_portal_login) return { text: 'has signed in', tone: '#94a3b8' };
  if (r.link_sent_at) {
    const times = r.link_sent_count > 1 ? ` · sent ${r.link_sent_count}×` : '';
    return {
      text: `sent their sign-in details ${dayMonth(r.link_sent_at)}${times} — not signed in yet`,
      tone: '#64748b',
    };
  }
  if (r.has_invite) return { text: 'nobody has told them yet', tone: '#b45309' };
  return { text: 'no invite', tone: '#b45309' };
}

/** The label the send button should carry for this row. */
export const sendLinkLabel = (r) => (r.link_sent_at ? 'Send again' : 'Send link');

/** Whether this row's send button should be the nudged style (outstanding work). */
export const sendLinkIsPending = (r) => !r.link_sent_at && !r.has_portal_login;

export function sendLinkTitle(r) {
  return r.has_portal_login
    ? `${r.email} has signed in already — send the details again if they have lost them`
    : `Email ${r.email} the portal address and how to sign in`;
}

/** The confirm step. Returns false if the user backs out. */
export function confirmSendLink(r) {
  return window.confirm(
    `Email ${r.email} their sign-in details for ${r.entity_name}?\n\n`
    + 'They get the portal address and the email address to use — no code and no link '
    + 'that signs anyone in, so it is harmless if it goes astray. info@ is blind-copied '
    + 'so there is a record of it.'
    + (r.link_sent_at ? `\n\nLast sent ${dayMonth(r.link_sent_at)}.` : ''),
  );
}

/**
 * Send it. Resolves to the message the caller should show, or throws with a
 * readable reason. The second element says whether that message is a warning —
 * the email went but the record of it did not, which is worth saying rather
 * than reporting a failure that would have somebody send it twice.
 */
export async function sendPortalLink(row) {
  const { data, error } = await supabase.functions.invoke('portal-send-link', {
    body: { entity_id: row.entity_id, email: row.email },
  });
  if (error) throw new Error(await fnError(error));
  if (data?.success === false) throw new Error(data.error || 'The send failed');
  return {
    text: data?.warning || `Sign-in details sent to ${row.email}.`,
    warning: !!data?.warning,
  };
}
