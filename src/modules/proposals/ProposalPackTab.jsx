import React, { useEffect, useMemo, useRef, useState } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ImagePlus, Trash2, RotateCcw, Download, Save, Pencil, Eye } from 'lucide-react';
import { supabase } from '../../lib/supabase';
import PackPage, { ICON_COMPONENTS, Graphic } from './PackPage';
import { ACCENTS, GRAPHICS, ICONS, ALL_PAGES, SERVICE_PAGES, mergePage, editableOf } from './packContent';

// Pricing & Proposals → Proposal pack.
//
// Two modes:
//   Pages      the design area. Pick a page, edit its words in place on the
//              page itself, and choose its icon, header artwork, colour and
//              picture. Saved pages replace the standard text (sql/327,
//              proposal-pack edge function); Reset brings the standard back.
//   Build      choose a client name and the services, see the whole pack,
//              and download it as a PDF (the browser's print-to-PDF, so the
//              text stays sharp and selectable).
//
// Not connected to quotes or sending yet — a standalone drafting tool.

const PX_PER_MM = 96 / 25.4;
const PAGE_W = 210 * PX_PER_MM;
const PAGE_H = 297 * PX_PER_MM;

const EDITOR_CSS = `
  .pack-editable { border-radius: 3px; transition: box-shadow .12s; }
  .pack-editable:hover { box-shadow: 0 0 0 1px rgba(201,164,92,.8); }
  .pack-editable:focus { box-shadow: 0 0 0 2px #c9a45c; }
  .pack-li .pack-li-x { opacity: 0; }
  .pack-li:hover .pack-li-x { opacity: 1; }
`;

function Scaled({ width, children }) {
  const scale = width / PAGE_W;
  return (
    <div style={{ width, height: PAGE_H * scale, position: 'relative', flex: '0 0 auto' }}>
      <div style={{ transform: `scale(${scale})`, transformOrigin: 'top left', width: PAGE_W, height: PAGE_H, position: 'absolute', top: 0, left: 0, boxShadow: '0 2px 14px rgba(15,23,42,0.18)' }}>
        {children}
      </div>
    </div>
  );
}

// Fit the page to the space available.
function useWidth(ref, fallback = 600) {
  const [w, setW] = useState(fallback);
  useEffect(() => {
    if (!ref.current) return undefined;
    const ro = new ResizeObserver(([e]) => setW(e.contentRect.width));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, [ref]);
  return w;
}

// A picture for a page header, resized in the browser so the page stays small.
function readPicture(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      const scale = Math.min(1, 1800 / img.width, 1000 / img.height);
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * scale);
      c.height = Math.round(img.height * scale);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      resolve(c.toDataURL('image/jpeg', 0.82));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('That file could not be read as a picture.')); };
    img.src = url;
  });
}

const todayText = () => new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });

