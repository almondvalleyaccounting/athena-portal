import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { Layers, Plus, X, Trash2, Info, Check } from 'lucide-react';
import { supabase } from '../../lib/supabase';
import { useAuth } from '../../shell/AppShell';
import { OUTFIT, cardStyle, inputStyle } from './dashboardData';
import { checkFormula, FINANCIAL_KEYS } from './kpiEngine';

/*
  KPI Packs — /admin/kpi-packs (can_manage_kpi_packs only).

  Sector packs, and the KPIs in them. Editing here reaches every client in the
  sector at once, which is the whole point and also the reason it is behind its
  own permission rather than plain staff access.

  The editor's real job is stopping two mistakes:

    • A formula referring to something that does not exist. A typo shows up as a
      silent "—" on the dashboard weeks later, with nothing to connect it back to
      the moment somebody mistyped `palces`. checkFormula names the unknown key
      while the field is still open.

    • The wrong aggregation. Every entry KPI has to say how it rolls up, because
      "sum" is right for most things and catastrophically wrong for headcount
      and for capacity. The picker spells out what each choice means rather than
      offering four bare words.
*/

const UNITS = [
  { key: 'number', label: 'Number' },
  { key: 'money', label: 'Money' },
  { key: 'percent', label: 'Percentage' },
  { key: 'ratio', label: 'Ratio' },
  { key: 'hours', label: 'Hours' },
];

const AGGREGATIONS = [
  { key: 'sum', label: 'Add the months up', hint: 'Enquiries, hours worked, anything that accumulates.' },
  { key: 'average', label: 'Average the months', hint: 'Headcount, children on roll — a level, not a total.' },
  { key: 'last', label: 'Take the closing month', hint: 'Capacity, registered places — the position at the end.' },
  { key: 'max', label: 'Take the highest month', hint: 'Peak demand.' },
  { key: 'min', label: 'Take the lowest month', hint: 'Trough.' },
];

const blankDef = () => ({
  key: '', label: '', kind: 'entry', unit: 'number', decimals: 0,
  aggregation: 'sum', dimension_id: null, formula: '', hint: '',
  show_on_overview: false, sort_order: 100,
});

