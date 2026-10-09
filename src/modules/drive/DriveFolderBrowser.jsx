import React, { useCallback, useEffect, useState } from 'react';
import { Folder, FileText, ExternalLink, FolderSearch } from 'lucide-react';
import { BTN } from '../../lib/buttonStyles';
import { callDrive } from './driveApi';
import { openDriveFile, showInExplorer, isGoogleNative } from './desktopOpen';

const font = "'Outfit', sans-serif";

function fmtSize(n) {
  if (n == null) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
function fmtDate(iso) {
  return iso ? new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '';
}

// Walks a client's Drive folder inside Athena. Starts at the client's mapped
// folder (entityId) or at folderId; `action` renders an extra button for the
// folder on screen (e.g. "Use for year ends").
export default function DriveFolderBrowser({ entityId, folderId, action, refreshKey }) {
  const [trail, setTrail] = useState([]); // [{id, name}]
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const load = useCallback(async (id) => {
    setLoading(true); setError('');
    try {
      const res = await callDrive(id ? { action: 'browse', folder_id: id } : { action: 'browse', entity_id: entityId });
      setData(res);
      return res;
    } catch (e) { setError(e.message); return null; }
    finally { setLoading(false); }
  }, [entityId]);

  useEffect(() => {
    load(folderId).then((res) => { if (res) setTrail([{ id: res.folder.id, name: res.folder.name }]); });
  }, [load, folderId, refreshKey]);

  const open = async (item) => {
    const res = await load(item.id);
    if (res) setTrail((t) => [...t, { id: res.folder.id, name: res.folder.name }]);
  };
  const back = async (i) => {
    const res = await load(trail[i].id);
    if (res) setTrail((t) => t.slice(0, i + 1));
  };

  return (
    <div style={{ fontFamily: font }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', marginBottom: 8, fontSize: 13 }}>
        {trail.map((t, i) => (
          <React.Fragment key={t.id}>
            {i > 0 && <span style={{ color: '#cbd5e1' }}>/</span>}
            {i < trail.length - 1
              ? <button onClick={() => back(i)} style={{ background: 'none', border: 'none', padding: 0, color: '#1E4560', cursor: 'pointer', fontFamily: font, fontSize: 13 }}>{t.name}</button>
              : <b style={{ color: '#0f172a' }}>{t.name}</b>}
          </React.Fragment>
        ))}
        <div style={{ flex: 1 }} />
        {data?.folder && action && action(data.folder)}
        {data?.folder?.path && (
          <button onClick={() => showInExplorer(data.folder.path)} title="Open this folder in File Explorer (Drive for desktop)"
            style={{ ...BTN.secondary.sm, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            <FolderSearch size={13} /> File Explorer
          </button>
        )}
        {data?.folder?.link && (
          <a href={data.folder.link} target="_blank" rel="noreferrer" style={{ ...BTN.secondary.sm, textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            Open in Drive <ExternalLink size={12} />
          </a>
        )}
      </div>
      {error && <div style={{ fontSize: 13, color: '#991b1b', background: '#fee2e2', borderRadius: 8, padding: '8px 10px' }}>{error}</div>}
      {loading && !data && <div style={{ fontSize: 13, color: '#94a3b8' }}>Loading…</div>}
      {data && (
        <div style={{ border: '1px solid #e5e7eb', borderRadius: 8, maxHeight: 420, overflow: 'auto', opacity: loading ? 0.6 : 1 }}>
          {data.items.length === 0 && <div style={{ padding: 12, fontSize: 13, color: '#94a3b8' }}>Empty folder</div>}
          {data.items.map((it) => (
            <div key={it.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px', borderBottom: '1px solid #f1f5f9', fontSize: 13.5 }}>
              {it.is_folder ? <Folder size={15} color="#64748b" /> : <FileText size={15} color="#94a3b8" />}
              {it.is_folder
                ? <button onClick={() => open(it)} style={{ background: 'none', border: 'none', padding: 0, color: '#0f172a', cursor: 'pointer', fontFamily: font, fontSize: 13.5, textAlign: 'left', flex: 1 }}>{it.name}</button>
                : <button onClick={() => openDriveFile(it, data.folder.path)} title={isGoogleNative(it.mime) ? 'Open in Google' : 'Open on this PC'}
                    style={{ background: 'none', border: 'none', padding: 0, color: '#0f172a', cursor: 'pointer', fontFamily: font, fontSize: 13.5, textAlign: 'left', flex: 1 }}>{it.name}</button>}
              {data.folder.path && (
                <button onClick={() => showInExplorer([...data.folder.path, it.name])} title="Show in File Explorer"
                  style={{ background: 'none', border: 'none', padding: 2, cursor: 'pointer', color: '#94a3b8', display: 'inline-flex' }}>
                  <FolderSearch size={14} />
                </button>
              )}
              <span style={{ color: '#94a3b8', fontSize: 12, width: 70, textAlign: 'right' }}>{fmtSize(it.size)}</span>
              <span style={{ color: '#94a3b8', fontSize: 12, width: 90, textAlign: 'right' }}>{fmtDate(it.modified)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