export default function ProposalPackTab() {
  const [mode, setMode] = useState('pages'); // pages | build
  const [saved, setSaved] = useState({}); // page_key -> content
  const [drafts, setDrafts] = useState({}); // page_key -> page with unsaved edits
  const [selected, setSelected] = useState('accounts');
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  const [note, setNote] = useState(null);

  // Build mode
  const [clientName, setClientName] = useState('');
  const [chosen, setChosen] = useState(['accounts', 'bookkeeping', 'vat', 'payroll']);

  useEffect(() => {
    supabase.from('proposal_pack_pages').select('page_key, content').then(({ data, error: e }) => {
      if (e) { setError(e.message); return; }
      setSaved(Object.fromEntries((data || []).map((r) => [r.page_key, r.content])));
    });
  }, []);

  const pageOf = (key) => drafts[key] || mergePage(key, saved[key]);
  const current = pageOf(selected);
  const dirty = !!drafts[selected];
  const edit = (next) => { setDrafts((d) => ({ ...d, [selected]: next })); setNote(null); };

  const call = async (body) => {
    const { data, error: e } = await supabase.functions.invoke('proposal-pack', { body });
    if (e || !data?.success) {
      let msg = data?.error || e?.message || 'Something went wrong';
      try { const j = await e?.context?.json(); if (j?.error) msg = j.error; } catch { /* keep msg */ }
      throw new Error(msg);
    }
  };

  const save = async () => {
    setBusy('save'); setError(null);
    try {
      const content = editableOf(current);
      await call({ action: 'save_page', page_key: selected, content });
      setSaved((s) => ({ ...s, [selected]: content }));
      setDrafts((d) => { const n = { ...d }; delete n[selected]; return n; });
      setNote('Saved.');
    } catch (e) { setError(e.message); } finally { setBusy(null); }
  };

  const reset = async () => {
    if (!window.confirm('Go back to the standard text and design for this page? Your changes to it will be lost.')) return;
    setBusy('reset'); setError(null);
    try {
      if (saved[selected]) await call({ action: 'reset_page', page_key: selected });
      setSaved((s) => { const n = { ...s }; delete n[selected]; return n; });
      setDrafts((d) => { const n = { ...d }; delete n[selected]; return n; });
      setNote('Back to the standard page.');
    } catch (e) { setError(e.message); } finally { setBusy(null); }
  };

  const onPicture = async (file) => {
    if (!file) return;
    try { edit({ ...current, image: await readPicture(file) }); }
    catch (e) { setError(e.message); }
  };

  // ── The pack, in order ──
  const packPages = useMemo(() => {
    const services = SERVICE_PAGES.filter((p) => chosen.includes(p.key)).map((p) => pageOf(p.key));
    return [pageOf('cover'), ...services, pageOf('next_steps')];
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chosen, saved, drafts]);
  const serviceTitles = packPages.filter((p) => p.kind === 'service').map((p) => p.title);

  const downloadPdf = () => {
    const logoUrl = `${window.location.origin}/ava-logo.jpg`;
    const total = packPages.length;
    const markup = renderToStaticMarkup(
      <>{packPages.map((p, i) => (
        <PackPage key={p.key} page={p} clientName={clientName} services={serviceTitles} pageNo={i + 1} total={total} logoUrl={logoUrl} dateText={todayText()} />
      ))}</>,
    );
    const w = window.open('', '_blank');
    if (!w) { setError('Allow pop-ups for Athena to download the pack.'); return; }
    const title = `Proposal${clientName ? ` - ${clientName}` : ''}`;
    w.document.write(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>${title.replace(/</g, '')}</title>
<link rel="preconnect" href="https://fonts.googleapis.com" /><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=Playfair+Display:wght@400;500;600&family=Outfit:wght@300;400;500;600&display=swap" rel="stylesheet" />
<style>
  @page { size: A4; margin: 0; }
  html, body { margin: 0; padding: 0; background: #e5e7eb; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  body > div { margin: 0 auto; }
  @media screen { body > div { margin: 12px auto; box-shadow: 0 2px 14px rgba(0,0,0,.2); } }
  @media print { html, body { background: #fff; } }
</style></head><body>${markup}
<script>document.fonts.ready.then(function(){ setTimeout(function(){ window.print(); }, 300); });</script>
</body></html>`);
    w.document.close();
  };

  return (
    <div>
      <style>{EDITOR_CSS}</style>
      <div className="flex items-center gap-2 mb-3 flex-wrap">
        <div className="inline-flex rounded-lg border border-gray-200 overflow-hidden">
          <button onClick={() => setMode('pages')} className={`px-3 py-1.5 text-sm inline-flex items-center gap-1.5 ${mode === 'pages' ? 'bg-ocean-700 text-white' : 'bg-white text-gray-600'}`}><Pencil size={14} /> Design pages</button>
          <button onClick={() => setMode('build')} className={`px-3 py-1.5 text-sm inline-flex items-center gap-1.5 ${mode === 'build' ? 'bg-ocean-700 text-white' : 'bg-white text-gray-600'}`}><Eye size={14} /> Build a pack</button>
        </div>
        <span className="text-xs text-gray-400">A PDF for one client: a cover, a page for each service, and next steps. A draft tool for now; it isn’t connected to quotes.</span>
      </div>
      {error && <div className="mb-3 text-sm text-red-700 bg-red-50 border border-red-200 rounded p-2">{error}</div>}

      {mode === 'pages'
        ? <DesignArea {...{ selected, setSelected, current, edit, dirty, drafts, saved, save, reset, busy, note, onPicture }} />
        : <BuildArea {...{ clientName, setClientName, chosen, setChosen, packPages, serviceTitles, downloadPdf }} />}
    </div>
  );
}

// ─── Design area ─────────────────────────────────────────────────────
function DesignArea({ selected, setSelected, current, edit, dirty, drafts, saved, save, reset, busy, note, onPicture }) {
  const stage = useRef(null);
  const width = Math.min(useWidth(stage), 720);
  const fileRef = useRef(null);
  const accent = ACCENTS[current.accent] || ACCENTS.ocean;

  return (
    <div className="flex gap-4 items-start" style={{ minHeight: 600 }}>
      {/* Pages */}
      <div className="w-56 shrink-0 bg-white border border-gray-200 rounded-lg overflow-hidden">
        <div className="px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-gray-400 border-b border-gray-100">Pages</div>
        <div className="max-h-[70vh] overflow-y-auto">
          {ALL_PAGES.map((p) => {
            const Ico = ICON_COMPONENTS[(drafts[p.key] || saved[p.key] || p).icon] || ICON_COMPONENTS.FileText;
            return (
              <button key={p.key} onClick={() => setSelected(p.key)}
                className={`w-full text-left px-3 py-2 text-sm flex items-center gap-2 border-b border-gray-50 ${selected === p.key ? 'bg-ocean-50 text-ocean-800 font-medium' : 'text-gray-700 hover:bg-gray-50'}`}>
                <Ico size={14} className="shrink-0 text-ocean-600" />
                <span className="flex-1 truncate">{(drafts[p.key] || saved[p.key] || p).title || p.title}</span>
                {drafts[p.key] ? <span title="Unsaved changes" className="w-2 h-2 rounded-full bg-amber-500" />
                  : saved[p.key] ? <span title="Edited" className="text-[10px] text-gray-400">edited</span> : null}
              </button>
            );
          })}
        </div>
      </div>

      {/* Page */}
      <div ref={stage} className="flex-1 min-w-0 flex flex-col items-center gap-2">
        <div className="text-xs text-gray-400">Click any text on the page to edit it. Hover a point to remove it.</div>
        <Scaled width={width}>
          <PackPage page={current} editable onChange={edit} clientName="Client name" services={['Year-end accounts and Corporation Tax', 'Bookkeeping', 'VAT returns']} dateText={todayText()} />
        </Scaled>
      </div>

      {/* Design */}
      <div className="w-64 shrink-0 bg-white border border-gray-200 rounded-lg p-3 space-y-4">
        <div>
          <div className="text-[11px] font-semibold uppercase tracking-wide text-gray-400 mb-2">Icon</div>
          <div className="grid grid-cols-6 gap-1">
            {ICONS.map((name) => {
              const Ico = ICON_COMPONENTS[name];
              return (
                <button key={name} title={name} onClick={() => edit({ ...current, icon: name })}
                  className={`h-8 rounded flex items-center justify-center border ${current.icon === name ? 'border-ocean-600 bg-ocean-50' : 'border-transparent hover:bg-gray-50'}`}>
                  <Ico size={16} color={accent.base} />
                </button>
              );
            })}
          </div>
        </div>

        <div>
          <div className="text-[11px] font-semibold uppercase tracking-wide text-gray-400 mb-2">Header artwork</div>
          <div className="grid grid-cols-3 gap-1.5">
            {GRAPHICS.map((g) => (
              <button key={g.id} onClick={() => edit({ ...current, graphic: g.id, image: null })} title={g.label}
                className={`rounded overflow-hidden border-2 ${current.graphic === g.id && !current.image ? 'border-amber-500' : 'border-transparent'}`}>
                <div style={{ position: 'relative', height: 34, background: `linear-gradient(135deg, ${accent.base}, ${accent.deep})` }}>
                  <Graphic id={g.id} height={92} />
                </div>
                <div className="text-[10px] text-gray-500 py-0.5">{g.label}</div>
              </button>
            ))}
          </div>
        </div>

        <div>
          <div className="text-[11px] font-semibold uppercase tracking-wide text-gray-400 mb-2">Colour</div>
          <div className="flex gap-1.5 flex-wrap">
            {Object.entries(ACCENTS).map(([k, a]) => (
              <button key={k} title={a.label} onClick={() => edit({ ...current, accent: k })}
                style={{ width: 26, height: 26, borderRadius: '50%', background: a.base, outline: current.accent === k ? '2px solid #c9a45c' : 'none', outlineOffset: 2 }} />
            ))}
          </div>
        </div>

        <div>
          <div className="text-[11px] font-semibold uppercase tracking-wide text-gray-400 mb-2">Picture</div>
          <input ref={fileRef} type="file" accept="image/jpeg,image/png,image/webp" className="hidden" onChange={(e) => { onPicture(e.target.files?.[0]); e.target.value = ''; }} />
          {current.image ? (
            <div className="space-y-1.5">
              <img src={current.image} alt="" className="w-full h-20 object-cover rounded" />
              <div className="flex gap-1.5">
                <button onClick={() => fileRef.current?.click()} className="flex-1 text-xs border border-gray-200 rounded py-1 hover:bg-gray-50">Replace</button>
                <button onClick={() => edit({ ...current, image: null })} className="text-xs border border-gray-200 rounded px-2 py-1 hover:bg-red-50 text-red-700 inline-flex items-center gap-1"><Trash2 size={12} /> Remove</button>
              </div>
            </div>
          ) : (
            <button onClick={() => fileRef.current?.click()} className="w-full text-xs border border-dashed border-gray-300 rounded py-3 text-gray-500 hover:bg-gray-50 inline-flex items-center justify-center gap-1.5">
              <ImagePlus size={14} /> Add a header picture
            </button>
          )}
          <div className="text-[10.5px] text-gray-400 mt-1">Shown behind the heading, toned to the page colour.</div>
        </div>

        <div className="pt-2 border-t border-gray-100 space-y-1.5">
          <button onClick={save} disabled={!dirty || !!busy}
            className="w-full text-sm rounded-lg py-2 bg-ocean-700 text-white font-semibold disabled:opacity-40 inline-flex items-center justify-center gap-1.5">
            <Save size={14} /> {busy === 'save' ? 'Saving…' : 'Save page'}
          </button>
          <button onClick={reset} disabled={(!dirty && !saved[selected]) || !!busy}
            className="w-full text-xs rounded-lg py-1.5 border border-gray-200 text-gray-600 disabled:opacity-40 inline-flex items-center justify-center gap-1.5">
            <RotateCcw size={12} /> Reset to standard
          </button>
          <div className="text-[11px] text-center text-gray-400 h-4">{dirty ? 'Unsaved changes' : note || ''}</div>
        </div>
      </div>
    </div>
  );
}

// ─── Build a pack ────────────────────────────────────────────────────
function BuildArea({ clientName, setClientName, chosen, setChosen, packPages, serviceTitles, downloadPdf }) {
  const toggle = (key) => setChosen((c) => (c.includes(key) ? c.filter((k) => k !== key) : [...c, key]));
  return (
    <div className="flex gap-4 items-start">
      <div className="w-72 shrink-0 bg-white border border-gray-200 rounded-lg p-3 space-y-3">
        <label className="block">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-gray-400">Client</span>
          <input value={clientName} onChange={(e) => setClientName(e.target.value)} placeholder="Client or business name"
            className="mt-1 w-full border border-gray-200 rounded-md px-2 py-1.5 text-sm" />
        </label>
        <div>
          <div className="text-[11px] font-semibold uppercase tracking-wide text-gray-400 mb-1">Services</div>
          <div className="max-h-[52vh] overflow-y-auto pr-1">
            {SERVICE_PAGES.map((p) => (
              <label key={p.key} className="flex items-center gap-2 text-sm py-1 cursor-pointer">
                <input type="checkbox" checked={chosen.includes(p.key)} onChange={() => toggle(p.key)} />
                <span className="text-gray-700">{p.title}</span>
              </label>
            ))}
          </div>
        </div>
        <button onClick={downloadPdf} disabled={chosen.length === 0}
          className="w-full text-sm rounded-lg py-2 bg-ocean-700 text-white font-semibold disabled:opacity-40 inline-flex items-center justify-center gap-1.5">
          <Download size={14} /> Download PDF
        </button>
        <div className="text-[11px] text-gray-400">Opens the pack in a new tab and your browser’s print dialog: choose “Save as PDF”.</div>
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-xs text-gray-400 mb-2">{packPages.length} pages · cover, {serviceTitles.length} service{serviceTitles.length === 1 ? '' : 's'}, next steps</div>
        <div className="flex flex-wrap gap-4">
          {packPages.map((p, i) => (
            <Scaled key={p.key} width={300}>
              <PackPage page={p} clientName={clientName} services={serviceTitles} pageNo={i + 1} total={packPages.length} dateText={todayText()} />
            </Scaled>
          ))}
        </div>
      </div>
    </div>
  );
}
