#!/usr/bin/env node
/**
 * One-off codemod for Sprint 3 of the 2026-09-24 UI audit: one main-action
 * button colour everywhere — ocean #1E4560 with white text (Bobby's choice).
 *
 * The main action was yellow in Fee Engine and Onboarding, near-black navy in
 * Clients / Comms / Admin, and blue in CH Codes. For every <button> whose inline
 * style paints one of those as a solid fill with light text (or dark text on the
 * yellow), the fill becomes ocean and the text white. Conditional fills
 * (`active ? '#0f172a' : '#fff'`, the selected state of a segmented control)
 * take ocean on the filled branch, so "selected" reads as the brand colour too.
 *
 * Deliberately NOT touched: green (#059669) and red fills — those are status
 * (approve / done, destructive) — and anything that isn't a <button>.
 * Parses with @babel/parser and edits by source offsets, so formatting stays.
 *
 * Usage: node scripts/codemod-primary-buttons.cjs [--dry] [--census]
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { parse } = require('@babel/parser');

const ROOT = path.join(__dirname, '..', 'src');
const OCEAN = '#1E4560';
const DARK_PRIMARY = new Set(['#0f172a', '#0e7fe0']);          // needed light text
const YELLOW = new Set(['#f5c518']);                             // needed dark text
const LIGHT_TEXT = new Set(['#fff', '#ffffff', 'white']);
const DARK_TEXT = new Set(['#193a50', '#0f172a', '#1e293b', '#1e4560', '#132e40']);
const SKIP = new Set([
  'pages/AcceptQuotePage.jsx', 'pages/OptInConfirmedPage.jsx', 'shell/LoginPage.jsx',
  'modules/client-dashboard/PortalDashboardView.jsx',
].map((p) => path.join(ROOT, p)));

const args = new Set(process.argv.slice(2));
const lit = (n) => (n && (n.type === 'StringLiteral') ? n.value.toLowerCase() : null);

function visit(node, fn, names = []) {
  if (!node || typeof node.type !== 'string') return;
  let scope = names;
  // Remember the name of the variable / function we are inside, so style
  // helpers like `const btnPrimary = {...}` or `function btn(kind) {...}` can
  // be recognised.
  if (node.type === 'VariableDeclarator' && node.id?.name) scope = [...names, node.id.name];
  if ((node.type === 'FunctionDeclaration') && node.id?.name) scope = [...names, node.id.name];
  if (node.type === 'ObjectProperty' && (node.key?.name || node.key?.value)) scope = [...names, String(node.key.name || node.key.value)];
  fn(node, scope);
  for (const k of Object.keys(node)) {
    if (k === 'loc' || k === 'start' || k === 'end') continue;
    const v = node[k];
    if (Array.isArray(v)) v.forEach((c) => c && typeof c.type === 'string' && visit(c, fn, scope));
    else if (v && typeof v.type === 'string') visit(v, fn, scope);
  }
}

function transformFile(src, census) {
  let ast;
  try { ast = parse(src, { sourceType: 'module', plugins: ['jsx'] }); } catch { return { s: src, edits: 0 }; }
  const edits = [];
  const seen = new Set();
  const applyObject = (expr) => {
    if (seen.has(expr.start)) return;
    seen.add(expr.start);
    const prop = (name) => expr.properties.find((p) => p.type === 'ObjectProperty' && ((p.key.name || p.key.value) === name));
    const bgP = prop('background') || prop('backgroundColor');
    const colP = prop('color');
    if (!bgP) return;
    const bg = bgP.value;
    const bgv = lit(bg);
    const colv = lit(colP?.value);
    if (census) census.bg[bgv || bg.type] = (census.bg[bgv || bg.type] || 0) + 1;
    if (bgv && ((DARK_PRIMARY.has(bgv) && colv && LIGHT_TEXT.has(colv)) || (YELLOW.has(bgv) && colv && DARK_TEXT.has(colv)))) {
      edits.push([bg.start, bg.end, `'${OCEAN}'`]);
      if (YELLOW.has(bgv)) edits.push([colP.value.start, colP.value.end, `'#fff'`]);
    } else if (bg.type === 'ConditionalExpression') {
      for (const branch of [bg.consequent, bg.alternate]) {
        const v = lit(branch);
        if (v && DARK_PRIMARY.has(v)) edits.push([branch.start, branch.end, `'${OCEAN}'`]);
      }
    }
  };
  visit(ast.program, (n, names) => {
    // 1. inline style on a <button>
    if (n.type === 'JSXOpeningElement' && n.name.type === 'JSXIdentifier' && n.name.name === 'button') {
      const style = n.attributes.find((a) => a.type === 'JSXAttribute' && a.name.name === 'style');
      const expr = style?.value?.expression;
      if (expr && expr.type === 'ObjectExpression') applyObject(expr);
      else if (census) census.nonLiteral++;
      return;
    }
    // 2. a style object inside a button helper (btnPrimary, btnDark, btn(kind) …)
    if (n.type === 'ObjectExpression' && names.some((nm) => /btn|button/i.test(nm))) applyObject(n);
  });
  if (!edits.length) return { s: src, edits: 0 };
  edits.sort((a, b) => b[0] - a[0]);
  let s = src;
  for (const [a, b, r] of edits) s = s.slice(0, a) + r + s.slice(b);
  return { s, edits: edits.length };
}

module.exports = { transformFile };

if (require.main === module) {
  const walk = (dir, out = []) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, out);
      else if (/\.jsx?$/.test(e.name) && !SKIP.has(p)) out.push(p);
    }
    return out;
  };
  const census = args.has('--census') ? { bg: {}, nonLiteral: 0 } : null;
  let files = 0, total = 0;
  for (const f of walk(ROOT)) {
    const src = fs.readFileSync(f, 'utf8');
    const { s, edits } = transformFile(src, census);
    if (edits) { files++; total += edits; if (!args.has('--dry') && !census) fs.writeFileSync(f, s); }
  }
  if (census) {
    const top = Object.entries(census.bg).sort((a, b) => b[1] - a[1]).slice(0, 25);
    console.log('button backgrounds:', JSON.stringify(Object.fromEntries(top)), 'style not an object literal:', census.nonLiteral);
  }
  console.log(`${args.has('--dry') || census ? '[dry] ' : ''}${total} edits across ${files} files`);
}
