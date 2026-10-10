// `section` is the sidebar heading a module sits under (Bobby, 2026-09-24).
// Headings appear where the section changes, so keep a section's modules
// together in this list.
//
// Who sees what is decided per person on Staff & Permissions (sql/329), not
// here: app_modules / staff_module_access, loaded onto the profile as
// profile.access. moduleGranted() below mirrors the SQL function of the same
// name. `permissions` now lists only ABILITIES inside a module (Pricing needs
// can_edit_fee_schedule); whether someone has the module at all is their
// module access.
//
// `inDevelopment: true` is only the fallback if the database hasn't loaded. The
// live status is app_modules.status, which Bobby changes from Staff &
// Permissions. An in-development module is hidden from everyone except admins
// and the testers ticked for it (Bobby, 2026-09-27 — this replaced the
// 2026-09-24 "tag, don't hide" treatment). Don't flip a status on your own
// judgement.
export const MODULES = [
  {
    id: 'fee-engine',
    section: 'Clients & Money',
    label: 'Fee Engine',
    route: '/manage',
    icon: 'receipt',
    permissions: [],
    status: 'live',
    group: 'billing',
    children: [
      { id: 'fe-dashboard', label: 'Dashboard', route: '/manage' },
      { id: 'fe-new-quote', label: 'New Quote', route: '/manage/quotes/new' },
      { id: 'fe-clients', label: 'Clients', route: '/manage/clients' },
      { id: 'fe-quotes', label: 'Quotes', route: '/manage/quotes' },
      { id: 'fe-groups', label: 'Groups', route: '/manage/groups' },
      { id: 'fe-billing', label: 'Billing Review', route: '/manage/billing', inDevelopment: true },
      { id: 'fe-pricing', label: 'Pricing & Proposals', route: '/manage/quotes/pricing', permissions: ['can_edit_fee_schedule'] },
    ],
  },
  {
    id: 'billing',
    section: 'Clients & Money',
    label: 'Billing',
    route: '/billing',
    icon: 'file-text',
    permissions: [],
    status: 'live',
    group: 'billing',
  },
  {
    id: 'clients',
    section: 'Clients & Money',
    label: 'Clients',
    route: '/clients',
    icon: 'users',
    permissions: [],
    status: 'live',
    group: 'billing',
  },
  {
    id: 'onboarding',
    section: 'Clients & Money',
    label: 'Onboarding',
    route: '/onboarding',
    icon: 'user-plus',
    permissions: [],
    status: 'live',
    group: 'billing',
    children: [
      { id: 'onboarding-list', label: 'List', route: '/onboarding/list' },
      { id: 'onboarding-board', label: 'Board', route: '/onboarding/board' },
      { id: 'onboarding-crosscheck', label: 'Cross-check', route: '/onboarding/cross-check', inDevelopment: true },
      { id: 'onboarding-ch-codes', label: 'CH Codes', route: '/onboarding/ch-codes' },
    ],
  },
  {
    id: 'communications',
    section: 'Clients & Money',
    label: 'Communications',
    route: '/comms',
    icon: 'inbox',
    permissions: [],
    status: 'live',
    group: 'billing',
    children: [
      { id: 'comms-email', label: 'Email', route: '/comms/email' },
      { id: 'comms-sms', label: 'Text Messages', route: '/comms/sms' },
      { id: 'comms-whatsapp', label: 'WhatsApp', route: '/comms/whatsapp' },
      { id: 'comms-reminders', label: 'Client Tax Reminders', route: '/comms/reminders' },
      { id: 'comms-preferences', label: 'Client Preferences', route: '/comms/preferences' },
    ],
  },
  {
    id: 'work-planner',
    section: 'Work',
    label: 'Work',
    route: '/planner',
    icon: 'clock',
    permissions: [],
    status: 'live',
    group: 'team',
    children: [
      {
        id: 'wp-task',
        label: 'Planner',
        route: '/planner',
        inDevelopment: true,
        matchPaths: ['/planner', '/planner/day', '/planner/quick', '/planner/scheduled', '/planner/calendar', '/planner/priority', '/planner/kanban', '/planner/completed'],
      },
      {
        id: 'wp-ready',
        label: 'Ready Now',
        route: '/planner/ready',
        matchPaths: ['/planner/ready'],
      },
      {
        id: 'wp-plan',
        label: 'Workflows',
        route: '/planner/plan',
        inDevelopment: true,
        matchPaths: ['/planner/plan'],
      },
      {
        id: 'wp-team',
        label: 'Team',
        route: '/planner/team',
        inDevelopment: true,
        matchPaths: ['/planner/team'],
      },
      {
        id: 'wp-bk-health',
        label: 'Bookkeeping Health',
        route: '/planner/bookkeeping-health',
        inDevelopment: true,
        // The old /planner/drift path still resolves, so keep it matchable.
        matchPaths: ['/planner/bookkeeping-health', '/planner/drift'],
      },
      {
        id: 'wp-capacity',
        label: 'Capacity',
        route: '/planner/allocations',
        inDevelopment: true,
        matchPaths: ['/planner/allocations', '/planner/capacity'],
      },
      // Job Review retired 2026-10-06: Progress update on a job (task modal,
      // Priority board, Overview) replaces it (sql/349). /planner/review
      // redirects to Priority; the job_review_* tables keep the history.
      {
        id: 'wp-timesheets',
        label: 'Timesheets',
        route: '/timesheets',
        inDevelopment: true,
        matchPaths: ['/timesheets'],
      },
      { id: 'wp-triage', label: 'Triage Board', route: '/triage', matchPaths: ['/triage'], inDevelopment: true },
    ],
  },
  {
    id: 'client-work',
    section: 'Client Insight',
    label: 'Client Work',
    route: '/client-dashboard',
    icon: 'briefcase',
    permissions: [],
    status: 'live',
    group: 'data',
    children: [
      { id: 'cw-dashboard', label: 'Client Dashboard', route: '/client-dashboard' },
      { id: 'cw-portfolio', label: 'Portfolio', route: '/portfolio' },
      { id: 'cw-reports', label: 'Client Reports', route: '/reports' },
      {
        id: 'cw-hmrc',
        label: 'HMRC',
        inDevelopment: true,
        // Lands on the consolidated all-taxes view, which is the front door now.
        route: '/hmrc/all',
        // The tabs that were folded into PAYE — statement, payments, balance —
        // are kept here so a bookmark still highlights the module on its way
        // through the redirect.
        matchPaths: ['/hmrc', '/hmrc/all', '/hmrc/breakdown', '/hmrc/paye',
                     '/hmrc/corporation-tax', '/hmrc/vat', '/hmrc/self-assessment', '/hmrc/by-tax',
                     '/hmrc/client', '/hmrc/statement', '/hmrc/payments', '/hmrc/trend', '/hmrc/balance',
                     '/hmrc/reconciliation', '/hmrc/authorisations'],
      },
      { id: 'cw-forecast', label: 'Client Forecast', route: '/forecast', permissions: ['is_portal_admin'] },
    ],
  },
  {
    id: 'working-papers',
    section: 'Client Insight',
    label: 'Working Papers',
    route: '/working-papers',
    icon: 'file-spreadsheet',
    permissions: [],
    status: 'live',
    inDevelopment: true,
    group: 'data',
    children: [
      { id: 'wp-paye', label: 'PAYE', route: '/working-papers/paye', matchPaths: ['/working-papers', '/working-papers/paye'] },
      { id: 'wp-mapping', label: 'Nominal mapping', route: '/working-papers/mapping', matchPaths: ['/working-papers/mapping'] },
      { id: 'wp-ct', label: 'Corporation Tax', route: '/working-papers/corporation-tax', matchPaths: ['/working-papers/corporation-tax'] },
      { id: 'wp-net-wages', label: 'Net wages', route: '/working-papers/net-wages', matchPaths: ['/working-papers/net-wages'] },
    ],
  },
  {
    id: 'planning',
    section: 'Client Insight',
    label: 'Practice Planning',
    route: '/planning',
    icon: 'trending-up',
    // The practice's own books.
    permissions: ['can_view_practice_financials'],
    status: 'live',
    inDevelopment: true,
    group: 'data',
  },
  {
    id: 'pd-tracker',
    section: 'Team',
    label: 'CPD Tracker',
    route: '/team/pd',
    icon: 'graduation-cap',
    permissions: [],
    status: 'live',
    group: 'team',
  },
  {
    id: 'recruitment',
    section: 'Team',
    label: 'Recruitment',
    route: '/recruitment',
    icon: 'user-check',
    permissions: [],
    status: 'live',
    inDevelopment: true,
    group: 'team',
    children: [
      { id: 'rec-vacancies', label: 'Vacancies', route: '/recruitment', matchPaths: ['/recruitment'] },
      { id: 'rec-interviews', label: 'Interviews', route: '/recruitment/interviews', matchPaths: ['/recruitment/interviews'] },
    ],
  },
  {
    id: 'bugs',
    section: 'Athena',
    label: 'Bug Reports',
    route: '/bugs',
    icon: 'bug',
    permissions: [],
    status: 'live',
    group: 'meta',
  },
  {
    id: 'ideas',
    section: 'Athena',
    label: 'Ideas',
    route: '/ideas',
    icon: 'lightbulb',
    permissions: [],
    status: 'live',
    group: 'meta',
  },
];

