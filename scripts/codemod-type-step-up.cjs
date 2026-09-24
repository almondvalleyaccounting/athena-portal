#!/usr/bin/env node
/**
 * One-off codemod for Sprint 3 of the 2026-09-24 UI audit (Bobby: "one step up").
 *
 *  1. Text one step larger. Inline font sizes (numeric, '12px' strings, and
 *     fontSize={12} / fontSize="12" props on SVG) move:
 *        <= 13.5  → +1      (labels 10 → 11, body 12 → 13, 13 → 14)
 *        14–15.5 → +0.5    (keeps the order: 13.5 → 14.5, 14 → 14.5, 15 → 15.5)
 *        >= 16    unchanged (headings and big figures)
 *     Tailwind arbitrary sizes text-[Npx] follow the same rule; text-xs is
 *     moved in tailwind.config.js.
 *  2. Small all-caps labels become sentence case: textTransform 'uppercase'
 *     (and the letterSpacing that went with it) is removed from style objects,
 *     and `uppercase` / `tracking-wide*` from className strings.
 *
 * Skips files that draw PDFs or exports, where sizes are print layout.
 * Usage: node scripts/codemod-type-step-up.cjs [--dry]
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', 'src');
const SKIP = new Set([
  'lib/exportUtils.js',
  'lib/quotePdf.js',
  'modules/forecast/lib/export/exportPdf.js',
  'modules/forecast/lib/export/pdfCharts.js',
  'modules/pd-tracker/lib/oneToOnePdf.js',
].map((p) => path.join(ROOT, p)));
const dry = process.argv.includes('--dry');

function step(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return v;
  let out = n;
  if (n <= 13.5) out = n + 1;
  else if (n <= 15.5) out = n + 0.5;
  return String(out);
}

function transform(src) {
  let s = src;
  let changes = 0;
  const bump = (re, fn) => { s = s.replace(re, (...m) => { const r = fn(...m); if (r !== m[0]) changes++; return r; }); };

  // 1. font sizes
  bump(/(fontSize:\s*)(\d+(?:\.\d+)?)(?![\d.]|px)/g, (m, pre, v) => pre + step(v));
  bump(/(fontSize:\s*)(['"])(\d+(?:\.\d+)?)px\2/g, (m, pre, q, v) => `${pre}${q}${step(v)}px${q}`);
  bump(/(fontSize:\s*[^,}?\n]+\?\s*)(\d+(?:\.\d+)?)(\s*:\s*)(\d+(?:\.\d+)?)(?![\d.])/g,
    (m, pre, a, mid, b) => pre + step(a) + mid + step(b));
  bump(/(fontSize=\{)(\d+(?:\.\d+)?)(\})/g, (m, pre, v, post) => pre + step(v) + post);
  bump(/(fontSize=")(\d+(?:\.\d+)?)(")/g, (m, pre, v, post) => pre + step(v) + post);
  bump(/(text-\[)(\d+(?:\.\d+)?)(px\])/g, (m, pre, v, post) => pre + step(v) + post);

  // 2. all-caps labels → sentence case (inline style objects)
  const dropProp = (obj, re) => {
    const lead = new RegExp(re.source + /\s*,\s*/.source);
    const trail = new RegExp(/\s*,?\s*/.source + re.source);
    return lead.test(obj) ? obj.replace(lead, '') : obj.replace(trail, '');
  };
  bump(/\{[^{}]*textTransform:\s*['"]uppercase['"][^{}]*\}/g, (obj) => {
    let o = dropProp(obj, /textTransform:\s*['"]uppercase['"]/);
    o = dropProp(o, /letterSpacing:\s*(?:'[^']*'|"[^"]*"|[\d.]+)/);
    return o;
  });
  // …and Tailwind class strings
  bump(/className=(["'`])([^"'`]*\buppercase\b[^"'`]*)\1/g, (m, q, cls) =>
    `className=${q}${cls.replace(/\s*\buppercase\b/g, '').replace(/\s*\btracking-(?:wide|wider|widest)\b/g, '').replace(/\s{2,}/g, ' ').trim()}${q}`);

  return { s, changes };
}

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(jsx?|tsx?)$/.test(e.name) && !SKIP.has(p)) out.push(p);
  }
  return out;
}

module.exports = { transform, step };
if (require.main === module) {
let files = 0, total = 0;
for (const f of walk(ROOT)) {
  const src = fs.readFileSync(f, 'utf8');
  const { s, changes } = transform(src);
  if (changes && s !== src) {
    files++; total += changes;
    if (!dry) fs.writeFileSync(f, s);
  }
}
console.log(`${dry ? '[dry] ' : ''}${total} edits across ${files} files`);
}
