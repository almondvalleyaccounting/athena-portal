#!/usr/bin/env node
/**
 * Census for the P3 design sprint (UI audit 2026-09): every top-level
 * `const <name> = { … }` whose name looks like a button style, with the
 * background / colour / border / padding / size it sets. Read-only.
 *
 * Usage: node scripts/census-button-styles.cjs [--json]
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { parse } = require('@babel/parser');

const ROOT = path.join(__dirname, '..', 'src');
const NAME = /^(btn[A-Z]?\w*|\w*Btn\w*|button[A-Z]\w*)$/;
const walk = (d, o = []) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p, o); else if (/\.jsx?$/.test(e.name)) o.push(p); } return o; };
const lit = (n) => (n && (n.type === 'StringLiteral' || n.type === 'NumericLiteral') ? n.value : n ? `<${n.type}>` : undefined);

const out = [];
for (const f of walk(ROOT)) {
  const src = fs.readFileSync(f, 'utf8');
  let ast; try { ast = parse(src, { sourceType: 'module', plugins: ['jsx'] }); } catch { continue; }
  for (const st of ast.program.body) {
    const decl = st.type === 'VariableDeclaration' ? st : (st.type === 'ExportNamedDeclaration' && st.declaration?.type === 'VariableDeclaration' ? st.declaration : null);
    if (!decl) continue;
    for (const d of decl.declarations) {
      if (d.id.type !== 'Identifier' || !NAME.test(d.id.name) || d.init?.type !== 'ObjectExpression') continue;
      const props = {};
      let spread = false;
      for (const p of d.init.properties) {
        if (p.type === 'SpreadElement') { spread = true; continue; }
        const k = p.key.name || p.key.value; props[k] = lit(p.value);
      }
      out.push({ file: path.relative(ROOT, f).replace(/\\/g, '/'), name: d.id.name, spread, bg: props.background ?? props.backgroundColor, color: props.color, border: props.border, pad: props.padding, fs: props.fontSize, fw: props.fontWeight, r: props.borderRadius });
    }
  }
}
if (process.argv.includes('--json')) console.log(JSON.stringify(out, null, 1));
else { for (const o of out) console.log([o.file, o.name, o.spread ? 'SPREAD' : '', o.bg, o.color, o.border, o.pad, o.fs, o.fw, o.r].join(' | ')); console.log(out.length, 'style objects'); }