// ─── Access (sql/329) ─────────────────────────────────────────────────────────
//
// profile.access is loaded by AppShell:
//   modules  { [key]: level }                   this person's staff_module_access rows
//   meta     { [key]: { parent, grantable, status } }   app_modules
//   hiddenClients  Set of entity ids whose figures are switched off for them
// If it failed to load, access is null and the nav falls back to the static
// inDevelopment tags and the ability flags alone — the database still enforces.

const byId = (() => {
  const m = {};
  for (const mod of MODULES) {
    m[mod.id] = { item: mod, parent: null };
    for (const c of mod.children || []) m[c.id] = { item: c, parent: mod.id };
  }
  return m;
})();

// The one heading that isn't a module: Client Work's children are the modules.
export const CONTAINER_IDS = new Set(['client-work']);

export function isAdmin(profile) {
  return profile?.is_portal_admin === true;
}

export function moduleStatus(profile, key) {
  const s = profile?.access?.meta?.[key]?.status;
  if (s) return s;
  return byId[key]?.item?.inDevelopment ? 'in_development' : 'live';
}

export const isModuleInDevelopment = (profile, key) => moduleStatus(profile, key) === 'in_development';

// Mirrors public.module_granted(): admins always; otherwise the parent must be
// granted, and a grantable or in-development key needs this person's own row.
export function moduleGranted(profile, key) {
  if (!profile) return false;
  if (isAdmin(profile)) return true;
  const access = profile.access;
  const meta = access?.meta?.[key];
  if (!access || !meta) {
    // Not loaded, or a key the database doesn't know (the injected Admin task
    // list). Fall back to hiding only what the static config calls unfinished.
    const parent = byId[key]?.parent;
    if (parent && !moduleGranted(profile, parent)) return false;
    return !byId[key]?.item?.inDevelopment || !access;
  }
  if (meta.parent && !moduleGranted(profile, meta.parent)) return false;
  if (meta.grantable || meta.status === 'in_development') return key in access.modules;
  return true;
}

