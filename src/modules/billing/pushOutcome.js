// What a QBO recurring push actually did, in words.
//
// qbo-push-recurring returns a per-row `results` array alongside its
// summary counts, and both screens that call it used to show only the
// counts. "Pushed: 0, Skipped: 1" says a fee raise did not happen and
// nothing about why — the reason was in the response all along, thrown
// away unread, leaving the row approved for ever with nothing to act on.

// Rows the push declined outright, each with its reason.
export function explainRows(rows, fallback) {
  if (!rows || rows.length === 0) return '';
  return '\n\n' + rows
    .map((r) => `• ${r.entity || 'Unknown'} — ${r.reason || r.error || fallback || 'no reason given'}`)
    .join('\n');
}

// Rows that got into QBO but left part of themselves behind: a push can
// reprice one line and refuse to add another, which is a success and a
// piece of unfinished work at the same time. Only the second half needs
// saying.
export function explainBlocked(rows) {
  const lines = [];
  for (const r of rows || []) {
    for (const b of r.blocked || []) lines.push(`• ${r.entity || 'Unknown'} — ${b}`);
  }
  return lines.length ? '\n\nLeft pending:\n' + lines.join('\n') : '';
}
