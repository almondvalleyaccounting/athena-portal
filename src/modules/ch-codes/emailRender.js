// CH-code email rendering — turns an editable template (subject + inner
// body_html with {{person}}/{{entity}} placeholders) into a send-ready
// { subject, html, text } at queue time. Storing the rendered output on the
// queue row means "what Sophie previews is exactly what goes out"; later
// edits to a template only affect newly-queued emails.
//
// The branded shell here mirrors ch-code-chase/index.ts so queued emails look
// identical to the automated chasers.

function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function fillVars(str, vars) {
  return String(str ?? '')
    .replace(/\{\{\s*person\s*\}\}/g, esc(vars.person))
    .replace(/\{\{\s*entity\s*\}\}/g, esc(vars.entity));
}

export function wrapShell(innerHtml, entityName) {
  return `<!doctype html><html><body style="margin:0;padding:0;background:#fafafa;font-family:'Outfit',-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;color:#1e293b;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#fafafa;padding:32px 16px;"><tr><td align="center">
      <table role="presentation" width="580" cellpadding="0" cellspacing="0" style="background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:28px;">
        <tr><td>${innerHtml}</td></tr>
        <tr><td style="padding-top:24px;border-top:1px solid #f1f5f9;font-size:11px;color:#94a3b8;text-align:center;">Almond Valley Accounting${entityName ? ` · ${esc(entityName)}` : ''}</td></tr>
      </table>
    </td></tr></table>
  </body></html>`;
}

// Rough HTML → plaintext for the text/plain alternative.
export function htmlToText(html) {
  return String(html ?? '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<li[^>]*>/gi, '\n • ')
    .replace(/<br\s*\/?>(?=)/gi, '\n')
    .replace(/<\/(p|div|tr|h[1-6]|ul|ol)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// template: { subject, body_html }, vars: { person, entity }
export function renderTemplate(template, vars) {
  const subject = fillVars(template.subject, vars);
  const body = fillVars(template.body_html, vars);
  const html = wrapShell(body, vars.entity);
  const text = htmlToText(body);
  return { subject, html, text };
}
