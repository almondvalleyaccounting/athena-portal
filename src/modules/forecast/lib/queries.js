// Supabase queries for the forecast engine.

import { supabase } from '../../../lib/supabase';

export async function listForecasts() {
  const { data, error } = await supabase
    .from('fc_forecast')
    .select('*')
    .order('updated_at', { ascending: false });
  if (error) throw error;
  return data || [];
}

export async function createForecast({ name, client_name, vertical_pack, horizon_months = 60, opening_period }) {
  const { data: forecast, error } = await supabase
    .from('fc_forecast')
    .insert({ name, client_name: client_name || null, vertical_pack, horizon_months, opening_period })
    .select().single();
  if (error) throw error;

  // Create the working version + base scenario in one go
  const { data: version, error: vErr } = await supabase
    .from('fc_version')
    .insert({ forecast_id: forecast.id, name: 'Working', kind: 'working' })
    .select().single();
  if (vErr) throw vErr;

  const { data: scenario, error: sErr } = await supabase
    .from('fc_scenario')
    .insert({ version_id: version.id, name: 'Base', kind: 'base' })
    .select().single();
  if (sErr) throw sErr;

  return { forecast, version, scenario };
}

export async function getForecast(id) {
  const { data, error } = await supabase
    .from('fc_forecast').select('*').eq('id', id).single();
  if (error) throw error;
  return data;
}

export async function updateForecast(id, patch) {
  // Allowed editable fields. Horizon shrinking is permitted but stale
  // outputs/findings beyond the new horizon are cleaned up first.
  const next = {};
  if (patch.name !== undefined) next.name = patch.name;
  if (patch.client_name !== undefined) next.client_name = patch.client_name || null;
  if (patch.horizon_months !== undefined) next.horizon_months = Number(patch.horizon_months);
  if (patch.opening_period !== undefined) next.opening_period = patch.opening_period;

  if (next.horizon_months != null) {
    // Drop outputs / findings beyond the new horizon (period >= horizon).
    // Get the version+scenario list for this forecast first.
    const { data: versions } = await supabase.from('fc_version').select('id').eq('forecast_id', id);
    const vids = (versions || []).map(v => v.id);
    if (vids.length > 0) {
      const { data: scenarios } = await supabase.from('fc_scenario').select('id').in('version_id', vids);
      const sids = (scenarios || []).map(s => s.id);
      if (sids.length > 0) {
        await supabase.from('fc_output').delete().in('scenario_id', sids).gte('period', next.horizon_months);
        await supabase.from('fc_finding').delete().in('scenario_id', sids).gte('period', next.horizon_months);
      }
    }
  }

  const { data, error } = await supabase
    .from('fc_forecast').update(next).eq('id', id).select().single();
  if (error) throw error;
  return data;
}

export async function listVersions(forecast_id) {
  const { data, error } = await supabase
    .from('fc_version').select('*')
    .eq('forecast_id', forecast_id)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data || [];
}

export async function listScenarios(version_id) {
  const { data, error } = await supabase
    .from('fc_scenario').select('*')
    .eq('version_id', version_id)
    .order('kind').order('name');
  if (error) throw error;
  return data || [];
}

export async function listEntities(forecast_id) {
  const { data, error } = await supabase
    .from('fc_entity').select('*')
    .eq('forecast_id', forecast_id)
    .order('sort_order').order('label');
  if (error) throw error;
  return data || [];
}

export async function upsertEntity(row) {
  const { data, error } = await supabase
    .from('fc_entity').upsert(row, { onConflict: 'forecast_id,key' })
    .select().single();
  if (error) throw error;
  return data;
}

/**
 * Load drivers and values for a scenario, with fallback to the base
 * scenario for any (entity_id, module_key, driver_key) not overridden.
 */
export async function loadDriversWithFallback(version_id, scenario_id, base_scenario_id) {
  const ids = scenario_id === base_scenario_id ? [base_scenario_id] : [scenario_id, base_scenario_id];
  const { data: drivers, error } = await supabase
    .from('fc_driver').select('*')
    .in('scenario_id', ids);
  if (error) throw error;

  // Override resolution: prefer scenario_id row over base_scenario_id row for the same triple
  const triple = (d) => `${d.entity_id || ''}::${d.module_key}::${d.driver_key}`;
  const map = new Map();
  for (const d of drivers || []) {
    const t = triple(d);
    const existing = map.get(t);
    if (!existing) map.set(t, d);
    else if (existing.scenario_id !== scenario_id && d.scenario_id === scenario_id) map.set(t, d);
  }
  const merged = Array.from(map.values());

  const driverIds = merged.map(d => d.id);
  let values = [];
  if (driverIds.length > 0) {
    const { data: vs, error: vErr } = await supabase
      .from('fc_driver_value').select('*').in('driver_id', driverIds);
    if (vErr) throw vErr;
    values = vs || [];
  }
  return { drivers: merged, values };
}

