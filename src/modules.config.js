// `inDevelopment: true` marks a module or sub-item Bobby has said is only
// partly built (2026-09-24). It stays in the nav, tagged, so the team can tell
// what to rely on. Everything unmarked is trusted. Re-ask as modules graduate —
// don't flip a flag on your own judgement.
export const MODULES = [
  {
    id: 'fee-engine',
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
    label: 'Billing',
    route: '/billing',
    icon: 'file-text',
    permissions: ['can_view_billing'],
    status: 'live',
    group: 'billing',
  },
  {
    id: 'clients',
    label: 'Clients',
    route: '/clients',
    icon: 'users',
    permissions: [],
    status: 'live',
    group: 'billing',
  },
  {
    id: 'onboarding',
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
        matchPaths: ['/planner', '/planner/waiting', '/planner/quick', '/planner/scheduled', '/planner/calendar', '/planner/kanban', '/planner/completed'],
      },
      {
        id: 'wp-ready',
        label: 'Ready Now',
        route: '/planner/ready',
        matchPaths: ['/planner/ready'],
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
    label: 'CPD Tracker',
    route: '/team/pd',
    icon: 'graduation-cap',
    permissions: ['can_view_pd_tracker'],
    status: 'live',
    group: 'team',
  },
  {
    id: 'recruitment',
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
    label: 'Bug Reports',
    route: '/bugs',
    icon: 'bug',
    permissions: [],
    status: 'live',
    group: 'meta',
  },
  {
    id: 'ideas',
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
  '/planner/waiting', '/planner/quick', '/planner/scheduled', '/planner/calendar', '/planner/kanban', '/planner/completed',
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
