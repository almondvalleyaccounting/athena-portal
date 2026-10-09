import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronRight, ChevronDown, Folder, FolderOpen, FolderSearch, FileText, ExternalLink, X } from 'lucide-react';
import { BTN } from '../../lib/buttonStyles';
import { callDrive, searchFolderIndex, folderLink } from './driveApi';
import { openDriveFile, showInExplorer } from './desktopOpen';

const font = "'Outfit', sans-serif";

// Which top-level AV.Shared folder a client's folder normally sits in.
export const CATEGORY_FOR_TYPE = {
  limited_company: 'Ltd_Cos', llp: 'Ltd_Cos', partnership: 'Partnerships', sole_trader: 'Individuals', personal: 'Individuals',
};

function fmtDate(iso) {
  return iso ? new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '';
}

// A file-explorer for AV.Shared (sql/362): folder tree on the left, the chosen
// folder's contents on the right, so a person can see it is the right client
// before linking it. Opens on the client type's category folder, with the
// current folder (if any) selected.
export default function FolderExplorerModal({ title, clientType, currentFolderId, confirmLabel = 'Link this folder', onPick, onClose }) {
  const [nodes, setNodes] = useState({}); // id -> { id, name, parent, children: [id]|null, loading }
  const [roots, setRoots] = useState([]);
  const [expanded, setExpanded] = useState({});
  const [selected, setSelected] = useState(null);
  const [contents, setContents] = useState(null);
  const [search, setSearch] = useState('');
  const [hits, setHits] = useState([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;
  const selectedRow = useRef(null);

  const putChildren = (parentId, folders) => setNodes((n) => {
    const next = { ...n, [parentId]: { ...n[parentId], children: folders.map((f) => f.id), loading: false } };
    folders.forEach((f) => { next[f.id] = { ...(n[f.id] || {}), id: f.id, name: f.name, parent: parentId, children: n[f.id]?.children ?? null }; });
    return next;
  });

  const loadChildren = useCallback(async (id) => {
    if (nodesRef.current[id]?.children) return nodesRef.current[id].children;
    setNodes((n) => ({ ...n, [id]: { ...n[id], loading: true } }));
    try {
      const res = await callDrive({ action: 'browse', folder_id: id, folders_only: true });
      const folders = res.items.filter((i) => i.is_folder);
      putChildren(id, folders);
      return folders.map((f) => f.id);
    } catch (e) {
      setError(e.message);
      setNodes((n) => ({ ...n, [id]: { ...n[id], loading: false } }));
      return [];
    }
  }, []);

  const expand = useCallback(async (id, open = true) => {
    setExpanded((x) => ({ ...x, [id]: open }));
    return open ? loadChildren(id) : [];
  }, [loadChildren]);

  // Open: the roots, the client's category expanded, the current folder selected.
  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const res = await callDrive({ action: 'roots' });
        if (!live) return;
        const r = res.folders;
        setRoots(r.map((f) => f.id));
        setNodes((n) => Object.fromEntries([...Object.entries(n), ...r.map((f) => [f.id, { id: f.id, name: f.name, parent: null, children: null }])]));
        const cat = r.find((f) => f.name === CATEGORY_FOR_TYPE[clientType]) || r.find((f) => f.name === 'Ltd_Cos');
        if (cat) {
          const kids = await expand(cat.id);
          if (!live) return;
          setSelected(currentFolderId && kids.includes(currentFolderId) ? currentFolderId : cat.id);
        }
      } catch (e) { setError(e.message); }
    })();
    return () => { live = false; };
  }, [clientType, currentFolderId, expand]);

  // The selected folder's contents (files too), to check it is the right client.
  useEffect(() => {
    if (!selected) return;
    let live = true;
    setContents(null);
    callDrive({ action: 'browse', folder_id: selected })
      .then((res) => { if (live) setContents(res); })
      .catch((e) => { if (live) setError(e.message); });
    return () => { live = false; };
  }, [selected]);
  useEffect(() => { selectedRow.current?.scrollIntoView({ block: 'nearest' }); }, [selected, nodes]);

  useEffect(() => {
    if (!search.trim()) { setHits([]); return; }
    let live = true;
    const t = setTimeout(() => searchFolderIndex(search.trim()).then((r) => { if (live) setHits(r); }).catch(() => {}), 200);
    return () => { live = false; clearTimeout(t); };
  }, [search]);
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const openHit = async (hit) => {
    const cat = roots.find((id) => nodesRef.current[id]?.name === hit.category);
    if (cat) await expand(cat);
    setSelected(hit.folder_id);
    setSearch('');
  };
  const openChild = async (childId) => {
    await expand(selected);
    setSelected(childId);
  };

  const path = useMemo(() => {
    const out = [];
    for (let id = selected; id && nodes[id]; id = nodes[id].parent) out.unshift(nodes[id].name);
    return out;
  }, [selected, nodes]);
  const isRoot = selected && roots.includes(selected);

  const pick = async () => {
    setBusy(true); setError('');
    try { await onPick(selected); }
    catch (e) { setError(e.message); setBusy(false); }
  };

  const renderNode = (id, depth) => {
    const n = nodes[id];
    if (!n) return null;
    const open = !!expanded[id];
    const sel = selected === id;
    const leaf = Array.isArray(n.children) && n.children.length === 0;
    return (
      <React.Fragment key={id}>
        <div ref={sel ? selectedRow : null}
          onClick={() => setSelected(id)} onDoubleClick={() => expand(id, !open)}
          style={{ display: 'flex', alignItems: 'center', gap: 4, padding: `3px 8px 3px ${8 + depth * 16}px`, cursor: 'pointer', fontSize: 13.5, background: sel ? '#e0ecf5' : 'transparent', color: '#0f172a', whiteSpace: 'nowrap' }}>
          <span onClick={(e) => { e.stopPropagation(); expand(id, !open); }} style={{ width: 16, display: 'inline-flex', color: '#94a3b8', visibility: leaf ? 'hidden' : 'visible' }}>
            {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          </span>
          {open ? <FolderOpen size={15} color="#64748b" /> : <Folder size={15} color="#64748b" />}
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{n.name}</span>
          {id === currentFolderId && <span style={{ fontSize: 11, color: '#166534', marginLeft: 6 }}>linked now</span>}
          {n.loading && <span style={{ fontSize: 11, color: '#94a3b8', marginLeft: 6 }}>loading…</span>}
        </div>
        {open && (n.children || []).map((c) => renderNode(c, depth + 1))}
      </React.Fragment>
    );
  };

  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.45)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16, fontFamily: font }}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: '#fff', borderRadius: 12, width: 'min(1100px, 100%)', height: 'min(720px, 100%)', display: 'flex', flexDirection: 'column', boxShadow: '0 20px 50px rgba(0,0,0,0.25)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '14px 18px', borderBottom: '1px solid #e5e7eb' }}>
          <div style={{ fontSize: 16, fontWeight: 600, color: '#0f172a', flex: 1 }}>{title}</div>
          <div style={{ position: 'relative' }}>
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Jump to a client folder…"
              style={{ border: '1px solid #d1d5db', borderRadius: 6, padding: '6px 10px', fontSize: 13, fontFamily: font, width: 260 }} />
            {hits.length > 0 && (
              <div style={{ position: 'absolute', top: '100%', right: 0, width: 340, maxHeight: 300, overflow: 'auto', background: '#fff', border: '1px solid #e5e7eb', borderRadius: 8, boxShadow: '0 8px 20px rgba(0,0,0,0.12)', zIndex: 2, marginTop: 4 }}>
                {hits.map((h) => (
                  <div key={h.folder_id} onClick={() => openHit(h)} style={{ padding: '6px 10px', fontSize: 13, cursor: 'pointer', display: 'flex', gap: 8, borderBottom: '1px solid #f1f5f9' }}>
                    <span style={{ flex: 1 }}>{h.name}</span><span style={{ color: '#94a3b8', fontSize: 11.5 }}>{h.category}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#64748b', display: 'inline-flex' }}><X size={18} /></button>
        </div>

        {error && <div style={{ margin: '10px 18px 0', fontSize: 13, color: '#991b1b', background: '#fee2e2', borderRadius: 8, padding: '8px 10px' }}>{error}</div>}

        <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
          <div style={{ width: '42%', borderRight: '1px solid #e5e7eb', overflow: 'auto', padding: '6px 0' }}>
            <div style={{ padding: '2px 12px 6px', fontSize: 11.5, fontWeight: 600, color: '#94a3b8' }}>AV.Shared</div>
            {roots.length === 0 && !error && <div style={{ padding: 12, fontSize: 13, color: '#94a3b8' }}>Loading…</div>}
            {roots.map((id) => renderNode(id, 0))}
          </div>
          <div style={{ flex: 1, overflow: 'auto', display: 'flex', flexDirection: 'column' }}>
            <div style={{ padding: '8px 14px', fontSize: 12.5, color: '#64748b', borderBottom: '1px solid #f1f5f9' }}>{path.join(' / ') || '—'}</div>
            {!contents && selected && <div style={{ padding: 14, fontSize: 13, color: '#94a3b8' }}>Loading…</div>}
            {contents && contents.items.length === 0 && <div style={{ padding: 14, fontSize: 13, color: '#94a3b8' }}>Empty folder</div>}
            {contents && contents.items.map((it) => (
              <div key={it.id} onDoubleClick={() => it.is_folder && openChild(it.id)}
                style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 14px', borderBottom: '1px solid #f8fafc', fontSize: 13, cursor: it.is_folder ? 'pointer' : 'default' }}
                title={it.is_folder ? 'Double-click to open' : ''}>
                {it.is_folder ? <Folder size={15} color="#64748b" /> : <FileText size={15} color="#94a3b8" />}
                {it.is_folder
                  ? <span style={{ flex: 1 }}>{it.name}</span>
                  : <span onClick={() => openDriveFile(it, contents.folder.path)} style={{ flex: 1, color: '#0f172a', cursor: 'pointer' }} title="Open">{it.name}</span>}
                <span style={{ color: '#94a3b8', fontSize: 12 }}>{fmtDate(it.modified)}</span>
              </div>
            ))}
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '12px 18px', borderTop: '1px solid #e5e7eb' }}>
          <div style={{ flex: 1, fontSize: 13, color: '#475569', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {selected ? <>Selected: <b>{path[path.length - 1]}</b></> : 'Choose a folder'}
          </div>
          {contents?.folder?.path && (
            <button onClick={() => showInExplorer(contents.folder.path)} style={{ ...BTN.secondary.sm, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              <FolderSearch size={13} /> File Explorer
            </button>
          )}
          {selected && (
            <a href={folderLink(selected)} target="_blank" rel="noreferrer" style={{ ...BTN.secondary.sm, textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              Open in Drive <ExternalLink size={12} />
            </a>
          )}
          <button onClick={onClose} style={BTN.secondary.sm}>Cancel</button>
          <button disabled={!selected || isRoot || busy} onClick={pick} style={{ ...BTN.primary.sm, opacity: !selected || isRoot ? 0.5 : 1 }}
            title={isRoot ? 'Choose the client\'s own folder, not a top-level one' : ''}>
            {busy ? 'Linking…' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
