#!/usr/bin/env node
/**
 * P3 design sprint: list <button> elements whose look does not yet come from
 * the shared BTN definition (src/lib/buttonStyles.js) or the <Btn> component.
 * Counts per file; with --detail prints each button's line and style source.
 * Read-only.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { parse } = require('@babel/parser');

const ROOT = path.join(__dirname, '..', 'src');
const PORTAL = new Set(['PortalDashboardView.jsx', 'StatementTables.jsx', 'TabErrorBoundary.jsx', 'DashboardCharts.jsx', 'ReportView.jsx']
  .map((n) => path.join(ROOT, 'modules', 'client-dashboard', n)));
const walk = (d, o = []) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p, o); else if (/\.jsx$/.test(e.name)) o.push(p); } return o; };
const detail = process.argv.includes('--detail');

const perFile = {};
let total = 0;
for (const f of walk(ROOT)) {
  if (PORTAL.has(f)) continue;
  const src = fs.readFileSync(f, 'utf8');
  let ast; try { ast = parse(src, { sourceType: 'module', plugins: ['jsx'] }); } catch { continue; }
  const rows = [];
  const visit = (n) => {
    if (!n || typeof n.type !== 'string') return;
    if (n.type === 'JSXOpeningElement' && n.name.type === 'JSXIdentifier' && n.name.name === 'button') {
      const st = n.attributes.find((a) => a.type === 'JSXAttribute' && a.name.name === 'style');
      const cls = n.attributes.find((a) => a.type === 'JSXAttribute' && a.name.name === 'className');
      const styleSrc = st ? src.slice(st.value.start, st.value.end) : '';
      const clsSrc = cls ? src.slice(cls.value.start, cls.value.end) : '';
      if (!/BTN\./.test(styleSrc)) rows.push({ line: n.loc.start.line, style: styleSrc.replace(/\s+/g, ' ').slice(0, 90), cls: clsSrc.slice(0, 60) });
    }
    for (const k of Object.keys(n)) { if (k === 'loc' || k === 'start' || k === 'end') continue; const v = n[k]; if (Array.isArray(v)) v.forEach(visit); else if (v && typeof v.type === 'string') visit(v); }
  };
  visit(ast.program);
  if (rows.length) { perFile[path.relative(ROOT, f).split(path.sep).join('/')] = rows; total += rows.length; }
}
const files = Object.entries(perFile).sort((a, b) => b[1].length - a[1].length);
for (const [f, rows] of files) {
  console.log(`${rows.length}\t${f}`);
  if (detail) rows.forEach((r) => console.log(`\t  ${r.line}: style=${r.style || '—'} class=${r.cls || '—'}`));
}
console.log(`${total} buttons in ${files.length} files`);
