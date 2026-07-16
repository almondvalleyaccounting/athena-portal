import { MODULES } from '../modules.config';

// Ad-hoc admin nav ids — not in MODULES (see src/shell/Sidebar.jsx adminChildren).
const ADMIN_ROUTES = [
  { prefix: '/admin/staff', id: 'admin-staff' },
  { prefix: '/admin/tasks', id: 'admin-tasks' },
  { prefix: '/admin/import', id: 'admin-import' },
];

// Resolves the current page to a help_content.module_id, matching the same
// route-prefix logic TopBar's breadcrumb uses (deepest child wins, else parent).
export function resolveModuleId(pathname) {
  const admin = ADMIN_ROUTES.find((r) => pathname.startsWith(r.prefix));
  if (admin) return admin.id;

  const mod = MODULES.find((m) => pathname.startsWith(m.route));
  if (!mod) return null;

  if (mod.children) {
    const sorted = [...mod.children].sort((a, b) => b.route.length - a.route.length);
    const child = sorted.find((c) => pathname.startsWith(c.route));
    if (child) return child.id;
  }
  return mod.id;
}
