// The "+ Create" modal's wiring, kept out of React so any page can use it.
//
// openCreate(context?) opens the modal (AppShell mounts one CreateModal that
// listens). A page with something open that Create can be "about" — the
// email screen's open email — registers it with setCreateContext, so the top
// bar's Create picks it up as well as the page's own Create button.
//
// context (all optional): { kind: 'email', subject, fromName, fromEmail, date,
//   mailbox, threadId, messageId, snippet, emails: [other party addresses] }

let current = null;

export function setCreateContext(ctx) { current = ctx || null; }
export function getCreateContext() { return current; }

export function openCreate(ctx) {
  window.dispatchEvent(new CustomEvent('athena:create', { detail: ctx === undefined ? current : ctx }));
}

// The line a task/bill carries back to the email it came from.
export function emailReference(ctx) {
  if (!ctx || ctx.kind !== 'email') return '';
  const when = ctx.date ? new Date(ctx.date).toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
  const link = ctx.mailbox && ctx.threadId
    ? `https://mail.google.com/mail/?authuser=${encodeURIComponent(ctx.mailbox)}#all/${ctx.threadId}`
    : '';
  return [`From email: “${ctx.subject || '(no subject)'}” — ${ctx.fromName || ctx.fromEmail || ''}${when ? `, ${when}` : ''}`, link]
    .filter(Boolean).join('\n');
}