export const moduleLevel = (profile, key) => (isAdmin(profile) ? 'approver' : profile?.access?.modules?.[key] ?? null);

const hasAll = (profile, perms) => (perms || []).every((perm) => profile?.[perm] === true);

// Is this sidebar item shown to this person? Admins see everything.
export function isItemVisible(profile, mod, child = null) {
  if (!profile) return false;
  if (isAdmin(profile)) return true;
  if (child) {
    return (CONTAINER_IDS.has(mod.id) || isItemVisible(profile, mod))
      && moduleGranted(profile, child.id) && hasAll(profile, child.permissions);
  }
  if (CONTAINER_IDS.has(mod.id)) return (mod.children || []).some((c) => moduleGranted(profile, c.id) && hasAll(profile, c.permissions));
  return moduleGranted(profile, mod.id) && hasAll(profile, mod.permissions);
}

// Where clicking a module should land: its own route if this person can see it,
// otherwise its first visible child (Work's own route is the in-development
// Planner, so most of the team lands on Ready Now).
export function landingRoute(profile, mod) {
  const kids = (mod.children || []).filter((c) => isItemVisible(profile, mod, c));
  const own = kids.find((c) => c.route === mod.route);
  if (own || kids.length === 0) return mod.route;
  return kids[0].route;
}

