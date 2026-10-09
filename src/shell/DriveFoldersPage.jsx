import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from './AppShell';
import { supabase } from '../lib/supabase';
import { BTN } from '../lib/buttonStyles';
import { callDrive, folderLink } from '../modules/drive/driveApi';
import FolderExplorerModal from '../modules/drive/FolderExplorerModal';
import { startDriveConnect } from '../modules/onboarding/api';

const font = "'Outfit', sans-serif";
const card = { background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, padding: '18px 22px' };
const th = { textAlign: 'left', fontSize: 11.5, fontWeight: 600, color: '#64748b', padding: '8px 10px', borderBottom: '1px solid #e5e7eb', background: '#f8fafc', position: 'sticky', top: 0 };
const td = { fontSize: 13.5, padding: '7px 10px', borderBottom: '1px solid #f1f5f9', verticalAlign: 'middle' };
const METHOD = { name: 'name', company_number: 'company no.', manual: 'by hand' };
const FILTERS = [
  { id: 'suggested', label: 'Suggested' },
  { id: 'none', label: 'No folder' },
  { id: 'confirmed', label: 'Confirmed' },
  { id: 'all', label: 'All' },
];

async function fetchAll(table, select, build = (q) => q) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await build(supabase.from(table).select(select)).range(from, from + 999);
    if (error) throw error;
    out.push(...(data || []));
    if (!data || data.length < 1000) return out;
  }
}

