// Client-facing palette: Scottish Coast navy + blue-teal accent.
//
// The values live in @dash/portalTheme.js because Athena renders the same
// client dashboard in its "Preview as client" panel, and two palettes would
// mean the preview slowly stopped looking like the page it previews. This
// re-export keeps every existing `import { theme } from './theme'` working.
export { portalTheme as theme } from '@dash/portalTheme.js';
