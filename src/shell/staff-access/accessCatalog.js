// What Staff & Permissions offers, per module (sql/328). Labels and grouping
// come from modules.config so the screen reads exactly like the sidebar.

import { MODULES } from '../../modules.config';

// Modules that show client figures. Their data follows the person's Clients
// tab as well as the module switch.
export const FIGURE_MODULES = new Set([
  'fee-engine', 'billing', 'clients',
  'cw-dashboard', 'cw-portfolio', 'cw-reports', 'cw-hmrc', 'cw-forecast',
  'working-papers',
]);

// Abilities inside a module: switched per person, and only meaningful when the
// module is on. Each is a staff_profiles flag the database already enforces.
export const ABILITIES = {
  'fee-engine': [
    { flag: 'can_view_client_fees', label: 'See client fees' },
    { flag: 'can_edit_quotes', label: 'Edit quotes' },
    { flag: 'can_approve_quotes', label: 'Approve quotes' },
    { flag: 'can_edit_fee_schedule', label: 'Edit pricing' },
  ],
  billing: [{ flag: 'can_view_pushed_invoices', label: 'Pushed invoices' }],
  onboarding: [{ flag: 'can_view_ch_codes', label: 'Companies House codes' }],
  'work-planner': [
    { flag: 'can_manage_task_pipeline', label: 'Manage task stages' },
    { flag: 'can_view_admin_report', label: 'Admin report' },
    { flag: 'can_approve_bk_priority', label: 'Approve bookkeeping priority' },
  ],
  'cw-dashboard': [{ flag: 'can_manage_kpi_packs', label: 'Edit KPI packs' }],
  recruitment: [
    { flag: 'can_manage_recruitment', label: 'Manage vacancies' },
    { flag: 'can_view_recruitment_applicants', label: 'See applicants' },
  ],
  bugs: [{ flag: 'can_triage_bugs', label: 'Triage bugs' }],
};

// Not tied to one module.
export const SYSTEM_ABILITIES = [
  { flag: 'can_view_practice_financials', label: 'Practice financials', hint: "The practice's own books and figures" },
  { flag: 'can_manage_portal', label: 'Settings screens', hint: 'Portal clients, connections, scheduled jobs' },
  { flag: 'can_import_data', label: 'Data import' },
];

// A module that can't be given to a non-admin yet, and why.
export const LOCKED = {
  'cw-forecast': 'Admins only for now. Its data is admin-only.',
};
// Shown beside a module that needs an ability as well.
export const NEEDS = {
  planning: 'Also needs Practice financials',
};

const labelOf = {};
const parentOf = {};
for (const m of MODULES) {
  labelOf[m.id] = m.label;
  for (const c of m.children || []) {
    labelOf[c.id] = c.label;
    parentOf[c.id] = m.id;
  }
}

export const moduleLabel = (key) => labelOf[key] || key;
export const fullLabel = (key) => (parentOf[key] && parentOf[key] !== 'client-work'
  ? `${labelOf[parentOf[key]]} › ${labelOf[key]}`
  : labelOf[key] || key);

// Sections in sidebar order. Each row is something switched per person: a
// grantable module, with its in-development sub-pages (switched per tester)
// listed underneath.
export function buildSections(meta) {
  const sections = [];
  const push = (section, row) => {
    let s = sections.find((x) => x.section === section);
    if (!s) { s = { section, rows: [] }; sections.push(s); }
    s.rows.push(row);
  };
  const devKids = (mod) => (mod.children || [])
    .filter((c) => meta[c.id]?.status === 'in_development' && !meta[c.id]?.grantable)
    .map((c) => ({ key: c.id, label: c.label }));

  for (const mod of MODULES) {
    if (mod.id === 'client-work') {
      for (const c of mod.children || []) {
        if (!meta[c.id]?.grantable) continue;
        push(mod.section, { key: c.id, label: c.label, devChildren: [] });
      }
      continue;
    }
    if (!meta[mod.id]?.grantable) continue;
    push(mod.section, { key: mod.id, label: mod.label, devChildren: devKids(mod) });
  }
  return sections;
}

// Everything currently in development, parent first.
export function inDevelopmentKeys(meta) {
  const out = [];
  for (const mod of MODULES) {
    if (meta[mod.id]?.status === 'in_development') out.push(mod.id);
    for (const c of mod.children || []) if (meta[c.id]?.status === 'in_development') out.push(c.id);
  }
  return out;
}

// Keys that can be put back into development: every module and page the
// sidebar lists, except the Client Work heading.
export function allKeys() {
  const out = [];
  for (const mod of MODULES) {
    if (mod.id !== 'client-work') out.push(mod.id);
    for (const c of mod.children || []) out.push(c.id);
  }
  return out;
}