// Pages outside the nav that belong to an in-development area, keyed by the
// module whose status they follow.
const ONBOARDING_DETAIL = /^\/onboarding\/[0-9a-f-]{36}(\/|$)/i;
const EXTRA_DEV_PATHS = [
  { key: 'onboarding-list', test: (p) => ONBOARDING_DETAIL.test(p) || ['/onboarding/new', '/onboarding/updates'].some((x) => p === x || p.startsWith(x + '/')) },
  { key: 'wp-task', test: (p) => p === '/planner/setup' || p.startsWith('/planner/setup/') },
];

export function isInDevelopmentPath(pathname, profile) {
  const extra = EXTRA_DEV_PATHS.find((x) => x.test(pathname));
  if (extra) return isModuleInDevelopment(profile, extra.key);
  const match = findNavMatch(pathname);
  if (!match) return false;
  if (match.child && isModuleInDevelopment(profile, match.child.id)) return true;
  return isModuleInDevelopment(profile, match.mod.id);
}

// Which module (and child) a path belongs to. Children are matched first,
// across every module and on their matchPaths, because several live outside
// their module's prefix (/timesheets, /triage, /portfolio, /hmrc …). A
// module's own root only matches itself, or /planner would claim /planner/tasks.
// Shared by the top-bar breadcrumb and the access guard so they agree.
export function findNavMatch(pathname) {
  const hits = (p) => pathname === p || pathname.startsWith(p + '/');
  let best = null;
  for (const m of MODULES) {
    for (const c of m.children || []) {
      for (const p of [c.route, ...(c.matchPaths || [])]) {
        const ok = p === m.route ? pathname === p : hits(p);
        if (ok && (!best || p.length > best.len)) best = { mod: m, child: c, len: p.length };
      }
    }
  }
  if (best) return { mod: best.mod, child: best.child };
  const mod = MODULES.find((m) => pathname.startsWith(m.route));
  return mod ? { mod, child: null } : null;
}

// Can this person open this page? The same rule that decides what the sidebar
// shows (Bobby, 2026-09-24: "match the sidebar strictly"), so a page that isn't
// in your sidebar can't be reached by typing its address or following a link.
// The database's own rules still apply underneath — this is the front door,
// not the lock.
export function canAccessPath(pathname, profile) {
  if (!profile) return true; // the shell is still loading the profile
  const any = (...flags) => flags.some((f) => profile[f] === true);

  // Screens outside modules.config, with the rules the sidebar uses for them.
  if (pathname.startsWith('/admin/import')) return any('can_import_data', 'is_portal_admin');
  if (pathname.startsWith('/admin/staff')) return isAdmin(profile);
  if (pathname.startsWith('/admin') || pathname.startsWith('/kpis')) return any('can_manage_portal');
  if (pathname.startsWith('/planner/tasks')) return any('work_planner', 'can_view_onboarding', 'is_portal_admin');
  if (pathname.startsWith('/planner/setup')) return any('is_portal_admin', 'can_import_data');

  const match = findNavMatch(pathname);
  if (!match) return true; // /home, /settings, /security, unknown paths (the router sends those home)
  if (match.mod.status !== 'live') return any('can_manage_portal');
  if (match.child) return isItemVisible(profile, match.mod, match.child);
  if (CONTAINER_IDS.has(match.mod.id)) return isItemVisible(profile, match.mod);
  return isItemVisible(profile, match.mod);
}

// Figures for this client are switched off for this person (Staff & Permissions
// › Clients). The database already returns nothing; screens use this to say so
// instead of showing a misleading £0 or an empty chart.
export function clientFiguresHidden(profile, entityId) {
  if (!profile || !entityId || isAdmin(profile)) return false;
  return profile.access?.hiddenClients?.has(entityId) === true;
}
