import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ExternalLink, RefreshCw, FolderSearch } from 'lucide-react';
import { BTN } from '../../../lib/buttonStyles';
import { callDrive, fileToBase64, folderLink } from '../../drive/driveApi';
import { showInExplorer } from '../../drive/desktopOpen';

const font = "'Outfit', sans-serif";
const card = { background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, padding: '12px 14px' };
const linkBtn = { ...BTN.secondary.sm, textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: 4 };

// The year end's Drive folder and notes Doc (sql/362). The Doc is the one
// copy of the notes: a note added here is appended to it, comments on this
// job's stages are appended too, and anything typed straight into the Doc
// shows here on the next refresh.
export default function YearEndDrivePanel({ entityId, periodEnd, planId }) {
  const [state, setState] = useState(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');
  const fileRef = useRef(null);

  const load = useCallback(async () => {
    setError('');
    try { setState(await callDrive({ action: 'notes_get', entity_id: entityId, period_end: periodEnd })); }
    catch (e) { setError(e.message); setState({}); }
  }, [entityId, periodEnd]);
  useEffect(() => { load(); }, [load]);

  const run = async (payload, ok) => {
    setBusy(true); setError(''); setInfo('');
    try { const r = await callDrive(payload); await load(); if (ok) setInfo(typeof ok === 'function' ? ok(r) : ok); return r; }
    catch (e) { setError(e.message); return null; }
    finally { setBusy(false); }
  };

  const addNote = async () => {
    if (!note.trim()) return;
    const r = await run({ action: 'notes_append', entity_id: entityId, period_end: periodEnd, text: note }, 'Added to the notes in Drive.');
    if (r) setNote('');
  };
  const upload = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (file.size > 10 * 1024 * 1024) { setError('Files over 10 MB go into Drive directly.'); return; }
    const base64 = await fileToBase64(file);
    await run({ action: 'upload', entity_id: entityId, period_end: periodEnd, name: file.name, mime: file.type, base64 }, (r) => `Saved ${r.file.name} to the year-end folder.`);
  };

  if (!state) return <div style={{ ...card, fontFamily: font, fontSize: 13, color: '#94a3b8' }}>Loading the Drive folder…</div>;

  const { doc, text, mapping, missing } = state;
  return (
    <div style={{ ...card, fontFamily: font, display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 200 }}>
          <div style={{ fontSize: 14, fontWeight: 600, color: '#0f172a' }}>Year-end notes</div>
          <div style={{ fontSize: 12, color: '#94a3b8' }}>Kept as a Google Doc in the client's year-end folder. Comments on this job's stages are added to it too.</div>
        </div>
        {doc && <>
          <a href={doc.web_link} target="_blank" rel="noreferrer" style={linkBtn}>Open the Doc <ExternalLink size={12} /></a>
          <a href={folderLink(doc.folder_id)} target="_blank" rel="noreferrer" style={linkBtn}>Year-end folder <ExternalLink size={12} /></a>
          <button disabled={busy} title="Open the year-end folder in File Explorer (Drive for desktop)"
            onClick={async () => { try { const r = await callDrive({ action: 'path', folder_id: doc.folder_id }); showInExplorer(r.path); } catch (e) { setError(e.message); } }}
            style={{ ...BTN.secondary.sm, display: 'inline-flex', alignItems: 'center', gap: 4 }}><FolderSearch size={12} /> File Explorer</button>
          <button onClick={load} disabled={busy} title="Fetch the Doc as it stands in Drive" style={{ ...BTN.secondary.sm, display: 'inline-flex', alignItems: 'center', gap: 4 }}><RefreshCw size={12} /> Refresh</button>
        </>}
      </div>

      {error && <div style={{ fontSize: 13, color: '#991b1b', background: '#fee2e2', borderRadius: 8, padding: '8px 10px' }}>{error}</div>}
      {info && <div style={{ fontSize: 13, color: '#166534', background: '#dcfce7', borderRadius: 8, padding: '8px 10px' }}>{info}</div>}

      {!mapping && !error && (
        <div style={{ fontSize: 13, color: '#64748b' }}>
          This client has no Drive folder yet. <Link to={`/clients/${entityId}`} style={{ color: '#1E4560' }}>Set it on the client's Drive tab</Link>.
        </div>
      )}
      {mapping?.status === 'suggested' && !doc && (
        <div style={{ fontSize: 13, color: '#92400e' }}>
          Athena thinks this client's folder is “{mapping.folder_name}”. <Link to={`/clients/${entityId}`} style={{ color: '#1E4560' }}>Confirm it on the client's Drive tab</Link> before notes are saved there.
        </div>
      )}
      {mapping?.status === 'confirmed' && !doc && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <button disabled={busy} onClick={() => run({ action: 'notes_create', entity_id: entityId, period_end: periodEnd, job_plan_id: planId || null }, 'Notes started in Drive.')} style={BTN.primary.sm}>
            {busy ? 'Working…' : 'Start notes in Drive'}
          </button>
          <span style={{ fontSize: 12.5, color: '#64748b' }}>Makes the year-end folder if it isn't there, and a notes Doc inside it.</span>
        </div>
      )}

      {doc && (
        <>
          {missing
            ? <div style={{ fontSize: 13, color: '#92400e' }}>The notes Doc can't be found in Drive — it may have been moved out of AV.Shared or deleted.</div>
            : <pre style={{ margin: 0, maxHeight: 360, overflow: 'auto', whiteSpace: 'pre-wrap', fontFamily: font, fontSize: 13, lineHeight: 1.5, color: '#0f172a', background: '#f8fafc', border: '1px solid #e5e7eb', borderRadius: 8, padding: '10px 12px' }}>{text}</pre>}
          <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={3} placeholder="Add a note — it's appended to the Doc with your name and the time"
            style={{ border: '1px solid #d1d5db', borderRadius: 6, padding: '6px 8px', fontSize: 13, fontFamily: font, resize: 'vertical' }} />
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <button disabled={busy || !note.trim()} onClick={addNote} style={BTN.primary.sm}>{busy ? 'Saving…' : 'Add note'}</button>
            <button disabled={busy} onClick={() => fileRef.current?.click()} style={BTN.secondary.sm}>Save a file to the year-end folder…</button>
            <input ref={fileRef} type="file" onChange={upload} style={{ display: 'none' }} />
          </div>
        </>
      )}
    </div>
  );
}
