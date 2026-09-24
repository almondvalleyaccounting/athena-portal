#!/usr/bin/env node
/**
 * P3 design sprint (UI audit 2026-09): point every button style at the one
 * shared definition in src/lib/buttonStyles.js.
 *
 * A style is converted only when it is plainly one of the three kinds — ocean
 * fill (primary), white with a grey border (secondary), or white with red
 * text and a red border (danger) — judged from its literal background, colour
 * and border. Its look (colours, border, corners, weight, size, font) then
 * comes from BTN.<kind>.<md|sm>; every other key it sets (display, gap,
 * margins, cursor…) is kept, after the spread, so layout is untouched.
 * Size: font under 14px or ≤5px vertical padding → sm, else md.
 *
 * Covers top-level `const btnX = { … }` objects, and with --inline also
 * literal style={{ … }} objects written directly on a <button>.
 *
 * Not touched: status fills (approve green, reject red, uplift purple), links,
 * icon buttons (anything with a fixed width/height), toggles/segmented
 * controls, anything computed at runtime, and any object that spreads another.
 * Edits by source offsets, so the rest of the file keeps its formatting.
 *
 * Usage: node scripts/codemod-button-styles.cjs [--dry] [--inline]
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { parse } = require('@babel/parser');

const ROOT = path.join(__dirname, '..', 'src');
const LIB = path.join(ROOT, 'lib', 'buttonStyles.js');
const NAME = /^(btn[A-Z]?\w*|\w*Btn\w*|button[A-Z]\w*)$/;
const EXCLUDE = /mode|tab|letter|chip|toggle|sugg|close|xBtn|icon|link|active|disabled|reorder|page|sort|seg|pill/i;
const MANAGED = new Set(['background', 'backgroundColor', 'color', 'border', 'borderColor', 'borderRadius', 'fontWeight', 'padding', 'fontSize', 'fontFamily', 'lineHeight']);
const WHITE = new Set(['#fff', '#ffffff', 'white']);
const SLATE = new Set(['#475569', '#0f172a', '#334155', '#1e293b', '#64748b']);
const GREY_BORDER = /^1px solid #(e5e7eb|e2e8f0|cbd5e1)$/i;
const RED_TEXT = new Set(['#b91c1c', '#991b1b', '#dc2626']);
const RED_BORDER = /^1px solid #(fecaca|fca5a5)$/i;
const OCEAN = new Set(['#1e4560']);
// Rendered in the client portal too (through @dash) — clients' look is its
// own, so these are never touched.
const PORTAL = new Set(['PortalDashboardView.jsx', 'StatementTables.jsx', 'TabErrorBoundary.jsx', 'DashboardCharts.jsx', 'ReportView.jsx', 'portalTheme.js', 'usePortalDashboard.js']
  .map((n) => path.join(ROOT, 'modules', 'client-dashboard', n)));

const dry = process.argv.includes('--dry');
const inline = process.argv.includes('--inline');
const walk = (d, o = []) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p, o); else if (/\.jsx?$/.test(e.name)) o.push(p); } return o; };
const val = (n) => (n && (n.type === 'StringLiteral' || n.type === 'NumericLiteral') ? n.value : undefined);
const rel = (f) => path.relative(ROOT, f).split(path.sep).join('/');

function kindOf(p) {
  const bg = String(p.background ?? p.backgroundColor ?? '').toLowerCase();
  const color = String(p.color ?? '').toLowerCase();
  const border = String(p.border ?? '');
  if (OCEAN.has(bg) && WHITE.has(color)) return 'primary';
  if (WHITE.has(bg) && SLATE.has(color) && GREY_BORDER.test(border)) return 'secondary';
  if (WHITE.has(bg) && RED_TEXT.has(color) && RED_BORDER.test(border)) return 'danger';
  return null;
}
function sizeOf(p) {
  if (typeof p.fontSize === 'number' && p.fontSize < 14) return 'sm';
  const m = /^(\d+(?:\.\d+)?)px/.exec(String(p.padding ?? ''));
  if (m && Number(m[1]) <= 5) return 'sm';
  return 'md';
}
function convert(obj, src) {
  if (obj.properties.some((p) => p.type !== 'ObjectProperty' || p.computed)) return null;
  const props = {};
  for (const p of obj.properties) {
    const k = p.key.name || p.key.value;
    props[k] = val(p.value);
    if (['background', 'backgroundColor', 'color', 'border'].includes(k) && props[k] === undefined) return null;
  }
  // A fixed width/height marks an icon button (a square), not a text button.
  if (typeof props.width === 'number' || typeof props.height === 'number') return null;
  const kind = kindOf(props);
  if (!kind) return null;
  const size = sizeOf(props);
  const kept = obj.properties.filter((p) => !MANAGED.has(p.key.name || p.key.value)).map((p) => src.slice(p.start, p.end));
  return { kind, size, text: `{ ...BTN.${kind}.${size}${kept.length ? ', ' + kept.join(', ') : ''} }` };
}

let files = 0, objs = 0;
const report = [];
for (const f of walk(ROOT)) {
  if (f === LIB || PORTAL.has(f)) continue;
  const src = fs.readFileSync(f, 'utf8');
  let ast; try { ast = parse(src, { sourceType: 'module', plugins: ['jsx'] }); } catch { continue; }
  const edits = [];
  for (const st of ast.program.body) {
    const decl = st.type === 'VariableDeclaration' ? st : (st.type === 'ExportNamedDeclaration' && st.declaration?.type === 'VariableDeclaration' ? st.declaration : null);
    if (!decl) continue;
    for (const d of decl.declarations) {
      if (d.id.type !== 'Identifier' || !NAME.test(d.id.name) || EXCLUDE.test(d.id.name) || d.init?.type !== 'ObjectExpression') continue;
      const c = convert(d.init, src);
      if (!c) continue;
      edits.push([d.init.start, d.init.end, c.text]);
      report.push(`${rel(f)}  ${d.id.name} → ${c.kind}.${c.size}`);
    }
  }
  if (inline) {
    const visit = (n) => {
      if (!n || typeof n.type !== 'string') return;
      if (n.type === 'JSXOpeningElement' && n.name.type === 'JSXIdentifier' && n.name.name === 'button') {
        const st = n.attributes.find((a) => a.type === 'JSXAttribute' && a.name.name === 'style');
        const obj = st?.value?.expression;
        if (obj?.type === 'ObjectExpression') {
          const c = convert(obj, src);
          if (c) { edits.push([obj.start, obj.end, c.text]); report.push(`${rel(f)}:${n.loc.start.line}  <button style> → ${c.kind}.${c.size}`); }
        }
      }
      for (const k of Object.keys(n)) {
        if (k === 'loc' || k === 'start' || k === 'end') continue;
        const v = n[k];
        if (Array.isArray(v)) v.forEach(visit); else if (v && typeof v.type === 'string') visit(v);
      }
    };
    visit(ast.program);
  }
  if (!edits.length) continue;
  let s = src;
  for (const [a, b, t] of edits.sort((x, y) => y[0] - x[0])) s = s.slice(0, a) + t + s.slice(b);
  if (!/import\s*\{[^}]*\bBTN\b[^}]*\}\s*from\s*['"][^'"]*buttonStyles['"]/.test(s)) {
    let r = path.relative(path.dirname(f), LIB).split(path.sep).join('/').replace(/\.js$/, '');
    if (!r.startsWith('.')) r = './' + r;
    const imports = ast.program.body.filter((n) => n.type === 'ImportDeclaration');
    const at = imports.length ? imports[imports.length - 1].end : 0;
    // Every edit sits after the imports, so this offset is still valid.
    s = s.slice(0, at) + `\nimport { BTN } from '${r}';` + s.slice(at);
  }
  files++; objs += edits.length;
  if (!dry) fs.writeFileSync(f, s);
}
console.log(report.join('\n'));
console.log(`${dry ? '[dry] ' : ''}${objs} styles across ${files} files`);
