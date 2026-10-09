// Opening Drive files on the PC (athena-open, public/tools/athena-open-install.ps1).
//
// Google Docs/Sheets/Slides open in the browser. Everything else goes to the
// PC's copy through Google Drive for desktop (G:\Shared drives\AV.Shared\…), so
// Excel opens in desktop Excel, PDFs in Adobe, and saving writes back to Drive.
// `path` is the list of folder names from the top of AV.Shared, as the drive
// edge function returns it (folder.path / action 'path').

export const INSTALL_COMMAND = 'irm https://portal.almondvalleyaccounting.co.uk/tools/athena-open-install.ps1 | iex';

export function isGoogleNative(mime) {
  return typeof mime === 'string' && mime.startsWith('application/vnd.google-apps.');
}

// Chrome ignores a link type nothing on the PC handles, silently. A handled
// one takes focus away (Chrome's "Open …?" prompt, then the app), so if the
// page still has focus a couple of seconds later, say what to install.
function launch(url) {
  let left = false;
  const onBlur = () => { left = true; };
  window.addEventListener('blur', onBlur, { once: true });
  window.location.href = url;
  setTimeout(() => {
    window.removeEventListener('blur', onBlur);
    if (!left && document.hasFocus()) notice();
  }, 2500);
}

function notice() {
  const id = 'athena-open-notice';
  if (document.getElementById(id)) return;
  const el = document.createElement('div');
  el.id = id;
  el.style.cssText = 'position:fixed;bottom:20px;right:20px;z-index:2000;max-width:360px;background:#0f172a;color:#fff;'
    + 'font:13px Outfit,sans-serif;line-height:1.45;padding:12px 14px;border-radius:10px;box-shadow:0 10px 30px rgba(0,0,0,.25)';
  el.innerHTML = 'Nothing opened? This PC needs the Athena desktop opener. '
    + '<a href="/settings/me" style="color:#93c5fd">Set it up in My settings</a>.';
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 9000);
}

function athenaUrl(action, segments) {
  return `athena-open://${action}?${segments.map((s) => `p=${encodeURIComponent(s)}`).join('&')}`;
}

/** Open a file: Google files in the browser, the rest in their desktop app. */
export function openDriveFile(item, folderPath) {
  if (isGoogleNative(item.mime) || !Array.isArray(folderPath)) {
    window.open(item.link, '_blank', 'noopener');
    return;
  }
  launch(athenaUrl('open', [...folderPath, item.name]));
}

/** Open File Explorer at a folder, or at a file's folder with the file selected. */
export function showInExplorer(segments) {
  if (!Array.isArray(segments) || segments.length === 0) return;
  launch(athenaUrl('show', segments));
}