/*
  Drive folders — /admin/drive (can_manage_portal). sql/362.
  The Drive connection, the scan of AV.Shared's client folders, and the
  client ↔ folder map: a scan suggests, a person confirms.
*/
export default function DriveFoldersPage() {
  const { profile } = useAuth();
  const [status, setStatus] = useState(null);
  const [clients, setClients] = useState([]);
  const [maps, setMaps] = useState({});
  const [filter, setFilter] = useState('suggested');
  const [search, setSearch] = useState('');
  const [picking, setPicking] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');

  const load = useCallback(async () => {
    setError('');
    try {
      const [st, ents, rows] = await Promise.all([
        callDrive({ action: 'status' }).catch((e) => ({ error: e.message })),
        fetchAll('entities', 'id, name, type, entity_status', (q) => q.in('entity_status', ['active', 'prospect']).order('name')),
        fetchAll('client_drive_folders', 'entity_id, folder_id, folder_name, category, status, match_method, accounts_folder_id'),
      ]);
      setStatus(st);
      setClients(ents);
      setMaps(Object.fromEntries(rows.map((r) => [r.entity_id, r])));
    } catch (e) { setError(e.message); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const shown = useMemo(() => clients.filter((c) => {
    const m = maps[c.id];
    if (filter === 'suggested' && m?.status !== 'suggested') return false;
    if (filter === 'confirmed' && m?.status !== 'confirmed') return false;
    if (filter === 'none' && m) return false;
    return !search || c.name.toLowerCase().includes(search.toLowerCase()) || (m?.folder_name || '').toLowerCase().includes(search.toLowerCase());
  }), [clients, maps, filter, search]);
  const counts = useMemo(() => ({
    suggested: clients.filter((c) => maps[c.id]?.status === 'suggested').length,
    confirmed: clients.filter((c) => maps[c.id]?.status === 'confirmed').length,
    none: clients.filter((c) => !maps[c.id]).length,
    all: clients.length,
  }), [clients, maps]);

  const run = async (payload, ok) => {
    setBusy(true); setError(''); setInfo('');
    try { const res = await callDrive(payload); await load(); setInfo(typeof ok === 'function' ? ok(res) : ok); setPicking(null); }
    catch (e) { setError(e.message); }
    finally { setBusy(false); }
  };
  // The explorer reports its own errors, so a failed link keeps it open.
  const link = async (client, folderId) => {
    await callDrive({ action: 'set_folder', entity_id: client.id, folder_id: folderId });
    setPicking(null);
    await load();
    setInfo(`${client.name} linked.`);
  };

  if (profile?.can_manage_portal !== true) {
    return <div style={{ padding: '40px 24px', fontFamily: font, color: '#64748b' }}>You need the System admin permission to manage Drive folders.</div>;
  }

  const conn = status?.connection;
  const shownSuggested = shown.filter((c) => maps[c.id]?.status === 'suggested').map((c) => c.id);

  return (
    <div style={{ margin: '0 auto', padding: '32px 24px', fontFamily: font, display: 'flex', flexDirection: 'column', gap: 16 }}>
      <h1 style={{ fontFamily: "'Playfair Display', serif", fontSize: 28, fontWeight: 500, color: '#0f172a', margin: 0 }}>Drive folders</h1>

      <div style={{ ...card, display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 260 }}>
          <div style={{ fontSize: 15, fontWeight: 600, color: '#0f172a' }}>Google Drive connection</div>
          <div style={{ fontSize: 13, color: '#64748b', marginTop: 2 }}>
            {status?.error ? status.error
              : !conn ? 'Not connected.'
              : <>Connected as <b>{conn.account_email}</b> · {conn.full_access
                  ? <span style={{ color: '#166534' }}>can read and write the client folders in AV.Shared</span>
                  : <span style={{ color: '#92400e' }}>can only see files Athena created — reconnect to give it the client folders</span>}
                {conn.error && <span style={{ color: '#991b1b' }}> · {conn.error}</span>}</>}
          </div>
          <div style={{ fontSize: 12, color: '#94a3b8', marginTop: 4 }}>
            Athena only ever works inside the AV.Shared shared drive, whatever else the connected account can see.
          </div>
        </div>
        <button disabled={busy} onClick={() => startDriveConnect('/admin/drive').catch((e) => setError(e.message))}
          style={conn?.full_access ? BTN.secondary.sm : BTN.primary.sm}>
          {conn ? 'Reconnect' : 'Connect Google Drive'}
        </button>
        <button disabled={busy || !conn?.full_access} onClick={() => run({ action: 'scan' }, (r) => `Scanned ${r.folders} client folders: ${r.suggested} new suggestions, ${r.confirmed} already confirmed.`)} style={BTN.primary.sm}>
          {busy ? 'Working…' : 'Scan Drive'}
        </button>
      </div>

      {picking && (
        <FolderExplorerModal
          title={`Drive folder for ${picking.name}`}
          clientType={picking.type}
          currentFolderId={maps[picking.id]?.folder_id || null}
          confirmLabel={`Link to ${picking.name}`}
          onPick={(fid) => link(picking, fid)}
          onClose={() => setPicking(null)} />
      )}

      {error && <div style={{ fontSize: 13, color: '#991b1b', background: '#fee2e2', borderRadius: 8, padding: '8px 10px' }}>{error}</div>}
      {info && <div style={{ fontSize: 13, color: '#166534', background: '#dcfce7', borderRadius: 8, padding: '8px 10px' }}>{info}</div>}

      <div style={{ ...card, padding: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '12px 16px', flexWrap: 'wrap', borderBottom: '1px solid #e5e7eb' }}>
          {FILTERS.map((f) => (
            <button key={f.id} onClick={() => setFilter(f.id)} style={filter === f.id ? BTN.primary.sm : BTN.secondary.sm}>{f.label} ({counts[f.id]})</button>
          ))}
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search clients or folders" style={{ border: '1px solid #d1d5db', borderRadius: 6, padding: '5px 8px', fontSize: 13, fontFamily: font, width: 220 }} />
          <div style={{ flex: 1 }} />
          {shownSuggested.length > 0 && (
            <button disabled={busy} onClick={() => window.confirm(`Confirm the ${shownSuggested.length} suggested folders shown? Check them first — Athena will save files into these folders.`) && run({ action: 'confirm', entity_ids: shownSuggested }, (r) => `${r.confirmed} confirmed.`)} style={BTN.primary.sm}>
              Confirm {shownSuggested.length} shown
            </button>
          )}
        </div>
        <div style={{ maxHeight: '62vh', overflow: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead><tr><th style={th}>Client</th><th style={th}>Type</th><th style={th}>Drive folder</th><th style={th}>Matched on</th><th style={th}></th></tr></thead>
            <tbody>
              {shown.map((c) => {
                const m = maps[c.id];
                return (
                  <React.Fragment key={c.id}>
                    <tr>
                      <td style={td}><Link to={`/clients/${c.id}`} style={{ color: '#0f172a', textDecoration: 'none' }}>{c.name}</Link>{c.entity_status === 'prospect' && <span style={{ color: '#94a3b8', fontSize: 12 }}> · prospect</span>}</td>
                      <td style={{ ...td, color: '#64748b', fontSize: 12.5 }}>{String(c.type || '').replace('_', ' ')}</td>
                      <td style={td}>{m ? <a href={folderLink(m.folder_id)} target="_blank" rel="noreferrer" style={{ color: '#1E4560' }}>{m.category ? `${m.category} / ` : ''}{m.folder_name}</a> : <span style={{ color: '#cbd5e1' }}>—</span>}</td>
                      <td style={{ ...td, fontSize: 12.5, color: m?.status === 'suggested' ? '#92400e' : '#64748b' }}>{m ? `${METHOD[m.match_method]}${m.status === 'suggested' ? ' · suggested' : ''}` : ''}</td>
                      <td style={{ ...td, textAlign: 'right', whiteSpace: 'nowrap' }}>
                        {m?.status === 'suggested' && <button disabled={busy} onClick={() => run({ action: 'confirm', entity_ids: [c.id] }, `${c.name} confirmed.`)} style={{ ...BTN.primary.sm, marginRight: 6 }}>Confirm</button>}
                        <button disabled={busy} onClick={() => setPicking(c)} style={BTN.secondary.sm}>{m ? 'Change' : 'Set'}</button>
                      </td>
                    </tr>
                  </React.Fragment>
                );
              })}
              {shown.length === 0 && <tr><td colSpan={5} style={{ ...td, color: '#94a3b8' }}>Nothing here.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
