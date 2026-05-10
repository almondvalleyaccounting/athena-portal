// Staff costs detail.
// Layout: rows = roles in management → direct order; columns grouped by
// metric (Headcount / Cost / Cost per headcount), each group split by
// time period.

import React, { useEffect, useMemo, useState } from 'react';
import { colors, fmtP, fontStack, H2 } from '../components/ui';
import LocationFilter, { resolveFilterToEntityIds, filterLabel } from '../components/LocationFilter';
import { loadDriversForContext } from '../lib/queries';

// Row order requested by user. Each row is one role bucket; tags.role on
// the upstream rows is the matching key.
const ROWS = [
  // Indirect / management
  { role: 'executive',         label: 'Executives',          group: 'mgmt' },
  { role: 'senior_manager',    label: 'Senior managers',     group: 'mgmt' },
  { role: 'admin',             label: 'Admin',               group: 'mgmt' },
  // Setting-level
  { role: 'setting_manager',   label: 'Setting managers',    group: 'setting' },
  { role: 'assistant_manager', label: 'Assistant managers',  group: 'setting' },
  // Direct
  { role: 'senior_qualified',  label: 'Senior qualified',    group: 'direct' },
  { role: 'qualified',         label: 'Qualified',           group: 'direct' },
  { role: 'apprentice',        label: 'Apprentices',         group: 'direct' },
];

const TOTAL_MGMT_AFTER = 'admin';   // emit a "Total management costs" subtotal after the admin row

