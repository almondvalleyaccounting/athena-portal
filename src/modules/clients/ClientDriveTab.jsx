import React, { useCallback, useEffect, useState } from 'react';
import { BTN } from '../../lib/buttonStyles';
import { callDrive, fetchClientFolder, folderLink } from '../drive/driveApi';
import DriveFolderBrowser from '../drive/DriveFolderBrowser';
import FolderExplorerModal from '../drive/FolderExplorerModal';

const font = "'Outfit', sans-serif";
const card = { background: '#fff', borderRadius: 12, border: '1px solid #e5e7eb', padding: '18px 22px' };

const METHOD = { name: 'matched on name', company_number: 'matched on company number', manual: 'set by hand' };

// The client's Google Drive folder (sql/362): which folder is theirs, and its
// contents. A scan only suggests; a person confirms before Athena writes there.
export default function ClientDriveTab({ entityId, entityName, entityType }) {
  const [map, setMap] = useState(undefined);
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');

  const reload = useCallback(async () => {
    try { setMap(await fetchClientFolder(entityId)); } catch (e) { setError(e.message); }
  }, [entityId]);
  useEffect(() => { reload(); }, [reload]);

  const run = async (payload, ok) => {
    setBusy(true); setError(''); setInfo('');
    try { await callDrive(payload); await reload(); if (ok) setInfo(ok); setPicking(false); }
    catch (e) { setError(e.message); }
    finally { setBusy(false); }
  };

  if (map === undefined) return <div style={{ ...card, color: '#94a3b8', fontFamily: font }}>Loading…</div>;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, fontFamily: font }}>
      <div style={card}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <div style={{ flex: 1, minWidth: 220 }}>
            <div style={{ fontSize: 15, fontWeight: 600, color: '#0f172a' }}>Google Drive folder</div>
            {map ? (
              <div style={{ fontSize: 13, color: '#64748b', marginTop: 2 }}>
                <a href={folderLink(map.folder_id)} target="_blank" rel="noreferrer" style={{ color: '#1E4560', fontWeight: 600 }}>{map.folder_name}</a>
                {map.category && <> · {map.category}</>} · {METHOD[map.match_method]}
                {map.status === 'suggested' && <span style={{ marginLeft: 8, background: '#fef3c7', color: '#92400e', borderRadius: 6, padding: '1px 6px', fontSize: 12 }}>Suggested — not yet confirmed</span>}
                {map.accounts_folder_id && <> · year ends in a <a href={folderLink(map.accounts_folder_id)} target="_blank" rel="noreferrer" style={{ color: '#1E4560' }}>pinned folder</a></>}
              </div>
            ) : (
              <div style={{ fontSize: 13, color: '#64748b', marginTop: 2 }}>No folder set for {entityName || 'this client'}.</div>
            )}
          </div>
          {map?.status === 'suggested' && <button disabled={busy} onClick={() => run({ action: 'confirm', entity_ids: [entityId] }, 'Folder confirmed.')} style={BTN.primary.sm}>Confirm</button>}
          {!picking && <button disabled={busy} onClick={() => setPicking(true)} style={map ? BTN.secondary.sm : BTN.primary.sm}>{map ? 'Change' : 'Set folder'}</button>}
          {map && !picking && <button disabled={busy} onClick={() => window.confirm('Forget this client\'s Drive folder? Nothing in Drive is changed.') && run({ action: 'clear', entity_id: entityId }, 'Folder cleared.')} style={BTN.danger.sm}>Clear</button>}
        </div>
        {error && <div style={{ marginTop: 10, fontSize: 13, color: '#991b1b', background: '#fee2e2', borderRadius: 8, padding: '8px 10px' }}>{error}</div>}
        {info && <div style={{ marginTop: 10, fontSize: 13, color: '#166534', background: '#dcfce7', borderRadius: 8, padding: '8px 10px' }}>{info}</div>}
        {picking && (
          <FolderExplorerModal
            title={`Drive folder for ${entityName || 'this client'}`}
            clientType={entityType}
            currentFolderId={map?.folder_id || null}
            confirmLabel="Link to this client"
            onPick={async (fid) => {
              await callDrive({ action: 'set_folder', entity_id: entityId, folder_id: fid });
              setPicking(false); await reload(); setInfo('Folder linked.');
            }}
            onClose={() => setPicking(false)} />
        )}
      </div>

      {map && (
        <div style={card}>
          <DriveFolderBrowser
            entityId={entityId}
            refreshKey={map.folder_id}
            action={(folder) => map.status === 'confirmed' && folder.id !== map.folder_id && (
              <button disabled={busy} title="Year-end folders (YYYY.MM.DD) for this client are made inside this folder"
                onClick={() => run({ action: 'set_accounts_folder', entity_id: entityId, folder_id: folder.id }, `Year ends now live in “${folder.name}”.`)}
                style={BTN.secondary.sm}>
                {map.accounts_folder_id === folder.id ? 'Year ends live here' : 'Use for year ends'}
              </button>
            )}
          />
          <div style={{ fontSize: 12, color: '#94a3b8', marginTop: 8 }}>
            Year ends normally go in 04_Accounts / 04_StatutoryAccounts / <i>period end</i>. If this client is laid out differently, open the right folder and choose “Use for year ends”.
            {map.accounts_folder_id && <> <button onClick={() => run({ action: 'set_accounts_folder', entity_id: entityId, folder_id: null }, 'Back to the usual year-end folder.')} style={{ background: 'none', border: 'none', color: '#1E4560', cursor: 'pointer', padding: 0, fontSize: 12, fontFamily: font }}>Go back to the usual folder</button></>}
          </div>
        </div>
      )}
    </div>
  );
}
