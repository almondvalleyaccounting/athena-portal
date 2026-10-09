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

function athenaUrl(action, segments) {
  return `athena-open://${action}?${segments.map((s) => `p=${encodeURIComponent(s)}`).join('&')}`;
}

/** Open a file: Google files in the browser, the rest in their desktop app. */
export function openDriveFile(item, folderPath) {
  if (isGoogleNative(item.mime) || !Array.isArray(folderPath)) {
    window.open(item.link, '_blank', 'noopener');
    return;
  }
  window.location.href = athenaUrl('open', [...folderPath, item.name]);
}

/** Open File Explorer at a folder, or at a file's folder with the file selected. */
export function showInExplorer(segments) {
  if (!Array.isArray(segments) || segments.length === 0) return;
  window.location.href = athenaUrl('show', segments);
}