export default function StaffCostsView({
  outputs, forecast, periods, scenarioId,
  entities = [], groups = [], assignments = [],
  filter, onFilterChange,
}) {
  const [granularity, setGranularity] = useState('annual');
  const [staffDrivers, setStaffDrivers] = useState({ drivers: [], values: [] });

  // Load staff drivers once for the rate / cost analysis boxes.
  useEffect(() => {
    let cancelled = false;
    if (!scenarioId) return;
    (async () => {
      try {
        const r = await loadDriversForContext({ scenario_id: scenarioId, module_key: 'staff', entity_id: null });
        if (!cancelled) setStaffDrivers(r);
      } catch (e) { /* silent — boxes show as empty */ }
    })();
    return () => { cancelled = true; };
  }, [scenarioId]);

  const entityIds = useMemo(() => resolveFilterToEntityIds(filter, entities, assignments),
    [filter, entities, assignments]);
  const grouped = groupPeriods(periods, granularity);
  const inScope = (r) => !entityIds || r.entity_id == null || entityIds.has(r.entity_id);

  // For each role × period group: aggregate cost and end-of-period headcount.
  const matrix = useMemo(() => {
    const m = {};
    for (const row of ROWS) m[row.role] = grouped.map(() => ({ cost: 0, hc: 0 }));

    for (const g of grouped) {
      const periodSet = new Set(g.periods);
      const maxP = Math.max(...g.periods);

      for (const r of outputs) {
        if (r.nominal_type !== 'staff_cost') continue;
        if (!periodSet.has(r.period)) continue;
        if (!inScope(r)) continue;
        const role = r.tags?.role;
        if (!role || !m[role]) continue;
        // Cost: sum across periods in group
        m[role][grouped.indexOf(g)].cost += r.amount_p;
        // Headcount: snapshot at last period in group
        if (r.period === maxP) {
          m[role][grouped.indexOf(g)].hc += Number(r.tags?.headcount) || 0;
        }
      }
    }
    return m;
  }, [outputs, grouped, entityIds]);

  // Total management = exec + senior_manager + admin
  // Total setting = setting_mgr + asst_mgr
  // Total direct = senior_qual + qualified + apprentice
  const subtotal = (roles) => grouped.map((g, i) =>
    roles.reduce((acc, role) => ({
      cost: acc.cost + (matrix[role]?.[i]?.cost || 0),
      hc: acc.hc + (matrix[role]?.[i]?.hc || 0),
    }), { cost: 0, hc: 0 })
  );

  const mgmtSubtotal = subtotal(['executive', 'senior_manager', 'admin']);
  const settingSubtotal = subtotal(['setting_manager', 'assistant_manager']);
  const directSubtotal = subtotal(['senior_qualified', 'qualified', 'apprentice']);
  const grand = grouped.map((g, i) => ({
    cost: mgmtSubtotal[i].cost + settingSubtotal[i].cost + directSubtotal[i].cost,
    hc: mgmtSubtotal[i].hc + settingSubtotal[i].hc + directSubtotal[i].hc,
  }));

  // Annualisation factor for cost-per-head (so monthly view shows monthly £, annual shows annual £)
  const annualise = (months) => 12 / Math.max(1, months);

  const fmt = (v) => fmtP(v, { compact: true });
  const fmtHC = (v) => v > 0 ? Math.round(v).toLocaleString('en-GB') : '—';
  const cph = (cost, hc, months) => hc > 0 ? cost * annualise(months) / hc : null;
  const fmtCph = (v) => v == null ? '—' : '£' + Math.round(v / 100).toLocaleString('en-GB');

  const renderRow = (label, vals, opts = {}) => (
    <tr style={{
      borderBottom: `1px solid ${colors.borderSoft}`,
      background: opts.subtotal ? colors.bgSoft : (opts.indent ? '#fdfdfd' : '#fff'),
      fontWeight: opts.subtotal || opts.total ? 700 : 400,
      ...(opts.total ? { background: '#0f172a', color: '#fff' } : {}),
    }}>
      <td style={{ ...td, paddingLeft: opts.indent ? 22 : 10, color: opts.total ? '#fff' : colors.ink }}>
        {label}
      </td>
      {/* Headcount group */}
      {vals.map((v, i) => (
        <td key={`h${i}`} style={{ ...tdR, color: opts.total ? '#fff' : colors.ink }}>
          {fmtHC(v.hc)}
        </td>
      ))}
      {/* Cost group */}
      {vals.map((v, i) => (
        <td key={`c${i}`} style={{ ...tdR, color: opts.total ? '#fff' : colors.ink }}>
          {fmt(v.cost)}
        </td>
      ))}
      {/* Cost per head group */}
      {vals.map((v, i) => (
        <td key={`p${i}`} style={{ ...tdR, color: opts.total ? '#fff' : (colors.muted) }}>
          {fmtCph(cph(v.cost, v.hc, grouped[i].periods.length))}
        </td>
      ))}
    </tr>
  );

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12, flexWrap: 'wrap', gap: 12 }}>
        <H2>
          Staff costs <span style={{ fontSize: 13, fontWeight: 400, color: colors.muted, marginLeft: 8 }}>· {filterLabel(filter, entities, groups)}</span>
        </H2>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          {onFilterChange && (
            <LocationFilter entities={entities} groups={groups} assignments={assignments} value={filter} onChange={onFilterChange} />
          )}
          <div style={{ display: 'flex', gap: 4, fontSize: 11 }}>
            {['monthly', 'quarterly', 'annual'].map(g => (
              <button key={g} onClick={() => setGranularity(g)}
                style={{
                  padding: '5px 9px', borderRadius: 6,
                  background: granularity === g ? colors.ink : '#fff',
                  color: granularity === g ? '#fff' : colors.inkSoft,
                  border: `1px solid ${colors.border}`,
                  cursor: 'pointer', fontFamily: fontStack, textTransform: 'capitalize',
                }}>{g}</button>
            ))}
          </div>
        </div>
      </div>

      <p style={{ fontSize: 11, color: colors.muted, margin: '0 0 10px' }}>
        Headcount = end-of-period snapshot. Cost = sum over the period. Cost per headcount is annualised.
        Direct staff (senior qualified / qualified / apprentices) is split by the mix % drivers in <em>Inputs → Drivers → staff</em>.
      </p>

      <div style={{ overflowX: 'auto', border: `1px solid ${colors.border}`, borderRadius: 8, background: '#fff' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11, fontFamily: fontStack }}>
          <thead>
            {/* Group header row */}
            <tr style={{ background: colors.bgSoft }}>
              <th style={{ ...th, position: 'sticky', left: 0, background: colors.bgSoft, minWidth: 200 }} rowSpan={2}>Role</th>
              <th colSpan={grouped.length} style={{ ...th, textAlign: 'center', borderLeft: `1px solid ${colors.border}` }}>Headcount</th>
              <th colSpan={grouped.length} style={{ ...th, textAlign: 'center', borderLeft: `1px solid ${colors.border}` }}>Cost</th>
              <th colSpan={grouped.length} style={{ ...th, textAlign: 'center', borderLeft: `1px solid ${colors.border}` }}>Cost / headcount (annualised)</th>
            </tr>
            <tr style={{ background: colors.bgSoft }}>
              {grouped.map(g => <th key={`h-${g.label}`} style={{ ...th, textAlign: 'right', minWidth: 60, borderTop: 'none' }}>{g.label}</th>)}
              {grouped.map(g => <th key={`c-${g.label}`} style={{ ...th, textAlign: 'right', minWidth: 70, borderTop: 'none' }}>{g.label}</th>)}
              {grouped.map(g => <th key={`p-${g.label}`} style={{ ...th, textAlign: 'right', minWidth: 70, borderTop: 'none' }}>{g.label}</th>)}
            </tr>
          </thead>
          <tbody>
            {/* Management section */}
            <SectionLabel label="Management" colSpan={1 + 3 * grouped.length} />
            {ROWS.filter(r => r.group === 'mgmt').map(r =>
              <React.Fragment key={r.role}>
                {renderRow(r.label, matrix[r.role], { indent: true })}
              </React.Fragment>
            )}
            {renderRow('Total management costs', mgmtSubtotal, { subtotal: true })}

            {/* Setting-level (between management and direct) */}
            <SectionLabel label="Setting-level" colSpan={1 + 3 * grouped.length} />
            {ROWS.filter(r => r.group === 'setting').map(r =>
              <React.Fragment key={r.role}>
                {renderRow(r.label, matrix[r.role], { indent: true })}
              </React.Fragment>
            )}
            {renderRow('Total setting costs', settingSubtotal, { subtotal: true })}

            {/* Direct */}
            <SectionLabel label="Direct staff (ratio-derived)" colSpan={1 + 3 * grouped.length} />
            {ROWS.filter(r => r.group === 'direct').map(r =>
              <React.Fragment key={r.role}>
                {renderRow(r.label, matrix[r.role], { indent: true })}
              </React.Fragment>
            )}
            {renderRow('Total direct staff costs', directSubtotal, { subtotal: true })}

            {/* Grand total */}
            {renderRow('TOTAL STAFF COSTS', grand, { total: true })}
          </tbody>
        </table>
      </div>

      <RateAnalysisBox staffDrivers={staffDrivers} />
      <StaffCostsBreakdownBox
        staffDrivers={staffDrivers}
        outputs={outputs} grouped={grouped} entityIds={entityIds}
      />
    </div>
  );
}

