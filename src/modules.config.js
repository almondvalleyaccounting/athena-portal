// `section` is the sidebar heading a module sits under (Bobby, 2026-09-24).
// Headings appear where the section changes, so keep a section's modules
// together in this list.
//
// `inDevelopment: true` marks a module or sub-item Bobby has said is only
// partly built (2026-09-24). It stays in the nav, tagged, so the team can tell
// what to rely on. Everything unmarked is trusted. Re-ask as modules graduate —
// don't flip a flag on your own judgement.
export const MODULES = [
  {
    id: 'fee-engine',
    section: 'Clients & Money',
    label: 'Fee Engine',
    route: '/manage',
    icon: 'receipt',
    permissions: ['can_view_quotes'],
    status: 'live',
    group: 'billing',
    children: [
      { id: 'fe-dashboard', label: 'Dashboard', route: '/manage' },
      { id: 'fe-new-quote', label: 'New Quote', route: '/manage/quotes/new' },
      { id: 'fe-clients', label: 'Clients', route: '/manage/clients' },
      { id: 'fe-quotes', label: 'Quotes', route: '/manage/quotes' },
      { id: 'fe-groups', label: 'Groups', route: '/manage/groups' },
      { id: 'fe-billing', label: 'Billing Review', route: '/manage/billing', inDevelopment: true },
      { id: 'fe-pricing', label: 'Pricing', route: '/manage/quotes/pricing', permissions: ['can_edit_fee_schedule'] },
    ],
  },
  {
    id: 'billing',
    section: 'Clients & Money',
    label: 'Billing',
    route: '/billing',
    icon: 'file-text',
    permissions: ['can_view_billing'],
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
    permissions: ['can_view_onboarding'],
    status: 'live',
    group: 'billing',
    children: [
      { id: 'onboarding-list', label: 'List', route: '/onboarding/list', inDevelopment: true },
      { id: 'onboarding-board', label: 'Board', route: '/onboarding/board', inDevelopment: true },
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
    permissions: ['work_planner'],
    status: 'live',
    group: 'team',
    children: [
      {
        id: 'wp-task',
        label: 'Planner',
        route: '/planner',
        inDevelopment: true,
        matchPaths: ['/planner', '/planner/day', '/planner/waiting', '/planner/quick', '/planner/scheduled', '/planner/calendar', '/planner/kanban', '/planner/completed'],
      },
      {
        id: 'wp-ready',
        label: 'Ready Now',
        route: '/planner/ready',
        matchPaths: ['/planner/ready'],
      },
      {
        id: 'wp-plan',
        label: 'Plan the Job',
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
        matchPaths: ['/planner/allocations', '/planner/estimates', '/planner/capacity'],
      },
      {
        id: 'wp-job-review',
        label: 'Job Review',
        route: '/planner/review',
        inDevelopment: true,
        matchPaths: ['/planner/review', '/planner/review/team'],
      },
      {
        id: 'wp-timesheets',
        label: 'Timesheets',
        route: '/timesheets',
        inDevelopment: true,
        permissions: ['can_view_timesheets'],
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
      { id: 'cw-dashboard', label: 'Client Dashboard', route: '/client-dashboard', permissions: ['can_view_reports'] },
      { id: 'cw-portfolio', label: 'Portfolio', route: '/portfolio', permissions: ['can_view_reports'] },
      { id: 'cw-reports', label: 'Client Reports', route: '/reports', permissions: ['can_view_reports'] },
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
      { id: 'cw-forecast', label: 'Client Forecast', route: '/forecast', permissions: ['can_manage_portal'] },
    ],
  },
  {
    id: 'working-papers',
    section: 'Client Insight',
    label: 'Working Papers',
    route: '/working-papers',
    icon: 'file-spreadsheet',
    // Same gate as the HMRC module and Client Reports: these papers put HMRC's
    // account, a client's ledger and their payroll on one page.
    permissions: ['can_view_reports'],
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
    permissions: ['can_manage_portal'],
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
    permissions: ['can_view_pd_tracker'],
    status: 'live',
    group: 'team',
  },
  {
    id: 'recruitment',
    section: 'Team',
    label: 'Recruitment',
    route: '/recruitment',
    icon: 'user-check',
    permissions: ['can_view_recruitment'],
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

// Pages that belong to an in-development area, for the "In development" tag
// in the top bar. Explicit because several areas are reached through routes
// the nav doesn't list (onboarding detail pages, planner tabs, planner setup)
// and because trusted pages share prefixes with unfinished ones — /planner/ready
// and /planner/tasks are trusted, the rest of /planner is not.
const DEV_EXACT = ['/planner', '/onboarding'];
const DEV_PREFIXES = [
  '/manage/billing',
  '/onboarding/list', '/onboarding/board', '/onboarding/cross-check', '/onboarding/new', '/onboarding/updates',
  '/planner/day', '/planner/waiting', '/planner/quick', '/planner/scheduled', '/planner/calendar', '/planner/kanban', '/planner/completed',
  '/planner/bookkeeping-health', '/planner/drift',
  '/planner/allocations', '/planner/estimates', '/planner/capacity',
  '/planner/review', '/planner/setup',
  '/timesheets', '/triage', '/hmrc', '/working-papers', '/planning', '/recruitment',
];
const ONBOARDING_DETAIL = /^\/onboarding\/[0-9a-f-]{36}(\/|$)/i;

export function isInDevelopmentPath(pathname) {
  if (DEV_EXACT.includes(pathname)) return true;
  if (ONBOARDING_DETAIL.test(pathname)) return true;
  return DEV_PREFIXES.some((p) => pathname === p || pathname.startsWith(p + '/'));
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

const hasAll = (profile, perms) => (perms || []).every((perm) => profile?.[perm] === true);

// Can this person open this page? The same flags that decide what the sidebar
// shows (Bobby, 2026-09-24: "match the sidebar strictly"), so a page that isn't
// in your sidebar can't be reached by typing its address or following a link.
// The database's own rules still apply underneath — this is the front door,
// not the lock.
export function canAccessPath(pathname, profile) {
  if (!profile) return true; // the shell is still loading the profile
  const any = (...flags) => flags.some((f) => profile[f] === true);

  // Screens outside modules.config, with the rules the sidebar uses for them.
  if (pathname.startsWith('/admin/import')) return any('can_import_data', 'is_portal_admin');
  if (pathname.startsWith('/admin') || pathname.startsWith('/kpis')) return any('can_manage_portal');
  if (pathname.startsWith('/planner/tasks')) return any('work_planner', 'can_view_onboarding', 'is_portal_admin');
  if (pathname.startsWith('/planner/setup')) return any('is_portal_admin', 'can_import_data');

  const match = findNavMatch(pathname);
  if (!match) return true; // /home, /settings, /security, unknown paths (the router sends those home)
  if (match.mod.status !== 'live') return any('can_manage_portal');
  return hasAll(profile, match.mod.permissions) && hasAll(profile, match.child?.permissions);
}
