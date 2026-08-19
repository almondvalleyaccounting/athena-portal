/*
  The client-facing palette: Scottish Coast navy + blue-teal accent.

  Lives here rather than in client-portal/src/theme.js because Athena renders
  the very same client view in the "Preview as client" panel on
  /admin/dashboard-access. Two palettes would mean the preview slowly stopped
  looking like the thing it is previewing, which defeats the point of having a
  preview at all. client-portal/src/theme.js re-exports this.
*/
export const portalTheme = {
  navy: '#1E4560',
  navyDark: '#16354b',
  teal: '#0e7490',
  tealSoft: '#e0f2fe',
  tealText: '#155e75',
  gold: '#F5C518',
  text: '#1e293b',
  muted: '#64748b',
  faint: '#94a3b8',
  border: '#e2e8f0',
  bg: '#f6f8f9',
  card: '#ffffff',
  success: '#059669',
  successSoft: '#dcfce7',
  successText: '#166534',
  amberSoft: '#fef3c7',
  amberText: '#92400e',
};

export default portalTheme;
