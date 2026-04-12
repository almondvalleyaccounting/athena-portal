export { default as ReportsPage } from './ReportsPage';

/*
 * Route entry needed in App.jsx:
 *
 *   import ReportsPage from './modules/reports/ReportsPage';
 *
 *   <Route path="/reports" element={<ReportsPage />} />
 *
 * Add inside the <Routes> block in the authenticated section.
 *
 * NavShell entry (conditional on can_view_reports):
 *
 *   { path: '/reports', label: 'Reports', icon: '▤' }
 *
 * Add conditionally like PRICING_ITEM:
 *   if (profile?.can_view_reports) items.push(REPORTS_ITEM);
 *
 * ⚠ FLAG: Manual wiring required — do not modify App.jsx or NavShell.jsx automatically.
 */