export async function upsertDriver(row) {
  const { data, error } = await supabase
    .from('fc_driver')
    .upsert(row, { onConflict: 'scenario_id,entity_id,module_key,driver_key' })
    .select().single();
  if (error) throw error;
  return data;
}

export async function setDriverValue(driver_id, period, value) {
  const { error } = await supabase
    .from('fc_driver_value')
    .upsert({ driver_id, period: period ?? -1, value }, { onConflict: 'driver_id,period' });
  if (error) throw error;
}

/** Replace materialised outputs for a scenario. */
export async function persistOutputs(scenario_id, outputs) {
  // Delete existing rows for this scenario, then insert fresh.
  const { error: delErr } = await supabase
    .from('fc_output').delete().eq('scenario_id', scenario_id);
  if (delErr) throw delErr;

  if (outputs.length === 0) return;

  const rows = outputs.map(o => ({
    scenario_id,
    entity_id: o.entity_id || null,
    period: o.period,
    module_key: o.module_key,
    nominal_type: o.nominal_type,
    line_label: o.line_label,
    amount_p: o.amount_p,
    tags: o.tags || null,
  }));

  // Chunk to avoid hitting row-size limits on big forecasts
  const CHUNK = 500;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const { error } = await supabase.from('fc_output').insert(rows.slice(i, i + CHUNK));
    if (error) throw error;
  }
}

export async function persistFindings(scenario_id, findings) {
  const { error: delErr } = await supabase
    .from('fc_finding').delete().eq('scenario_id', scenario_id);
  if (delErr) throw delErr;
  if (findings.length === 0) return;
  const rows = findings.map(f => ({
    scenario_id,
    entity_id: f.entity_id || null,
    period: f.period ?? null,
    severity: f.severity,
    code: f.code,
    message: f.message,
  }));
  const { error } = await supabase.from('fc_finding').insert(rows);
  if (error) throw error;
}

