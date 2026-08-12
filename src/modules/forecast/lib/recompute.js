// Orchestrator: load context, run the engine, persist outputs + findings.

import {
  getForecast, listEntities, listScenarios, listVersions,
  loadDriversWithFallback, persistOutputs, persistFindings,
  listLoans, listPlLines,
} from './queries.js';
import { modulesFor } from './packs.js';
import { runForecast } from './engine.js';

export async function recomputeScenario({ forecast_id, version_id, scenario_id }) {
  const [forecast, entities, scenarios, loans, plLines] = await Promise.all([
    getForecast(forecast_id),
    listEntities(forecast_id),
    listScenarios(version_id),
    listLoans(scenario_id),
    listPlLines(scenario_id),
  ]);

  const base = scenarios.find(s => s.kind === 'base');
  if (!base) throw new Error('No base scenario found for this version');

  const { drivers, values } = await loadDriversWithFallback(version_id, scenario_id, base.id);

  // Annotate drivers with entity_key for resolver convenience
  const entityById = new Map(entities.map(e => [e.id, e]));
  for (const d of drivers) {
    if (d.entity_id) d.entity_key = entityById.get(d.entity_id)?.key;
  }

  const modules = modulesFor(forecast.vertical_pack);

  const { outputs, findings } = runForecast({
    forecast,
    modules,
    entities,
    drivers,
    driverValues: values,
    loans,
    plLines,
  });

  // Materialise
  await persistOutputs(scenario_id, outputs);
  await persistFindings(scenario_id, findings);

  return { outputs, findings, modules };
}
