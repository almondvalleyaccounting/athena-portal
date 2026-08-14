// A location's timeline. Costs start at different points along it, and
// getting them wrong is the difference between a fit-out you paid for and
// one you got free.
//
//   ACCESS     lease signed, building available. Not yet a cost date in the
//              model — fit-out capex is placed relative to opening.
//   OCCUPANCY  you hold the building: service charge, rates, maintenance,
//              premises insurance and the pre-opening programme all start.
//   OPENING    you trade: fee income, staff on the floor, and the variable
//              costs of running a setting.
//
// Occupancy defaults to opening, so a location that never sets it behaves
// exactly as it did before the field existed. It can never fall after
// opening — you cannot open a building you have not taken.

export function openingMonth(cfg) {
  return cfg?.opening_month_offset ?? 0;
}

export function occupancyMonth(cfg) {
  const opening = openingMonth(cfg);
  const occ = cfg?.occupancy_month_offset;
  return occ == null ? opening : Math.min(occ, opening);
}

/**
 * Does this cost belong to the building rather than to trading?
 *
 * Drives two things that must agree: which overhead lines start at occupancy
 * rather than opening, and which land in the premises bucket of the P&L and
 * cashflow. financial_core and aggregator both bucket on the same rule.
 */
export function isPremisesCost(label) {
  const l = String(label || '');
  return l === 'Rent' || l === 'Service charge' || l === 'NDR' || l === 'Maintenance'
    || /^premises\b/i.test(l);
}
