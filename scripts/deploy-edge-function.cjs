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

/**
 * The deployed function's current verify_jwt, or null if it does not exist yet.
 * Read rather than assumed, so a redeploy cannot change how a function is
 * authenticated as a side effect of shipping a code change.
 */
async function currentVerifyJwt(slug) {
  const resp = await fetch(
    `https://api.supabase.com/v1/projects/${PROJECT_REF}/functions/${encodeURIComponent(slug)}`,
    { headers: { Authorization: `Bearer ${accessToken()}` } },
  );
  if (resp.status === 404) return null;
  if (!resp.ok) {
    throw new Error(
      `Could not read current verify_jwt for ${slug} (${resp.status}). ` +
      `Refusing to deploy blind — pass --verify-jwt=true or --verify-jwt=false explicitly.`,
    );
  }
  const body = await resp.json();
  return body.verify_jwt !== false;
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

/**
 * Remove a function from the platform entirely. For a dead endpoint, deletion beats a
 * guard: there is no code left to be reached. The source stays in git history, so a
 * redeploy restores it. Requires --yes, because this cannot be undone from here.
 */
async function deleteFunction(slug) {
  const url = `https://api.supabase.com/v1/projects/${PROJECT_REF}/functions/${encodeURIComponent(slug)}`;
  const resp = await fetch(url, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${accessToken()}` },
  });
  if (!resp.ok) {
    console.error(`FAILED ${resp.status}: ${(await resp.text()).slice(0, 400)}`);
    process.exit(1);
  }
  console.log(`deleted ${slug} from project ${PROJECT_REF}`);
}

async function main() {
  const [slug, ...rest] = process.argv.slice(2);
  if (!slug) {
    console.error('Usage: node scripts/deploy-edge-function.cjs <slug> [--verify-jwt=true|false] [--dry-run]');
    console.error('       node scripts/deploy-edge-function.cjs <slug> --delete --yes');
    process.exit(1);
  }

  if (rest.includes('--delete')) {
    if (!rest.includes('--yes')) {
      console.error(`Refusing to delete ${slug} without --yes. Check for callers first.`);
      process.exit(1);
    }
    await deleteFunction(slug);
    return;
  }

  const dryRun = rest.includes('--dry-run');
  const jwtArg = rest.find((a) => a.startsWith('--verify-jwt='));

  // Preserve whatever the deployed function already uses. This defaulted to
  // true, so redeploying a function for an unrelated code change silently
  // turned on JWT verification. That is not a no-op: it is the difference
  // between a working OAuth callback and a blank error page, and between a
  // running cron and a silent one.
  //
  // On 2026-08-28 a batch redeploy did exactly that to four functions —
  // gmail-auth-callback (Google redirects the browser there with no
  // Authorization header, so reconnecting a mailbox died on
  // UNAUTHORIZED_NO_AUTH_HEADER) and comms-ingest, chase-reply-scan and
  // ch-code-chase, whose pg_cron wrappers post with only x-cron-secret.
  //
  // verify_jwt is a property of how a function is REACHED, not of the change
  // being deployed, so it now only moves when someone says so explicitly.
  let verifyJwt;
  if (jwtArg) {
    verifyJwt = jwtArg.split('=')[1] !== 'false';
  } else {
    const current = await currentVerifyJwt(slug);
    if (current === null) {
      // Brand new function: default to on, and say so.
      verifyJwt = true;
      console.log(`  (new function — defaulting verify_jwt=true; pass --verify-jwt=false for a public callback or a cron target that sends no Authorization header)`);
    } else {
      verifyJwt = current;
    }
  }

  const files = collectFiles(slug);
  const entrypoint = `functions/${slug}/index.ts`;

  console.log(`${slug}  verify_jwt=${verifyJwt}${jwtArg ? ' (explicit)' : ' (preserved)'}`);
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
