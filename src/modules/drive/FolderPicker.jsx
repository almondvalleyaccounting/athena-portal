import React, { useEffect, useState } from 'react';
import { BTN } from '../../lib/buttonStyles';
import { searchFolderIndex } from './driveApi';

const font = "'Outfit', sans-serif";
const input = { border: '1px solid #d1d5db', borderRadius: 6, padding: '5px 8px', fontSize: 13, fontFamily: font };

// Pick a client folder from the last Drive scan (drive_folder_index), or paste
// a Drive folder link for one the scan did not reach.
export default function FolderPicker({ initial = '', onPick, onCancel, busy }) {
  const [text, setText] = useState(initial);
  const [rows, setRows] = useState([]);
  const [link, setLink] = useState('');

  useEffect(() => {
    let live = true;
    const t = setTimeout(() => { searchFolderIndex(text).then((r) => { if (live) setRows(r); }).catch(() => {}); }, 200);
    return () => { live = false; clearTimeout(t); };
  }, [text]);

  const fromLink = () => {
    const m = link.match(/folders\/([A-Za-z0-9_-]{10,})/) || link.match(/^([A-Za-z0-9_-]{10,})$/);
    if (m) onPick(m[1]);
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, fontFamily: font }}>
      <div style={{ display: 'flex', gap: 6 }}>
        <input autoFocus value={text} onChange={(e) => setText(e.target.value)} placeholder="Search client folders…" style={{ ...input, flex: 1 }} />
        {onCancel && <button onClick={onCancel} style={BTN.secondary.sm}>Cancel</button>}
      </div>
      <div style={{ border: '1px solid #e5e7eb', borderRadius: 8, maxHeight: 260, overflow: 'auto' }}>
        {rows.length === 0 && <div style={{ padding: 10, fontSize: 13, color: '#94a3b8' }}>No folders match. Run a scan from Settings → Drive folders, or paste a link below.</div>}
        {rows.map((r) => (
          <div key={r.folder_id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 10px', borderBottom: '1px solid #f1f5f9', fontSize: 13.5 }}>
            <span style={{ flex: 1 }}>{r.name}</span>
            <span style={{ fontSize: 11.5, color: '#94a3b8' }}>{r.category}</span>
            <button disabled={busy} onClick={() => onPick(r.folder_id)} style={BTN.primary.sm}>Use</button>
          </div>
        ))}
      </div>
      <div style={{ display: 'flex', gap: 6 }}>
        <input value={link} onChange={(e) => setLink(e.target.value)} placeholder="…or paste a Drive folder link" style={{ ...input, flex: 1 }} />
        <button disabled={busy || !link} onClick={fromLink} style={BTN.secondary.sm}>Use link</button>
      </div>
    </div>
  );
}