export default function KpiPacksPage() {
  const { profile } = useAuth();
  const canManage = profile?.can_manage_kpi_packs === true;

  const [sectors, setSectors] = useState([]);
  const [sectorId, setSectorId] = useState(null);
  const [definitions, setDefinitions] = useState([]);
  const [dimensions, setDimensions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const [editing, setEditing] = useState(null);   // definition draft, or null
  const [newSector, setNewSector] = useState('');
  const [newDimension, setNewDimension] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { data, error } = await supabase.rpc('kpi_sectors_with_counts');
      if (error) throw error;
      setSectors(data || []);
      setSectorId((cur) => cur || data?.[0]?.id || null);
    } catch (e) { setMsg({ tone: 'error', text: String(e.message || e) }); }
    setLoading(false);
  }, []);

  const loadPack = useCallback(async () => {
    if (!sectorId) { setDefinitions([]); setDimensions([]); return; }
    try {
      const [defs, dims] = await Promise.all([
        supabase.from('kpi_definition').select('*').eq('sector_id', sectorId).order('sort_order'),
        supabase.from('kpi_dimension').select('*').eq('sector_id', sectorId).order('sort_order'),
      ]);
      setDefinitions(defs.data || []);
      setDimensions(dims.data || []);
    } catch (e) { setMsg({ tone: 'error', text: String(e.message || e) }); }
  }, [sectorId]);

  useEffect(() => { if (canManage) load(); }, [canManage, load]);
  useEffect(() => { if (canManage) loadPack(); }, [canManage, loadPack]);

  const sector = sectors.find((s) => s.id === sectorId) || null;

  // Everything a formula in this pack may legitimately name.
  const knownKeys = useMemo(
    () => [...definitions.map((d) => d.key), ...FINANCIAL_KEYS.map((f) => f.key)],
    [definitions],
  );

  const addSector = async () => {
    const label = newSector.trim();
    if (!label) return;
    setBusy(true);
    try {
      const key = label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
      const { data, error } = await supabase.from('kpi_sector')
        .insert({ key, label, sort_order: (sectors.length + 1) * 10, created_by: profile?.id || null })
        .select().single();
      if (error) throw error;
      setNewSector('');
      await load();
      setSectorId(data.id);
    } catch (e) { setMsg({ tone: 'error', text: String(e.message || e) }); }
    setBusy(false);
  };

  const addDimension = async () => {
    const label = newDimension.trim();
    if (!label || !sectorId) return;
    setBusy(true);
    try {
      const key = label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
      const { error } = await supabase.from('kpi_dimension')
        .insert({ sector_id: sectorId, key, label, sort_order: (dimensions.length + 1) * 10 });
      if (error) throw error;
      setNewDimension('');
      await loadPack();
    } catch (e) { setMsg({ tone: 'error', text: String(e.message || e) }); }
    setBusy(false);
  };

  const saveDefinition = async (draft) => {
    setBusy(true);
    setMsg(null);
    try {
      const row = {
        sector_id: sectorId,
        key: draft.key.trim(),
        label: draft.label.trim(),
        kind: draft.kind,
        unit: draft.unit,
        decimals: Number(draft.decimals) || 0,
        // The database insists: entry KPIs carry an aggregation, calculated ones
        // carry a formula, and never the other way round.
        aggregation: draft.kind === 'entry' ? draft.aggregation : null,
        formula: draft.kind === 'calculated' ? draft.formula.trim() : null,
        dimension_id: draft.dimension_id || null,
        hint: draft.hint?.trim() || null,
        show_on_overview: !!draft.show_on_overview,
        sort_order: Number(draft.sort_order) || 100,
        updated_at: new Date().toISOString(),
      };
      const { error } = draft.id
        ? await supabase.from('kpi_definition').update(row).eq('id', draft.id)
        : await supabase.from('kpi_definition').insert({ ...row, created_by: profile?.id || null });
      if (error) throw error;
      setEditing(null);
      await Promise.all([loadPack(), load()]);
      setMsg({ tone: 'success', text: `${row.label} saved. Every client on this pack sees it.` });
    } catch (e) {
      setMsg({
        tone: 'error',
        text: /duplicate|unique/i.test(e.message || '')
          ? 'Another KPI in this pack already uses that key.'
          : String(e.message || e),
      });
    }
    setBusy(false);
  };

  const removeDefinition = async (d) => {
    if (!window.confirm(
      `Delete "${d.label}" from the ${sector?.label} pack?\n\n`
      + `It disappears from every client on this pack, and any figures entered against it go with it.`,
    )) return;
    setBusy(true);
    try {
      await supabase.from('kpi_definition').delete().eq('id', d.id);
      await loadPack();
    } catch (e) { setMsg({ tone: 'error', text: String(e.message || e) }); }
    setBusy(false);
  };

  if (!canManage) {
    return (
      <div style={{ maxWidth: 720, margin: '0 auto', padding: '40px 24px', fontFamily: OUTFIT }}>
        <h1 style={{ fontFamily: "'Playfair Display', serif", fontSize: 28, fontWeight: 500, color: '#0f172a', marginBottom: 8 }}>
          KPI Packs
        </h1>
        <p style={{ fontSize: 14, color: '#64748b' }}>
          You need the KPI packs permission to edit these. A pack edit reaches every client in the
          sector, which is why it is held separately from entering one client's figures.
        </p>
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 1180, margin: '0 auto', padding: '32px 24px 60px', fontFamily: OUTFIT }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, marginBottom: 18 }}>
        <Layers size={26} style={{ color: '#38bdf8', marginTop: 4 }} />
        <div>
          <h1 style={{ fontFamily: "'Playfair Display', serif", fontSize: 28, fontWeight: 500, color: '#0f172a', margin: 0 }}>
            KPI Packs
          </h1>
          <p style={{ fontSize: 13.5, color: '#64748b', margin: '4px 0 0', maxWidth: 780, lineHeight: 1.6 }}>
            The KPIs a sector gets. Define occupancy once and every nursery has it; fix the formula
            here and every nursery is fixed. A client can hide one of these for itself, but cannot
            change it — that is what keeps the packs worth having.
          </p>
        </div>
      </div>

      {msg && (
        <div style={{
          marginBottom: 16, padding: '10px 14px', borderRadius: 10, fontSize: 13.5,
          backgroundColor: msg.tone === 'error' ? '#fef2f2' : '#f0fdf4',
          border: `1px solid ${msg.tone === 'error' ? '#fecaca' : '#bbf7d0'}`,
          color: msg.tone === 'error' ? '#991b1b' : '#166534',
        }}>
          {msg.text}
        </div>
      )}

      {loading && <p style={{ fontSize: 14, color: '#94a3b8' }}>Loading…</p>}

      {!loading && (
        <div style={{ display: 'flex', gap: 22, alignItems: 'flex-start', flexWrap: 'wrap' }}>
          {/* Sector list */}
          <div style={{ width: 250, flexShrink: 0 }}>
            <div style={{ ...cardStyle, padding: '14px 16px' }}>
              <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase', color: '#94a3b8', marginBottom: 8 }}>
                Sectors
              </div>
              {sectors.map((s) => (
                <button
                  key={s.id}
                  onClick={() => { setSectorId(s.id); setEditing(null); }}
                  style={{
                    display: 'block', width: '100%', textAlign: 'left', marginBottom: 4,
                    padding: '8px 10px', borderRadius: 9, cursor: 'pointer',
                    border: `1px solid ${s.id === sectorId ? '#7dd3fc' : 'transparent'}`,
                    backgroundColor: s.id === sectorId ? '#f0f9ff' : 'transparent',
                    fontFamily: OUTFIT,
                  }}
                >
                  <div style={{ fontSize: 13.5, fontWeight: s.id === sectorId ? 700 : 500, color: '#0f172a' }}>{s.label}</div>
                  <div style={{ fontSize: 11, color: '#94a3b8' }}>
                    {s.definition_count} KPI{s.definition_count === 1 ? '' : 's'} · {s.client_count} client{s.client_count === 1 ? '' : 's'}
                  </div>
                </button>
              ))}
              <div style={{ display: 'flex', gap: 6, marginTop: 10 }}>
                <input
                  value={newSector} onChange={(e) => setNewSector(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && addSector()}
                  placeholder="New sector…"
                  style={{ ...inputStyle, flex: 1, padding: '7px 9px', fontSize: 12.5 }}
                />
                <button onClick={addSector} disabled={busy || !newSector.trim()} style={iconAdd}>
                  <Plus size={14} />
                </button>
              </div>
            </div>
          </div>

          {/* The pack */}
          <div style={{ flex: 1, minWidth: 420 }}>
            {!sector && (
              <div style={{ ...cardStyle, color: '#64748b', fontSize: 14 }}>
                Add a sector to start a pack.
              </div>
            )}

            {sector && (
              <>
                <div style={{ ...cardStyle, marginBottom: 14 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                    <span style={{ fontSize: 16, fontWeight: 700, color: '#0f172a' }}>{sector.label}</span>
                    <span style={{ fontSize: 12, color: '#94a3b8' }}>
                      {sector.client_count} client{sector.client_count === 1 ? '' : 's'} on this pack
                    </span>
                    <button
                      onClick={() => setEditing(blankDef())}
                      style={{ ...primaryBtn, marginLeft: 'auto' }}
                    >
                      <Plus size={14} /> Add a KPI
                    </button>
                  </div>

                  <div style={{ marginTop: 14, paddingTop: 12, borderTop: '1px solid #f1f5f9' }}>
                    <div style={{ fontSize: 11.5, color: '#94a3b8', marginBottom: 6 }}>
                      Breakdowns — a KPI can be split by one of these. Each client then lists its own
                      (a nursery lists its rooms).
                    </div>
                    <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                      {dimensions.map((d) => (
                        <span key={d.id} style={chip}>{d.label}</span>
                      ))}
                      <input
                        value={newDimension} onChange={(e) => setNewDimension(e.target.value)}
                        onKeyDown={(e) => e.key === 'Enter' && addDimension()}
                        placeholder="Add a breakdown…"
                        style={{ ...inputStyle, padding: '6px 9px', fontSize: 12.5, width: 170 }}
                      />
                      <button onClick={addDimension} disabled={busy || !newDimension.trim()} style={iconAdd}>
                        <Plus size={14} />
                      </button>
                    </div>
                  </div>
                </div>

                {definitions.length === 0 && (
                  <div style={{ ...cardStyle, color: '#64748b', fontSize: 14 }}>
                    No KPIs in this pack yet.
                  </div>
                )}

                {definitions.map((d) => (
                  <DefinitionRow
                    key={d.id} def={d} dimensions={dimensions} knownKeys={knownKeys}
                    busy={busy}
                    onEdit={() => setEditing({ ...d, formula: d.formula || '', hint: d.hint || '' })}
                    onDelete={() => removeDefinition(d)}
                  />
                ))}
              </>
            )}
          </div>
        </div>
      )}

      {editing && (
        <DefinitionModal
          draft={editing} setDraft={setEditing} dimensions={dimensions}
          knownKeys={knownKeys.filter((k) => k !== editing.key)}
          definitions={definitions}
          busy={busy}
          onClose={() => setEditing(null)}
          onSave={saveDefinition}
        />
      )}
    </div>
  );
}

/* ─── One KPI in the list ──────────────────────────────────────── */
function DefinitionRow({ def, dimensions, knownKeys, busy, onEdit, onDelete }) {
  const dim = dimensions.find((x) => x.id === def.dimension_id);
  const check = def.kind === 'calculated' ? checkFormula(def.formula, knownKeys) : null;
  const agg = AGGREGATIONS.find((a) => a.key === def.aggregation);
  return (
    <div style={{ ...cardStyle, padding: '12px 16px', marginBottom: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 14, fontWeight: 700, color: '#0f172a' }}>{def.label}</span>
        <code style={{ fontSize: 11.5, color: '#64748b', backgroundColor: '#f8fafc', padding: '2px 7px', borderRadius: 6 }}>
          {def.key}
        </code>
        {def.show_on_overview && <span style={{ ...chip, color: '#0369a1', backgroundColor: '#f0f9ff', borderColor: '#bae6fd' }}>on Overview</span>}
        {dim && <span style={chip}>by {dim.label.toLowerCase()}</span>}
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
          <button onClick={onEdit} disabled={busy} style={smallBtn}>Edit</button>
          <button onClick={onDelete} disabled={busy} style={{ ...smallBtn, color: '#b91c1c', borderColor: '#fecaca' }}>
            <Trash2 size={12} />
          </button>
        </div>
      </div>
      <div style={{ fontSize: 12, color: '#64748b', marginTop: 5 }}>
        {def.kind === 'calculated' ? (
          <>
            <code style={{ fontSize: 12, color: check?.ok === false ? '#b91c1c' : '#0369a1' }}>{def.formula}</code>
            {check && !check.ok && (
              <span style={{ color: '#b91c1c', fontWeight: 600 }}> — {check.error}</span>
            )}
            <span style={{ color: '#94a3b8' }}> · recalculated from the totals at every level</span>
          </>
        ) : (
          <>Typed in · <strong style={{ fontWeight: 600 }}>{agg?.label || def.aggregation}</strong>
            <span style={{ color: '#94a3b8' }}> when showing quarters or years</span></>
        )}
      </div>
      {def.hint && <div style={{ fontSize: 11.5, color: '#94a3b8', marginTop: 3 }}>{def.hint}</div>}
    </div>
  );
}

/* ─── Editor ───────────────────────────────────────────────────── */
function DefinitionModal({ draft, setDraft, dimensions, knownKeys, definitions, busy, onClose, onSave }) {
  const set = (patch) => setDraft((d) => ({ ...d, ...patch }));
  const check = draft.kind === 'calculated' ? checkFormula(draft.formula, knownKeys) : { ok: true };
  const keyOk = /^[a-z][a-z0-9_]*$/.test(draft.key.trim());
  const valid = keyOk && draft.label.trim() && (draft.kind === 'entry' || check.ok);

  return (
    <div onClick={onClose} style={{
      position: 'fixed', inset: 0, backgroundColor: 'rgba(15,23,42,0.45)', zIndex: 70,
      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24,
    }}>
      <div onClick={(e) => e.stopPropagation()} style={{
        backgroundColor: '#fff', borderRadius: 16, width: '100%', maxWidth: 620,
        maxHeight: '88vh', overflowY: 'auto', fontFamily: OUTFIT,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '18px 22px', borderBottom: '1px solid #e5e7eb' }}>
          <span style={{ fontSize: 15.5, fontWeight: 700, color: '#0f172a' }}>
            {draft.id ? 'Edit KPI' : 'New KPI'}
          </span>
          <button onClick={onClose} style={{ marginLeft: 'auto', border: 'none', background: 'none', cursor: 'pointer', padding: 0 }}>
            <X size={18} style={{ color: '#94a3b8' }} />
          </button>
        </div>

        <div style={{ padding: '18px 22px', display: 'flex', flexDirection: 'column', gap: 15 }}>
          <div style={{ display: 'flex', gap: 12 }}>
            <label style={{ ...lbl, flex: 2 }}>
              Name
              <input value={draft.label} onChange={(e) => set({ label: e.target.value })}
                placeholder="Children attending" style={inputStyle} />
            </label>
            <label style={{ ...lbl, flex: 1 }}>
              Key
              <input value={draft.key} onChange={(e) => set({ key: e.target.value.toLowerCase() })}
                placeholder="children" style={{ ...inputStyle, fontFamily: 'ui-monospace, monospace' }} />
              <span style={{ ...hint, color: keyOk || !draft.key ? '#94a3b8' : '#b91c1c' }}>
                What formulas call it. Lower case, no spaces.
              </span>
            </label>
          </div>

          <div>
            <div style={lblText}>Where the figure comes from</div>
            <div style={{ display: 'flex', gap: 8, marginTop: 5 }}>
              {[
                { k: 'entry', t: 'Typed in', h: 'Somebody enters it each month, or a feed writes it.' },
                { k: 'calculated', t: 'Calculated', h: 'Worked out from other KPIs and the financials.' },
              ].map((o) => (
                <button key={o.k} onClick={() => set({ kind: o.k })} title={o.h}
                  style={{
                    flex: 1, textAlign: 'left', padding: '10px 12px', borderRadius: 10, cursor: 'pointer',
                    border: `1px solid ${draft.kind === o.k ? '#7dd3fc' : '#e5e7eb'}`,
                    backgroundColor: draft.kind === o.k ? '#f0f9ff' : '#fff', fontFamily: OUTFIT,
                  }}>
                  <div style={{ fontSize: 13, fontWeight: 700, color: '#0f172a' }}>{o.t}</div>
                  <div style={{ fontSize: 11, color: '#94a3b8', lineHeight: 1.4 }}>{o.h}</div>
                </button>
              ))}
            </div>
          </div>

          {draft.kind === 'calculated' ? (
            <label style={lbl}>
              Formula
              <input
                value={draft.formula} onChange={(e) => set({ formula: e.target.value })}
                placeholder="children / places * 100"
                style={{ ...inputStyle, fontFamily: 'ui-monospace, monospace',
                  borderColor: draft.formula && !check.ok ? '#fecaca' : '#e5e7eb' }}
              />
              {draft.formula && !check.ok && (
                <span style={{ ...hint, color: '#b91c1c', fontWeight: 600 }}>{check.error}</span>
              )}
              <span style={hint}>
                Recalculated from the totals at every level, so a quarter's percentage is the
                quarter's own sums — never the average of three monthly percentages.
              </span>
              <KeyPalette definitions={definitions} onPick={(k) => set({ formula: `${draft.formula}${k}` })} />
            </label>
          ) : (
            <label style={lbl}>
              Showing a quarter or a year
              <select value={draft.aggregation} onChange={(e) => set({ aggregation: e.target.value })} style={inputStyle}>
                {AGGREGATIONS.map((a) => <option key={a.key} value={a.key}>{a.label}</option>)}
              </select>
              <span style={hint}>
                {AGGREGATIONS.find((a) => a.key === draft.aggregation)?.hint}
                {' '}Get this wrong and the monthly view stays right while every other view quietly isn't.
              </span>
            </label>
          )}

          <div style={{ display: 'flex', gap: 12 }}>
            <label style={{ ...lbl, flex: 1 }}>
              Shown as
              <select value={draft.unit} onChange={(e) => set({ unit: e.target.value })} style={inputStyle}>
                {UNITS.map((u) => <option key={u.key} value={u.key}>{u.label}</option>)}
              </select>
            </label>
            <label style={{ ...lbl, width: 110 }}>
              Decimals
              <input type="number" min="0" max="4" value={draft.decimals}
                onChange={(e) => set({ decimals: e.target.value })} style={inputStyle} />
            </label>
            <label style={{ ...lbl, flex: 1 }}>
              Broken down by
              <select value={draft.dimension_id || ''} onChange={(e) => set({ dimension_id: e.target.value || null })} style={inputStyle}>
                <option value="">Not broken down</option>
                {dimensions.map((d) => <option key={d.id} value={d.id}>{d.label}</option>)}
              </select>
            </label>
          </div>

          <label style={lbl}>
            Note (optional)
            <input value={draft.hint} onChange={(e) => set({ hint: e.target.value })}
              placeholder="What it means, and where the figure comes from" style={inputStyle} />
          </label>

          <label style={{ display: 'flex', gap: 9, alignItems: 'flex-start', cursor: 'pointer' }}>
            <input type="checkbox" checked={!!draft.show_on_overview}
              onChange={(e) => set({ show_on_overview: e.target.checked })}
              style={{ width: 16, height: 16, marginTop: 2, accentColor: '#0f172a', cursor: 'pointer' }} />
            <span>
              <span style={{ fontSize: 13.5, fontWeight: 600, color: '#0f172a' }}>Show on the Overview</span>
              <span style={{ display: 'block', fontSize: 11.5, color: '#94a3b8' }}>
                As a tile beside revenue and profit, and with its own trend chart.
              </span>
            </span>
          </label>
        </div>

        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', padding: '14px 22px', borderTop: '1px solid #e5e7eb' }}>
          <button onClick={onClose} style={smallBtn}>Cancel</button>
          <button onClick={() => onSave(draft)} disabled={!valid || busy}
            style={{ ...primaryBtn, backgroundColor: valid && !busy ? '#0f172a' : '#cbd5e1' }}>
            <Check size={14} /> {busy ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}

// The keys a formula may name, so nobody has to remember them or guess at
// spelling — a mistyped key is the failure this whole editor exists to prevent.
function KeyPalette({ definitions, onPick }) {
  return (
    <div style={{ marginTop: 8 }}>
      <div style={{ fontSize: 11, color: '#94a3b8', marginBottom: 4 }}>KPIs in this pack</div>
      <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', marginBottom: 8 }}>
        {definitions.length === 0 && <span style={{ fontSize: 11.5, color: '#cbd5e1' }}>none yet</span>}
        {definitions.map((d) => (
          <button key={d.id} type="button" onClick={() => onPick(d.key)} style={pill} title={d.label}>{d.key}</button>
        ))}
      </div>
      <div style={{ fontSize: 11, color: '#94a3b8', marginBottom: 4 }}>From the accounts</div>
      <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
        {FINANCIAL_KEYS.map((f) => (
          <button key={f.key} type="button" onClick={() => onPick(f.key)} style={pill} title={f.label}>{f.key}</button>
        ))}
      </div>
    </div>
  );
}

/* ─── Styles ───────────────────────────────────────────────────── */
const lbl = { display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, fontWeight: 600, color: '#475569' };
const lblText = { fontSize: 12, fontWeight: 600, color: '#475569' };
const hint = { fontSize: 11.5, fontWeight: 400, color: '#94a3b8', lineHeight: 1.5 };
const chip = {
  fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 999,
  border: '1px solid #e5e7eb', backgroundColor: '#f8fafc', color: '#64748b',
};
const pill = {
  fontSize: 11, fontFamily: 'ui-monospace, monospace', padding: '3px 8px', borderRadius: 6,
  border: '1px solid #e5e7eb', backgroundColor: '#f8fafc', color: '#334155', cursor: 'pointer',
};
const smallBtn = {
  display: 'inline-flex', alignItems: 'center', gap: 5, border: '1px solid #e5e7eb',
  borderRadius: 8, padding: '6px 12px', background: '#fff', color: '#475569',
  fontFamily: OUTFIT, fontSize: 12.5, fontWeight: 600, cursor: 'pointer',
};
const primaryBtn = {
  display: 'inline-flex', alignItems: 'center', gap: 6, padding: '9px 17px',
  border: 'none', borderRadius: 10, backgroundColor: '#0f172a', color: '#fff',
  fontFamily: OUTFIT, fontSize: 13, fontWeight: 700, cursor: 'pointer',
};
const iconAdd = {
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
  border: '1px solid #e5e7eb', borderRadius: 8, padding: '7px 9px',
  background: '#fff', color: '#0369a1', cursor: 'pointer',
};