// ── Rate analysis box ───────────────────────────────────────────
//
// Per-role hourly rate vs Real Living Wage / National Minimum Wage,
// plus employer NI, pension and total cost-to-employer per hour.

function RateAnalysisBox({ staffDrivers }) {
  const lookup = (key) => {
    const d = staffDrivers.drivers.find(x => x.driver_key === key);
    if (!d) return null;
    const v = staffDrivers.values.find(x => x.driver_id === d.id && x.period === -1);
    return v ? Number(v.value) : null;
  };

  const hoursPerYear = lookup('standard_hours_per_year') || 1820;
  const niPct        = (lookup('employer_ni_pct') || 0) / 100;
  const penPct       = (lookup('employer_pension_pct') || 0) / 100;
  const rlw          = lookup('real_living_wage_hourly_p') || 0;
  const nmw21        = lookup('nmw_21plus_hourly_p') || 0;
  const nmw18to20    = lookup('nmw_18to20_hourly_p') || 0;
  const nmwUnder18   = lookup('nmw_under18_hourly_p') || 0;
  const nmwAppr      = lookup('nmw_apprentice_hourly_p') || 0;

  const blend = (key) => {
    const u19 = lookup(`base_salary_p.${key}_under19`) || 0;
    const u21 = lookup(`base_salary_p.${key}_under21`) || 0;
    const p21 = lookup(`base_salary_p.${key}_21plus`)  || 0;
    const m19 = (lookup(`nmw_mix.${key}.under19_pct`) || 0) / 100;
    const m21 = (lookup(`nmw_mix.${key}.under21_pct`) || 0) / 100;
    const mp  = (lookup(`nmw_mix.${key}.21plus_pct`)  || 0) / 100;
    return u19 * m19 + u21 * m21 + p21 * mp;
  };

  // Each row: [role label, annual salary (pence), nmw applicable hourly]
  const ROWS = [
    ['Executive',            lookup('base_salary_p.executive') || 0,         nmw21],
    ['Senior manager',       lookup('base_salary_p.senior_manager') || 0,    nmw21],
    ['Setting manager',      lookup('base_salary_p.setting_manager') || 0,   nmw21],
    ['Assistant manager',    lookup('base_salary_p.assistant_manager') || 0, nmw21],
    ['Admin',                lookup('base_salary_p.admin') || 0,             nmw21],
    ['Senior qualified',     lookup('base_salary_p.senior_qualified') || 0,  nmw21],
    // Direct staff broken down by NMW age band
    ['Qualified — under 19', lookup('base_salary_p.qualified_under19') || 0, nmwUnder18],
    ['Qualified — under 21', lookup('base_salary_p.qualified_under21') || 0, nmw18to20],
    ['Qualified — 21 +',     lookup('base_salary_p.qualified_21plus') || 0,  nmw21],
    ['Qualified — blended',  blend('qualified'),                              nmw21, true],
    ['Apprentice — under 19',lookup('base_salary_p.apprentice_under19') || 0,nmwAppr],
    ['Apprentice — under 21',lookup('base_salary_p.apprentice_under21') || 0,nmw18to20],
    ['Apprentice — 21 +',    lookup('base_salary_p.apprentice_21plus') || 0, nmw21],
    ['Apprentice — blended', blend('apprentice'),                              nmwAppr, true],
  ];

  const fmtRate = (p) => p > 0 ? '£' + (p / 100).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '—';

  return (
    <div style={analysisBox}>
      <div style={analysisHeader}>Rate analysis — hourly rates and on-costs (per role)</div>
      <p style={{ fontSize: 11, color: colors.muted, margin: '4px 12px 8px' }}>
        Hourly rate = annual salary ÷ {hoursPerYear} hours/year. RLW (Real Living Wage) and NMW (National Minimum Wage) shown for compliance.
        On-costs are the marginal cost on top of gross hourly rate.
      </p>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11, fontFamily: fontStack }}>
        <thead>
          <tr style={{ background: colors.bgSoft }}>
            <th style={th}>Role</th>
            <th style={{ ...th, textAlign: 'right' }}>Hourly rate</th>
            <th style={{ ...th, textAlign: 'right', color: colors.muted, fontWeight: 400 }}>RLW</th>
            <th style={{ ...th, textAlign: 'right', color: colors.muted, fontWeight: 400 }}>NMW (applicable)</th>
            <th style={{ ...th, textAlign: 'right' }}>+ Employer NI</th>
            <th style={{ ...th, textAlign: 'right' }}>+ Employer pension</th>
            <th style={{ ...th, textAlign: 'right' }}>Total cost / hour</th>
          </tr>
        </thead>
        <tbody>
          {ROWS.map(([label, salary, nmw, isBlended]) => {
            const hourly = salary > 0 ? salary / hoursPerYear : 0;
            const niPerHr = hourly * niPct;
            const penPerHr = hourly * penPct;
            const total = hourly + niPerHr + penPerHr;
            const belowRlw = hourly > 0 && hourly < rlw;
            const belowNmw = hourly > 0 && hourly < nmw;
            return (
              <tr key={label} style={{
                borderBottom: `1px solid ${colors.borderSoft}`,
                background: isBlended ? colors.bgSoft : '#fff',
                fontWeight: isBlended ? 600 : 400,
              }}>
                <td style={td}>{label}</td>
                <td style={{ ...tdR, color: belowNmw ? colors.red : (belowRlw ? colors.amber : colors.ink) }}>
                  {fmtRate(hourly)}
                  {belowNmw && <span style={{ display: 'block', fontSize: 9, color: colors.red }}>below NMW</span>}
                  {!belowNmw && belowRlw && <span style={{ display: 'block', fontSize: 9, color: colors.amber }}>below RLW</span>}
                </td>
                <td style={{ ...tdR, color: colors.muted, fontWeight: 400 }}>{fmtRate(rlw)}</td>
                <td style={{ ...tdR, color: colors.muted, fontWeight: 400 }}>{fmtRate(nmw)}</td>
                <td style={tdR}>{fmtRate(niPerHr)}</td>
                <td style={tdR}>{fmtRate(penPerHr)}</td>
                <td style={{ ...tdR, fontWeight: 700 }}>{fmtRate(total)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ── Staff costs breakdown box ────────────────────────────────────
//
// Per-period decomposition: gross wages / employer NI / employment
// allowance offset / employer pension / total cost to employer.
// Staff cost on the P&L = sum of gross + NI − EA + pension + agency cover.

function StaffCostsBreakdownBox({ staffDrivers, outputs, grouped, entityIds }) {
  const lookup = (key) => {
    const d = staffDrivers.drivers.find(x => x.driver_key === key);
    if (!d) return null;
    const v = staffDrivers.values.find(x => x.driver_id === d.id && x.period === -1);
    return v ? Number(v.value) : null;
  };
  const niPct  = (lookup('employer_ni_pct') || 0) / 100;
  const penPct = (lookup('employer_pension_pct') || 0) / 100;
  const vacPct = (lookup('vacancy_rate_pct') || 0) / 100;
  const agencyPct = (lookup('agency_premium_pct') || 0) / 100;
  const eaAnnual = lookup('employment_allowance_p') || 0;

  const inScope = (r) => !entityIds || r.entity_id == null || entityIds.has(r.entity_id);

  // The engine emits each role's monthly cost as: HC × salary/12 × loadFactor
  // where loadFactor = (1+ni+pen)(1+vac×agency). We need to back out gross from
  // this. Since we have cost = gross × loadFactor, gross = cost / loadFactor.
  const loadFactor = (1 + niPct + penPct) * (1 + vacPct * agencyPct);

  const rows = grouped.map(g => {
    let totalCost = 0;
    const periodSet = new Set(g.periods);
    for (const r of outputs) {
      if (r.nominal_type !== 'staff_cost') continue;
      if (!periodSet.has(r.period)) continue;
      if (!inScope(r)) continue;
      totalCost += r.amount_p;
    }
    const gross = loadFactor > 0 ? totalCost / loadFactor : 0;
    const ni   = gross * niPct;
    const pen  = gross * penPct;
    const agencyCover = (gross + ni + pen) * vacPct * agencyPct;
    // Employment Allowance: capped at £eaAnnual per 12-month window, applied
    // against employer NI. Pro-rate by period length.
    const monthsInGroup = g.periods.length;
    const eaForPeriod = Math.min(ni, eaAnnual * (monthsInGroup / 12));
    const totalCostCheck = gross + ni - eaForPeriod + pen + agencyCover;
    return {
      label: g.label,
      gross, ni, ea: eaForPeriod, pen, agencyCover, total: totalCost, totalNetEa: totalCost - eaForPeriod,
      tieDelta: totalCostCheck - (totalCost - eaForPeriod),
    };
  });

  return (
    <div style={analysisBox}>
      <div style={analysisHeader}>Staff costs decomposition — per period</div>
      <p style={{ fontSize: 11, color: colors.muted, margin: '4px 12px 8px' }}>
        Gross wages → loaded with employer NI ({(niPct * 100).toFixed(1)}%) and pension ({(penPct * 100).toFixed(1)}%) →
        Employment Allowance offsets NI up to £{(eaAnnual / 100).toLocaleString('en-GB')} per annum →
        agency / vacancy cover ({(vacPct * 100).toFixed(0)}% × {(agencyPct * 100).toFixed(0)}% premium) sits on top.
        Total to employer is what hits the P&L.
      </p>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11, fontFamily: fontStack }}>
        <thead>
          <tr style={{ background: colors.bgSoft }}>
            <th style={th}>Period</th>
            <th style={{ ...th, textAlign: 'right' }}>Gross wages</th>
            <th style={{ ...th, textAlign: 'right' }}>Employer NI</th>
            <th style={{ ...th, textAlign: 'right' }}>Employment Allowance</th>
            <th style={{ ...th, textAlign: 'right' }}>Employer pension</th>
            <th style={{ ...th, textAlign: 'right' }}>Vacancy / agency cover</th>
            <th style={{ ...th, textAlign: 'right' }}>Total cost to employer</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} style={{ borderBottom: `1px solid ${colors.borderSoft}` }}>
              <td style={td}><strong>{r.label}</strong></td>
              <td style={tdR}>{fmtP(r.gross, { compact: true })}</td>
              <td style={tdR}>{fmtP(r.ni, { compact: true })}</td>
              <td style={{ ...tdR, color: colors.green }}>({fmtP(r.ea, { compact: true })})</td>
              <td style={tdR}>{fmtP(r.pen, { compact: true })}</td>
              <td style={tdR}>{fmtP(r.agencyCover, { compact: true })}</td>
              <td style={{ ...tdR, fontWeight: 700 }}>{fmtP(r.totalNetEa, { compact: true })}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const analysisBox = { marginTop: 16, border: `1px solid ${colors.border}`, borderRadius: 8, background: '#fff', overflowX: 'auto' };
const analysisHeader = { padding: '8px 12px', background: colors.bgSoft, borderBottom: `1px solid ${colors.border}`, fontSize: 11, fontWeight: 700, color: colors.muted, textTransform: 'uppercase', letterSpacing: 0.5 };

function SectionLabel({ label, colSpan }) {
  return (
    <tr style={{ background: '#f1f5f9' }}>
      <td colSpan={colSpan} style={{
        padding: '5px 10px', fontWeight: 700, fontSize: 10, textTransform: 'uppercase',
        letterSpacing: 0.5, color: colors.muted,
      }}>{label}</td>
    </tr>
  );
}

function groupPeriods(periods, granularity) {
  const groups = [];
  if (granularity === 'monthly') {
    for (const p of periods) groups.push({ label: 'M' + p, periods: [p] });
  } else if (granularity === 'quarterly') {
    for (let i = 0; i < periods.length; i += 3) {
      groups.push({ label: `Q${Math.floor(i / 3) + 1}`, periods: periods.slice(i, i + 3) });
    }
  } else {
    for (let i = 0; i < periods.length; i += 12) {
      groups.push({ label: `Y${Math.floor(i / 12) + 1}`, periods: periods.slice(i, i + 12) });
    }
  }
  return groups;
}

const th = { padding: '6px 10px', textAlign: 'left', fontWeight: 600, color: colors.muted, borderBottom: `1px solid ${colors.border}` };
const td = { padding: '5px 10px', color: colors.ink };
const tdR = { ...td, textAlign: 'right', fontFamily: 'ui-monospace, monospace' };
