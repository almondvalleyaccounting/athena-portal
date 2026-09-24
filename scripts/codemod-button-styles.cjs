#!/usr/bin/env node
/**
 * P3 design sprint (UI audit 2026-09): point every local button style object
 * at the one shared definition in src/lib/buttonStyles.js.
 *
 * A top-level `const btnX = { … }` is converted only when it is plainly one of
 * the three kinds — ocean fill (primary), white with a grey border
 * (secondary), or white with red text and a red border (danger) — judged from
 * its literal background, colour and border. Its look (colours, border,
 * corners, weight, size, font) then comes from BTN.<kind>.<md|sm>; every other
 * key it sets (display, gap, width, margins, cursor…) is kept, after the
 * spread, so layout is untouched. Size: font under 14px or ≤5px vertical
 * padding → sm, else md.
 *
 * Not touched: status fills (approve green, reject red, uplift purple), links,
 * icon buttons, toggles/segmented controls, anything computed at runtime, and
 * any object that spreads another. Edits by source offsets, so the rest of the
 * file keeps its formatting.
 *
 * Usage: node scripts/codemod-button-styles.cjs [--dry]
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

const dry = process.argv.includes('--dry');
const walk = (d, o = []) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p, o); else if (/\.jsx?$/.test(e.name)) o.push(p); } return o; };
const val = (n) => (n && (n.type === 'StringLiteral' || n.type === 'NumericLiteral') ? n.value : undefined);

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

let files = 0, objs = 0;
const report = [];
for (const f of walk(ROOT)) {
  if (f === LIB) continue;
  const src = fs.readFileSync(f, 'utf8');
  let ast; try { ast = parse(src, { sourceType: 'module', plugins: ['jsx'] }); } catch { continue; }
  const edits = [];
  for (const st of ast.program.body) {
    const decl = st.type === 'VariableDeclaration' ? st : (st.type === 'ExportNamedDeclaration' && st.declaration?.type === 'VariableDeclaration' ? st.declaration : null);
    if (!decl) continue;
    for (const d of decl.declarations) {
      if (d.id.type !== 'Identifier' || !NAME.test(d.id.name) || EXCLUDE.test(d.id.name) || d.init?.type !== 'ObjectExpression') continue;
      const obj = d.init;
      if (obj.properties.some((p) => p.type !== 'ObjectProperty' || p.computed)) continue;
      const props = {};
      let literalLook = true;
      for (const p of obj.properties) {
        const k = p.key.name || p.key.value;
        props[k] = val(p.value);
        if (['background', 'backgroundColor', 'color', 'border'].includes(k) && props[k] === undefined) literalLook = false;
      }
      if (!literalLook) continue;
      // A fixed width/height marks an icon button (a square), not a text button.
      if (typeof props.width === 'number' || typeof props.height === 'number') continue;
      const kind = kindOf(props);
      if (!kind) continue;
      const size = sizeOf(props);
      const kept = obj.properties.filter((p) => !MANAGED.has(p.key.name || p.key.value)).map((p) => src.slice(p.start, p.end));
      const text = `{ ...BTN.${kind}.${size}${kept.length ? ', ' + kept.join(', ') : ''} }`;
      edits.push([obj.start, obj.end, text]);
      report.push(`${path.relative(ROOT, f).replace(/\\/g, '/')}  ${d.id.name} → ${kind}.${size}`);
    }
  }
  if (!edits.length) continue;
  let s = src;
  for (const [a, b, t] of edits.sort((x, y) => y[0] - x[0])) s = s.slice(0, a) + t + s.slice(b);
  if (!/import\s*\{[^}]*\bBTN\b[^}]*\}\s*from\s*['"][^'"]*buttonStyles['"]/.test(s)) {
    let rel = path.relative(path.dirname(f), LIB).replace(/\\/g, '/').replace(/\.js$/, '');
    if (!rel.startsWith('.')) rel = './' + rel;
    const imports = [...ast.program.body].filter((n) => n.type === 'ImportDeclaration');
    const at = imports.length ? imports[imports.length - 1].end : 0;
    // Offsets shifted by the edits above only if an edit sits before the last import — style objects never do.
    s = s.slice(0, at) + `\nimport { BTN } from '${rel}';` + s.slice(at);
  }
  files++; objs += edits.length;
  if (!dry) fs.writeFileSync(f, s);
}
console.log(report.join('\n'));
console.log(`${dry ? '[dry] ' : ''}${objs} style objects across ${files} files`);
