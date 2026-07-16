// CH-code email rendering — turns an editable template (subject + inner
// body_html with {{first_name}}/{{person}}/{{entity}} placeholders) into a
// send-ready { subject, html, text } at queue time. Storing the rendered
// output on the queue row means "what Sophie previews is exactly what goes
// out"; later edits to a template only affect newly-queued emails.
//
// Deliberately plain/typed-looking (Arial, left-aligned, no branded card) so
// it reads like a personal note rather than a system template. An editable
// signature (ch_code_chase_config.email_signature_html — Sophie by default) is
// appended at the bottom.

function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function firstNameOf(name) {
  const n = String(name ?? '').trim();
  if (!n) return 'there';
  return n.split(/\s+/)[0];
}

function fillVars(str, vars) {
  return String(str ?? '')
    .replace(/\{\{\s*first_name\s*\}\}/g, esc(vars.first_name))
    .replace(/\{\{\s*person\s*\}\}/g, esc(vars.person))
    .replace(/\{\{\s*entity\s*\}\}/g, esc(vars.entity));
}

// Minimal wrapper — no card/border/logo. Looks like a normal typed email.
export function wrapShell(innerHtml, { signatureHtml } = {}) {
  return `<!doctype html><html><body style="margin:0;padding:0;background:#ffffff;">
    <div style="max-width:640px;margin:0;padding:14px 6px;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;color:#222222;">
      ${innerHtml}
      ${signatureHtml || ''}
    </div>
  </body></html>`;
}

// Rough HTML → plaintext for the text/plain alternative.
export function htmlToText(html) {
  return String(html ?? '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<li[^>]*>/gi, '\n • ')
    .replace(/<br\s*\/?>(?=)/gi, '\n')
    .replace(/<\/(p|div|tr|h[1-6]|ul|ol)>/gi, '\n')
    // Keep link targets in plaintext: <a href="url">text</a> → "text (url)".
    .replace(/<a\b[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, '$2 ($1)')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// template: { subject, body_html }, vars: { person, entity },
// opts: { signatureHtml }
export function renderTemplate(template, vars, opts = {}) {
  const v = { ...vars, first_name: firstNameOf(vars.person) };
  const subject = fillVars(template.subject, v);
  const body = fillVars(template.body_html, v);
  const sig = opts.signatureHtml || '';
  const html = wrapShell(body, { signatureHtml: sig });
  const text = htmlToText(sig ? `${body}\n${sig}` : body);
  return { subject, html, text };
}
