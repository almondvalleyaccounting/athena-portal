#!/usr/bin/env node
/**
 * One-off codemod for Sprint 3 of the 2026-09-24 UI audit (Bobby: "full width
 * everywhere; we'll fix stretched forms by changing the forms").
 *
 * Removes the page-level width cap from page containers — a <div> style object
 * with a maxWidth AND a `margin: '0 auto'` or `padding:` — so every page uses
 * the whole screen. Left alone, deliberately:
 *   - dialogs, cards and panels (style has background / borderRadius / boxShadow
 *     / position / a spread like ...card);
 *   - <p> text blocks, whose maxWidth keeps a readable line length;
 *   - public pages clients see (quote acceptance, opt-in, login) and the
 *     preview of the client portal.
 * Also drops Tailwind max-w-4xl/5xl/6xl/7xl from page roots.
 *
 * Usage: node scripts/codemod-full-width.cjs [--dry]
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', 'src');
const SKIP = new Set([
  'pages/AcceptQuotePage.jsx',
  'pages/OptInConfirmedPage.jsx',
  'shell/LoginPage.jsx',
  'modules/client-dashboard/ClientViewPreview.jsx',
  'modules/client-dashboard/PortalDashboardView.jsx',
].map((p) => path.join(ROOT, p)));
const dry = process.argv.includes('--dry');

const DIV_STYLE = /<div(\s[^>]*?)?\sstyle=\{\{([^{}]*)\}\}/g;
const VAL = /maxWidth:\s*(?:[^,}]+?\?\s*)?(?:'[^']*'|"[^"]*"|[\d.]+)(?:\s*:\s*(?:'[^']*'|"[^"]*"|[\d.]+))?/.source;
const MAXW_LEAD = new RegExp(`${VAL}\\s*,\\s*`);   // maxWidth: X, <next>
const MAXW_TRAIL = new RegExp(`\\s*,?\\s*${VAL}\\s*$`); // <prev>, maxWidth: X
function dropMaxWidth(obj) {
  if (MAXW_LEAD.test(obj)) return obj.replace(MAXW_LEAD, '');
  return obj.replace(MAXW_TRAIL, ' ');
}

function isPageContainer(obj) {
  if (!/maxWidth:/.test(obj)) return false;
  if (/\b(background|borderRadius|boxShadow|position)\s*:/.test(obj)) return false;
  if (/\.\.\./.test(obj)) return false;
  if (/maxWidth:\s*['"]\d+vw['"]/.test(obj)) return false;
  return /margin:\s*['"]0 auto['"]/.test(obj) || /\bpadding:/.test(obj);
}

function transform(src) {
  let changes = 0;
  let s = src.replace(DIV_STYLE, (m, attrs, obj) => {
    if (!isPageContainer(obj)) return m;
    const next = dropMaxWidth(obj);
    if (next === obj) return m;
    changes++;
    return m.replace(`{{${obj}}}`, `{{${next.replace(/\s{2,}/g, ' ')}}}`);
  });
  s = s.replace(/(className=["'][^"']*?)\s*\bmax-w-(?:4xl|5xl|6xl|7xl)\b/g, (m, pre) => { changes++; return pre; });
  return { s, changes };
}

module.exports = { transform, isPageContainer };

if (require.main === module) {
  const walk = (dir, out = []) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, out);
      else if (/\.jsx$/.test(e.name) && !SKIP.has(p)) out.push(p);
    }
    return out;
  };
  let files = 0, total = 0;
  const touched = [];
  for (const f of walk(ROOT)) {
    const src = fs.readFileSync(f, 'utf8');
    const { s, changes } = transform(src);
    if (changes && s !== src) {
      files++; total += changes; touched.push(path.relative(ROOT, f));
      if (!dry) fs.writeFileSync(f, s);
    }
  }
  console.log(`${dry ? '[dry] ' : ''}${total} caps removed across ${files} files`);
  if (dry) console.log(touched.join('\n'));
}
