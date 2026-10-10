// The "+ Create" modal's wiring, kept out of React so any page can use it.
//
// openCreate(context?) opens the modal (AppShell mounts one CreateModal that
// listens). A page with something open that Create can be "about" — the
// email screen's open email — registers it with setCreateContext, so the top
// bar's Create picks it up as well as the page's own Create button.
//
// context (all optional): { kind: 'email', subject, fromName, fromEmail, date,
//   mailbox, threadId, messageId, snippet, emails: [other party addresses] }
// or, from Text Messages / WhatsApp (sql/369): { kind: 'sms', channel, number,
//   fromName, body, date, client: { id, name } | null, candidates: [{ id, name }],
//   onCreated() } — onCreated clears the conversation once the action exists.

let current = null;

export function setCreateContext(ctx) { current = ctx || null; }
export function getCreateContext() { return current; }

export function openCreate(ctx) {
  window.dispatchEvent(new CustomEvent('athena:create', { detail: ctx === undefined ? current : ctx }));
}

// The line a task/bill carries back to the email it came from.
export function emailReference(ctx) {
  if (ctx?.kind === 'sms') return smsReference(ctx);
  if (!ctx || ctx.kind !== 'email') return '';
  const when = ctx.date ? new Date(ctx.date).toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
  const link = ctx.mailbox && ctx.threadId
    ? `https://mail.google.com/mail/?authuser=${encodeURIComponent(ctx.mailbox)}#all/${ctx.threadId}`
    : '';
  return [`From email: “${ctx.subject || '(no subject)'}” — ${ctx.fromName || ctx.fromEmail || ''}${when ? `, ${when}` : ''}`, link]
    .filter(Boolean).join('\n');
}

// The same for a text / WhatsApp: the message itself, and a link back to the
// conversation in Communications.
function smsReference(ctx) {
  const kind = ctx.channel === 'whatsapp' ? 'WhatsApp' : 'text';
  const when = ctx.date ? new Date(ctx.date).toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
  const body = String(ctx.body || '').slice(0, 500);
  const link = `${window.location.origin}/comms/${ctx.channel === 'whatsapp' ? 'whatsapp' : 'sms'}?number=${encodeURIComponent(ctx.number || '')}`;
  return [`From ${kind}: “${body}” — ${ctx.fromName || ctx.number}${when ? `, ${when}` : ''}`, link].join('\n');
}
