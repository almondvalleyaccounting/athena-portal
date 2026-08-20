import { useState, useEffect, useMemo, useCallback } from 'react';
import { supabase } from '../../lib/supabase';

/*
  One client's KPI configuration and figures, loaded once for the page.

  The Overview tiles, the KPI tab and any custom report all read this, for the
  same reason the owner-cost configuration is held once (see useUnderlyingConfig):
  three independent copies would disagree the moment somebody typed a figure on
  one of them.

  `definitions` comes from kpi_definitions_for_entity(), which is the only place
  that resolves sector pack + bespoke − hidden. Nothing here re-implements that
  rule.
*/

export function useKpiData(entityId) {
  const [definitions, setDefinitions] = useState([]);
  const [dimensionValues, setDimensionValues] = useState([]);
  const [values, setValues] = useState([]);
  const [sectors, setSectors] = useState([]);
  const [sectorId, setSectorId] = useState(null);
  const [hiddenOverrides, setHiddenOverrides] = useState([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    if (!entityId) {
      setDefinitions([]); setDimensionValues([]); setValues([]); setSectorId(null); setHiddenOverrides([]);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const [defs, dims, vals, ent, secs, hid] = await Promise.all([
        supabase.rpc('kpi_definitions_for_entity', { p_entity_id: entityId }),
        supabase.from('kpi_dimension_value').select('*').eq('entity_id', entityId).order('sort_order'),
        // Figures are small — one client, a handful of KPIs, a few years of
        // months. No paging needed, but keep the ceiling explicit so a runaway
        // never silently truncates (PostgREST caps at ~1000 by default).
        supabase.from('kpi_value').select('*').eq('entity_id', entityId).limit(20000),
        supabase.from('entities').select('kpi_sector_id').eq('id', entityId).maybeSingle(),
        supabase.rpc('kpi_sectors_with_counts'),
        // Hidden pack KPIs. They are absent from `definitions` by design, so
        // without this there would be no way to find them again.
        supabase.from('kpi_client_override')
          .select('definition_id, is_hidden, kpi_definition(label, kind)')
          .eq('entity_id', entityId).eq('is_hidden', true),
      ]);
      if (defs.error) throw defs.error;
      setDefinitions(defs.data || []);
      setDimensionValues(dims.data || []);
      setValues(vals.data || []);
      setSectorId(ent.data?.kpi_sector_id || null);
      setSectors(secs.data || []);
      setHiddenOverrides((hid.data || []).map((h) => ({
        definition_id: h.definition_id,
        label: h.kpi_definition?.label || 'A hidden KPI',
      })));
    } catch (e) {
      setError(e.message || 'Could not load KPIs.');
    }
    setLoading(false);
  }, [entityId]);

  useEffect(() => { load(); }, [load]);

  /* ── Writes ─────────────────────────────────────────────────── */
  // One figure. Blank clears it. The RPC handles the override flag so a later
  // import cannot quietly undo a correction.
  const setValue = useCallback(async (definitionId, period, dimensionValueId, value) => {
    if (!entityId) return;
    const n = value === '' || value === null || value === undefined ? null : Number(value);
    if (n !== null && Number.isNaN(n)) return;

    // Optimistic, because a grid that lags a keystroke is a grid nobody uses.
    setValues((prev) => {
      const rest = prev.filter((v) => !(
        v.definition_id === definitionId
        && String(v.period).slice(0, 7) === String(period).slice(0, 7)
        && (v.dimension_value_id || null) === (dimensionValueId || null)
      ));
      if (n === null) return rest;
      return [...rest, {
        id: `tmp-${definitionId}-${period}-${dimensionValueId || 'x'}`,
        entity_id: entityId, definition_id: definitionId,
        period: `${String(period).slice(0, 7)}-01`,
        dimension_value_id: dimensionValueId || null,
        value: n, source: 'manual',
      }];
    });

    try {
      const { error: e } = await supabase.rpc('kpi_set_value', {
        p_entity_id: entityId,
        p_definition_id: definitionId,
        p_period: `${String(period).slice(0, 7)}-01`,
        p_dimension_value_id: dimensionValueId || null,
        p_value: n,
      });
      if (e) throw e;
    } catch (e) {
      setError(e.message || 'That figure did not save.');
      load();   // put the grid back to what the database actually holds
    }
  }, [entityId, load]);

  const setSector = useCallback(async (id) => {
    if (!entityId) return;
    setBusy(true);
    try {
      const { error: e } = await supabase.rpc('set_entity_kpi_sector', {
        p_entity_id: entityId, p_sector_id: id || null,
      });
      if (e) throw e;
      await load();
    } catch (e) { setError(e.message); }
    setBusy(false);
  }, [entityId, load]);

  const addDimensionValue = useCallback(async (dimensionId, label) => {
    if (!entityId || !label?.trim()) return;
    setBusy(true);
    try {
      const key = label.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
      const { error: e } = await supabase.from('kpi_dimension_value').insert({
        dimension_id: dimensionId, entity_id: entityId,
        key: key || `v${Date.now()}`, label: label.trim(),
        sort_order: (dimensionValues.filter((d) => d.dimension_id === dimensionId).length + 1) * 10,
      });
      if (e) throw e;
      await load();
    } catch (e) { setError(e.message); }
    setBusy(false);
  }, [entityId, dimensionValues, load]);

  const removeDimensionValue = useCallback(async (id) => {
    setBusy(true);
    try {
      await supabase.from('kpi_dimension_value').delete().eq('id', id);
      await load();
    } catch (e) { setError(e.message); }
    setBusy(false);
  }, [load]);

  // Hide or restore a pack KPI for this client, without touching the pack.
  const setHidden = useCallback(async (definitionId, hidden) => {
    if (!entityId) return;
    setBusy(true);
    try {
      const { error: e } = await supabase.from('kpi_client_override').upsert({
        entity_id: entityId, definition_id: definitionId, is_hidden: hidden,
      }, { onConflict: 'entity_id,definition_id' });
      if (e) throw e;
      await load();
    } catch (e) { setError(e.message); }
    setBusy(false);
  }, [entityId, load]);

  const dimensionsInUse = useMemo(() => {
    const seen = new Map();
    for (const d of definitions) {
      if (d.dimension_id && !seen.has(d.dimension_id)) {
        seen.set(d.dimension_id, { id: d.dimension_id, key: d.dimension_key, label: d.dimension_label });
      }
    }
    return [...seen.values()];
  }, [definitions]);

  const entryDefinitions = useMemo(
    () => definitions.filter((d) => d.kind === 'entry'),
    [definitions],
  );

  return {
    definitions, entryDefinitions, dimensionValues, dimensionsInUse, values, hiddenOverrides,
    sectors, sectorId, loading, busy, error, clearError: () => setError(null),
    reload: load, setValue, setSector, addDimensionValue, removeDimensionValue, setHidden,
  };
}