export async function loadOutputs(scenario_id) {
  // Supabase JS defaults to a 1000-row response cap. Forecast output
  // tables routinely exceed this (e.g. 84mo × 10 modules ≈ 5k rows),
  // so paginate via .range() until exhausted.
  const PAGE = 1000;
  const all = [];
  let from = 0;
  while (true) {
    const { data, error } = await supabase
      .from('fc_output').select('*').eq('scenario_id', scenario_id)
      .order('period').order('nominal_type')
      .range(from, from + PAGE - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    all.push(...data);
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return all;
}

export async function loadFindings(scenario_id) {
  const { data, error } = await supabase
    .from('fc_finding').select('*').eq('scenario_id', scenario_id)
    .order('severity');
  if (error) throw error;
  return data || [];
}

export async function listLaCouncils() {
  const { data, error } = await supabase
    .from('fc_la_council').select('*').order('name');
  if (error) throw error;
  return data || [];
}

/**
 * Load LA reference data (NDR, top-up, funded rates) for a given year.
 * Returns one row per council with embedded rate breakdown.
 */
export async function listLaReference(period_year = 2026) {
  const [councilRes, ndrRes, topupRes, rateRes] = await Promise.all([
    supabase.from('fc_la_council').select('*').order('name'),
    supabase.from('fc_la_ndr').select('*').eq('period_year', period_year),
    supabase.from('fc_la_topup').select('*'),
    supabase.from('fc_la_funded_rate').select('*').eq('period_year', period_year),
  ]);
  if (councilRes.error) throw councilRes.error;
  if (ndrRes.error) throw ndrRes.error;
  if (topupRes.error) throw topupRes.error;
  if (rateRes.error) throw rateRes.error;
  const ndrByLa = Object.fromEntries((ndrRes.data || []).map(r => [r.la_council_id, r]));
  const topupByLa = Object.fromEntries((topupRes.data || []).map(r => [r.la_council_id, r]));
  const ratesByLa = {};
  for (const r of (rateRes.data || [])) {
    (ratesByLa[r.la_council_id] ||= {})[r.age_band] = r;
  }
  return (councilRes.data || []).map(c => ({
    council: c,
    ndr: ndrByLa[c.id] || null,
    topup: topupByLa[c.id] || null,
    rates: ratesByLa[c.id] || {},
  }));
}

export async function upsertLaNdr({ la_council_id, period_year, poundage, small_business_relief_pct }) {
  const { error } = await supabase.from('fc_la_ndr')
    .upsert({ la_council_id, period_year, poundage, small_business_relief_pct }, { onConflict: 'la_council_id,period_year' });
  if (error) throw error;
}

export async function upsertLaTopup({ la_council_id, topup_allowed, notes }) {
  const { error } = await supabase.from('fc_la_topup')
    .upsert({ la_council_id, topup_allowed, notes: notes ?? null }, { onConflict: 'la_council_id' });
  if (error) throw error;
}

export async function upsertLaFundedRate({ la_council_id, period_year, age_band, hourly_rate_p }) {
  const { error } = await supabase.from('fc_la_funded_rate')
    .upsert({ la_council_id, period_year, age_band, hourly_rate_p },
      { onConflict: 'la_council_id,period_year,age_band' });
  if (error) throw error;
}

/**
 * Drivers + values for a particular (scenario, module, entity) context.
 * If `entity_id` is given, returns BOTH that entity's drivers AND any
 * group-scope drivers (entity_id IS NULL) for the same module — because
 * the compute fn typically reads both.
 */
export async function loadDriversForContext({ scenario_id, module_key, entity_id }) {
  let q = supabase.from('fc_driver').select('*')
    .eq('scenario_id', scenario_id).eq('module_key', module_key);
  if (entity_id) {
    // Either match this entity OR group-scope (NULL).
    q = q.or(`entity_id.eq.${entity_id},entity_id.is.null`);
  } else {
    q = q.is('entity_id', null);
  }
  const { data: drivers, error } = await q.order('driver_key');
  if (error) throw error;
  const ids = (drivers || []).map(d => d.id);
  let values = [];
  if (ids.length > 0) {
    const { data, error: vErr } = await supabase
      .from('fc_driver_value').select('*').in('driver_id', ids);
    if (vErr) throw vErr;
    values = data || [];
  }
  return { drivers: drivers || [], values };
}

// ── Loans ───────────────────────────────────────────────────────

export async function listLoans(scenario_id) {
  const { data, error } = await supabase
    .from('fc_loan').select('*').eq('scenario_id', scenario_id)
    .order('sort_order').order('created_at');
  if (error) throw error;
  return data || [];
}

export async function upsertLoan(row) {
  const op = row.id
    ? supabase.from('fc_loan').update(row).eq('id', row.id).select().single()
    : supabase.from('fc_loan').insert(row).select().single();
  const { data, error } = await op;
  if (error) throw error;
  return data;
}

export async function deleteLoan(id) {
  const { error } = await supabase.from('fc_loan').delete().eq('id', id);
  if (error) throw error;
}

// ── Groups (using the generic dimension/dimension_value system) ─────

const GROUP_DIM_KEY = 'group';

/**
 * Ensure the "Group" dimension exists for this forecast and return it.
 * Idempotent — creates only if missing.
 */
export async function ensureGroupDimension(forecast_id) {
  const { data: existing } = await supabase
    .from('fc_dimension').select('*')
    .eq('forecast_id', forecast_id).eq('key', GROUP_DIM_KEY).maybeSingle();
  if (existing) return existing;
  const { data, error } = await supabase
    .from('fc_dimension')
    .insert({ forecast_id, key: GROUP_DIM_KEY, label: 'Group' })
    .select().single();
  if (error) throw error;
  return data;
}

export async function listGroups(forecast_id) {
  const dim = await ensureGroupDimension(forecast_id);
  const { data, error } = await supabase
    .from('fc_dimension_value').select('*').eq('dimension_id', dim.id).order('label');
  if (error) throw error;
  return { dimension: dim, groups: data || [] };
}

export async function createGroup(forecast_id, label) {
  const dim = await ensureGroupDimension(forecast_id);
  const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
  const { data, error } = await supabase
    .from('fc_dimension_value')
    .insert({ dimension_id: dim.id, key: slug || 'group_' + Date.now().toString(36).slice(-4), label })
    .select().single();
  if (error) throw error;
  return data;
}

export async function deleteGroup(group_id) {
  const { error } = await supabase.from('fc_dimension_value').delete().eq('id', group_id);
  if (error) throw error;
}

export async function listEntityGroupAssignments(forecast_id) {
  // Returns rows: { entity_id, dimension_value_id }
  const { data, error } = await supabase
    .from('fc_entity_tag')
    .select('entity_id, dimension_value_id, fc_dimension_value!inner(dimension_id, fc_dimension!inner(forecast_id, key))')
    .eq('fc_dimension_value.fc_dimension.forecast_id', forecast_id)
    .eq('fc_dimension_value.fc_dimension.key', GROUP_DIM_KEY);
  if (error) throw error;
  return (data || []).map(r => ({ entity_id: r.entity_id, dimension_value_id: r.dimension_value_id }));
}

export async function assignEntityToGroup(entity_id, group_value_id) {
  // Remove any existing group tag for this entity (one group per entity), then insert.
  // Find all dimension_value_ids in the "group" dimension for THIS entity's forecast.
  const { data: ent, error: e1 } = await supabase
    .from('fc_entity').select('forecast_id').eq('id', entity_id).single();
  if (e1) throw e1;
  const dim = await ensureGroupDimension(ent.forecast_id);
  const { data: vals, error: e2 } = await supabase
    .from('fc_dimension_value').select('id').eq('dimension_id', dim.id);
  if (e2) throw e2;
  const ids = (vals || []).map(v => v.id);
  if (ids.length > 0) {
    await supabase.from('fc_entity_tag')
      .delete().eq('entity_id', entity_id).in('dimension_value_id', ids);
  }
  if (group_value_id) {
    const { error } = await supabase.from('fc_entity_tag')
      .insert({ entity_id, dimension_value_id: group_value_id });
    if (error) throw error;
  }
}

export async function deleteEntity(id) {
  const { error } = await supabase.from('fc_entity').delete().eq('id', id);
  if (error) throw error;
}

/**
 * Seed pack defaults — fill in MISSING drivers and missing values.
 *
 * Behaviour:
 *   - Driver rows: upserted (idempotent via unique key).
 *   - Driver values: ONLY set if no value row exists yet for that
 *     (driver, period) pair. Existing user-entered values are preserved.
 *
 * For destructive reset to defaults, callers should pass `{ overwrite: true }`.
 *
 * Returns counts of {created drivers, valued, skipped (already had values)}.
 */
export async function seedPackDefaults({ scenario_id, modules, entities, overwrite = false }) {
  let created = 0, valued = 0, skipped = 0;

  // Pre-fetch all existing driver_value rows for this scenario so we can
  // check existence without a per-driver round-trip.
  const { data: existingDrivers, error: dErr } = await supabase
    .from('fc_driver').select('id').eq('scenario_id', scenario_id);
  if (dErr) throw dErr;
  const existingIds = (existingDrivers || []).map(d => d.id);

  let existingValueKeys = new Set();
  if (existingIds.length > 0) {
    const PAGE = 1000;
    for (let i = 0; i < existingIds.length; i += PAGE) {
      const slice = existingIds.slice(i, i + PAGE);
      const { data, error } = await supabase
        .from('fc_driver_value').select('driver_id, period').in('driver_id', slice);
      if (error) throw error;
      for (const v of data || []) existingValueKeys.add(`${v.driver_id}::${v.period}`);
    }
  }

  for (const mod of modules) {
    for (const def of (mod.drivers || [])) {
      const targets = def.scope === 'entity'
        ? entities.map(e => ({ entity_id: e.id }))
        : [{ entity_id: null }];
      for (const tgt of targets) {
        const row = {
          scenario_id, entity_id: tgt.entity_id,
          module_key: mod.key, driver_key: def.key,
          label: def.label, unit: def.unit, kind: def.kind,
          expression: def.defaultExpression || null,
        };
        const driver = await upsertDriver(row);
        created += 1;

        if (def.kind === 'scalar' && def.defaultValue != null) {
          const k = `${driver.id}::-1`;
          if (!overwrite && existingValueKeys.has(k)) { skipped += 1; continue; }
          await setDriverValue(driver.id, -1, def.defaultValue);
          existingValueKeys.add(k);
          valued += 1;
        } else if (def.kind === 'timeseries' && Array.isArray(def.defaultValue)) {
          for (let t = 0; t < def.defaultValue.length; t++) {
            const k = `${driver.id}::${t}`;
            if (!overwrite && existingValueKeys.has(k)) { skipped += 1; continue; }
            await setDriverValue(driver.id, t, def.defaultValue[t]);
            existingValueKeys.add(k);
            valued += 1;
          }
        }
      }
    }
  }
  return { created, valued, skipped };
}

/**
 * Load all drivers + values for a scenario into a single shape suitable
 * for the inputs UI. Doesn't merge with base — returns just this scenario's
 * direct rows so the UI can show overrides distinctly later.
 */
export async function loadScenarioDrivers(scenario_id) {
  const { data: drivers, error } = await supabase
    .from('fc_driver').select('*').eq('scenario_id', scenario_id);
  if (error) throw error;
  const ids = (drivers || []).map(d => d.id);
  let values = [];
  if (ids.length > 0) {
    const { data: vs, error: vErr } = await supabase
      .from('fc_driver_value').select('*').in('driver_id', ids);
    if (vErr) throw vErr;
    values = vs || [];
  }
  return { drivers: drivers || [], values };
}
