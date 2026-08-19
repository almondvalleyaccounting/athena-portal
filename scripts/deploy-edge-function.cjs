#!/usr/bin/env node
/**
 * deploy-edge-function — deploy one Supabase edge function from disk.
 *
 * There is no supabase CLI on this machine, and the MCP deploy tool needs every
 * file's content passed inline, which means transcribing 250-line _shared modules
 * by hand for each function. This reads them off disk instead, so what gets
 * deployed is exactly what is in the repo and reviewed.
 *
 * It follows the function's own relative imports (../_shared/*.ts) recursively and
 * includes them, using the path layout the Management API reports for already
 * deployed functions: functions/<slug>/index.ts + functions/_shared/<dep>.ts.
 *
 * Usage:
 *   node scripts/deploy-edge-function.cjs <slug> [--verify-jwt=true|false] [--dry-run]
 *
 * verify-jwt defaults to true. Pass false ONLY for an endpoint that is genuinely hit
 * without a JWT (an OAuth redirect, or a signed webhook). Note that verify_jwt=true is
 * NOT authentication: it accepts the public anon key, which ships in the frontend
 * bundle. The in-function check is the control. See _shared/require-staff.ts.
 *
 * The access token is read from ~/.claude.json (the same PAT the Supabase MCP uses)
 * and is never printed.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const PROJECT_REF = 'neksyvneljgxvpchwgch';
const FUNCTIONS_DIR = path.join(__dirname, '..', 'supabase', 'functions');

function accessToken() {
  const cfg = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude.json'), 'utf8'));
  for (const project of Object.values(cfg.projects || {})) {
    const token = project?.mcpServers?.supabase?.env?.SUPABASE_ACCESS_TOKEN;
    if (token) return token;
  }
  throw new Error('No SUPABASE_ACCESS_TOKEN found in ~/.claude.json');
}

/** Collect the entrypoint plus every relative .ts dependency it reaches. */
function collectFiles(slug) {
  const entry = path.join(FUNCTIONS_DIR, slug, 'index.ts');
  if (!fs.existsSync(entry)) throw new Error(`No such function: ${entry}`);

  const files = new Map(); // deployPath -> absolute path
  const seen = new Set();

  const visit = (absPath) => {
    const real = path.resolve(absPath);
    if (seen.has(real)) return;
    seen.add(real);

    const rel = path.relative(FUNCTIONS_DIR, real).split(path.sep).join('/');
    files.set(`functions/${rel}`, real);

    const src = fs.readFileSync(real, 'utf8');
    // Only relative specifiers are local files; https:// and jsr: resolve at runtime.
    const specifiers = [...src.matchAll(/from\s+["'](\.[^"']+)["']/g)].map((m) => m[1]);
    for (const spec of specifiers) {
      const dep = path.resolve(path.dirname(real), spec);
      if (fs.existsSync(dep)) visit(dep);
      else console.warn(`  ! unresolved import ${spec} in ${rel}`);
    }
  };

  visit(entry);
  return files;
}

async function main() {
  const [slug, ...rest] = process.argv.slice(2);
  if (!slug) {
    console.error('Usage: node scripts/deploy-edge-function.cjs <slug> [--verify-jwt=true|false] [--dry-run]');
    process.exit(1);
  }
  const dryRun = rest.includes('--dry-run');
  const jwtArg = rest.find((a) => a.startsWith('--verify-jwt='));
  const verifyJwt = jwtArg ? jwtArg.split('=')[1] !== 'false' : true;

  const files = collectFiles(slug);
  const entrypoint = `functions/${slug}/index.ts`;

  console.log(`${slug}  verify_jwt=${verifyJwt}`);
  for (const [deployPath, abs] of files) {
    const bytes = fs.statSync(abs).size;
    const gated = fs.readFileSync(abs, 'utf8').includes('requireStaffOrService');
    console.log(`  ${deployPath.padEnd(46)} ${String(bytes).padStart(6)}B${gated ? '  [has auth check]' : ''}`);
  }
  if (dryRun) {
    console.log('dry run — nothing deployed');
    return;
  }

  const form = new FormData();
  form.append(
    'metadata',
    new Blob([JSON.stringify({ name: slug, entrypoint_path: entrypoint, verify_jwt: verifyJwt })], {
      type: 'application/json',
    })
  );
  for (const [deployPath, abs] of files) {
    form.append('file', new Blob([fs.readFileSync(abs)], { type: 'text/typescript' }), deployPath);
  }

  const url = `https://api.supabase.com/v1/projects/${PROJECT_REF}/functions/deploy?slug=${encodeURIComponent(slug)}`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken()}` },
    body: form,
  });

  const text = await resp.text();
  if (!resp.ok) {
    console.error(`FAILED ${resp.status}: ${text.slice(0, 600)}`);
    process.exit(1);
  }
  let version = '?';
  try { version = JSON.parse(text).version ?? '?'; } catch { /* non-JSON is fine */ }
  console.log(`deployed ${slug} -> version ${version}`);
}

main().catch((err) => {
  console.error(String(err.message || err));
  process.exit(1);
});
