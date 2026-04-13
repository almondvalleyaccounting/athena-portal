// Work Planner constants — single source of truth

export const SERVICES = [
  'Admin',
  'Accounts Production',
  'Corporation Tax',
  'Self Assessment',
  'VAT Returns',
  'Bookkeeping',
  'Payroll',
  'Management Accounts',
  'Company Secretarial',
  'Advisory',
  'SA302s',
  'Accountant Certificates',
];

export const STATUSES = [
  { id: 'not_started', label: 'Not Started', colour: '#64748b', icon: '\u25CB' },
  { id: 'waiting_info', label: 'Waiting on Info', colour: '#d97706', icon: '\u25D4' },
  { id: 'in_progress', label: 'In Progress', colour: '#0e7fe0', icon: '\u25D0' },
  { id: 'with_client', label: 'With Client', colour: '#7c3aed', icon: '\u25D1' },
  { id: 'ready_to_file', label: 'Ready to File', colour: '#059669', icon: '\u25C9' },
];

export const TASK_TYPES = [
  { id: 'client_work', label: 'Client Work' },
  { id: 'admin', label: 'Admin' },
  { id: 'block_out', label: 'Block Out' },
];

export const SOURCES = [
  { id: 'brightmanager', label: 'BM' },
  { id: 'payroll_checklist', label: 'Payroll' },
  { id: 'manual', label: 'Manual' },
];

export const RECURRENCE_OPTIONS = [
  { id: 'daily', label: 'Daily' },
  { id: 'weekly', label: 'Weekly' },
  { id: 'monthly', label: 'Monthly' },
  { id: 'quarterly', label: 'Quarterly' },
  { id: 'annually', label: 'Annually' },
];

export const CALENDAR_VIEWS = [
  { id: 'day', label: 'Day', days: 1 },
  { id: '3day', label: '3 Day', days: 3 },
  { id: 'workweek', label: 'Work Wk', days: 5 },
  { id: 'week', label: 'Full Wk', days: 7 },
  { id: 'month', label: 'Month', days: 0 },
];

export const KANBAN_DUE_FILTERS = [
  { id: 'all', label: 'All' },
  { id: 'today', label: 'Today' },
  { id: 'week', label: 'Week' },
  { id: 'month', label: 'Month' },
  { id: '3', label: '3 Mo' },
  { id: '6', label: '6 Mo' },
  { id: '12', label: '12 Mo' },
];

// Default duration by service (in minutes)
export function defaultDuration(service, source) {
  if (source === 'payroll_checklist' || service === 'Payroll') return 15;
  if (service === 'VAT Returns') return 60;
  if (service === 'Accounts Production') return 180;
  if (service === 'Management Accounts') return 60;
  return 30;
}

// Calendar time slots: 08:00 to 17:45 in 15-min increments
export const TIME_SLOTS = (() => {
  const slots = [];
  for (let h = 8; h < 18; h++) {
    for (let m = 0; m < 60; m += 15) {
      slots.push({ h, m });
    }
  }
  return slots;
})();

// Time options for dropdowns (same range)
export const TIME_OPTIONS = TIME_SLOTS.map(({ h, m }) => ({
  value: `${h}:${String(m).padStart(2, '0')}`,
  label: `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`,
  h,
  m,
}));

// Team colour palette (11 colours from design system)
export const TEAM_COLOURS = [
  '#0e7fe0', '#059669', '#d97706', '#dc2626', '#7c3aed',
  '#db2777', '#0891b2', '#65a30d', '#ea580c', '#4f46e5', '#0d9488',
];
