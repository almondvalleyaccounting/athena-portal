// Opens the email template library (TemplateLibraryModal, mounted once in
// AppShell) from anywhere: openTemplates({ entityId, to, group }) — all optional.
export function openTemplates(ctx = {}) {
  window.dispatchEvent(new CustomEvent('athena:templates', { detail: ctx }));
}
