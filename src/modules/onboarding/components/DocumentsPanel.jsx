import React, { useEffect, useState } from 'react';
import { FileText, HardDriveUpload, ExternalLink, FolderOpen } from 'lucide-react';
import { tones, chipStyle } from '../../../lib/tokens';
import { useAuth } from '../../../shell/AppShell';
import { getDriveConnection, driveConnectUrl, saveDocumentsToDrive, getDocumentUrl } from '../api';

const font = "'Outfit', sans-serif";

/*
  Documents uploaded against this onboarding (usually by the client via
  the portal). One click pushes everything still in Athena storage to
  Google Drive: "Athena Client Documents/<Client Name>".
*/
export default function DocumentsPanel({ onboarding, documents, onChanged }) {
  const { profile } = useAuth();
  const [drive, setDrive] = useState(undefined); // undefined = loading, null = not connected
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const [folderLink, setFolderLink] = useState(null);

  useEffect(() => {
    getDriveConnection().then(setDrive).catch(() => setDrive(null));
  }, []);

  const pending = documents.filter((d) => d.status === 'received');

  async function open(doc) {
    try {
      const url = await getDocumentUrl(doc.storage_path);
      window.open(url, '_blank', 'noopener');
    } catch (e) { setMsg({ tone: 'danger', text: e.message }); }
  }

  async function saveToDrive() {
    setBusy(true); setMsg(null);
    try {
      const r = await saveDocumentsToDrive(onboarding.id);
      setFolderLink(r.folder_link || null);
      const failed = (r.results || []).filter((x) => !x.ok);
      setMsg(failed.length
        ? { tone: 'warning', text: `Saved ${r.saved}/${r.total}; failed: ${failed.map((f) => f.name).join(', ')}` }
        : { tone: 'success', text: `Saved ${r.saved} document${r.saved === 1 ? '' : 's'} to Drive.` });
      onChanged?.();
    } catch (e) { setMsg({ tone: 'danger', text: e.message }); }
    setBusy(false);
  }

  if (documents.length === 0 && drive) return null; // nothing to show, Drive already connected

  return (
    <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, padding: '16px 18px', fontFamily: font }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
        <FileText size={14} color="#64748b" />
        <span style={{ fontSize: 12, fontWeight: 700, color: '#475569', textTransform: 'uppercase', letterSpacing: 0.5 }}>
          Documents{documents.length ? ` (${documents.length})` : ''}
        </span>
        {folderLink && (
          <a href={folderLink} target="_blank" rel="noreferrer" style={{ marginLeft: 'auto', fontSize: 12, color: '#0e7fe0', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            <FolderOpen size={12} /> Drive folder
          </a>
        )}
      </div>

      {documents.length === 0 && (
        <div style={{ fontSize: 12, color: '#94a3b8', marginBottom: 10 }}>
          Nothing uploaded yet — client uploads from the portal land here.
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: documents.length ? 12 : 0 }}>
        {documents.map((d) => (
          <div key={d.id} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, color: '#334155' }}>
            <button
              onClick={() => open(d)}
              title="Open (signed link, 1h)"
              style={{ flex: 1, textAlign: 'left', background: 'none', border: 'none', color: '#0e7fe0', cursor: 'pointer', padding: 0, fontFamily: font, fontSize: 12.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
            >
              {d.original_name}
            </button>
            <span style={{ color: '#94a3b8', whiteSpace: 'nowrap' }}>{new Date(d.created_at).toLocaleDateString('en-GB')}</span>
            {d.status === 'saved_to_drive'
              ? (d.drive_web_link
                ? <a href={d.drive_web_link} target="_blank" rel="noreferrer" style={{ ...chipStyle('success'), display: 'inline-flex', alignItems: 'center', gap: 3, textDecoration: 'none' }}>in Drive <ExternalLink size={9} /></a>
                : <span style={chipStyle('success')}>in Drive</span>)
              : <span style={chipStyle('info')}>in Athena</span>}
          </div>
        ))}
      </div>

      {msg && <div style={{ fontSize: 12, color: tones[msg.tone].fg, marginBottom: 8 }}>{msg.text}</div>}

      {drive === null && (
        <a
          href={driveConnectUrl(profile?.id, `/onboarding/${onboarding.id}`)}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5, fontWeight: 600, fontFamily: font, background: tones.info.bg, color: tones.info.fg, border: `1px solid ${tones.info.border}`, borderRadius: 8, padding: '7px 14px', textDecoration: 'none' }}
        >
          <HardDriveUpload size={13} /> Connect Google Drive
        </a>
      )}
      {drive && pending.length > 0 && (
        <button
          onClick={saveToDrive} disabled={busy}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5, fontWeight: 700, fontFamily: font, background: '#F5C518', color: '#1E4560', border: 'none', borderRadius: 8, padding: '8px 16px', cursor: 'pointer', opacity: busy ? 0.7 : 1 }}
        >
          <HardDriveUpload size={13} /> {busy ? 'Saving…' : `Save ${pending.length} to Drive`}
        </button>
      )}
      {drive && <div style={{ fontSize: 11, color: '#cbd5e1', marginTop: 8 }}>Drive connected as {drive.account_email}</div>}
    </div>
  );
}
