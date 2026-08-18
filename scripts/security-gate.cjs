#!/usr/bin/env node
/**
 * security-gate — block security-relevant commits until the posture audit is clean.
 *
 * Why this exists: on 2026-08-18 a Supabase advisor email surfaced two leftover
 * backup tables with RLS off. Auditing outward from there found four more real
 * exposures, including five views that let anyone with the public anon key read 72
 * clients' bookkeeping data. None of it was in the RLS policies people read during
 * a review — it was all in grants, SECURITY DEFINER flags and PUBLIC ACLs. So the
 * check has to be mechanical, and it has to run before the commit, not after.
 *
 * Not every commit needs it. A CSS tweak does not touch exposure. This classifies
 * the staged diff and only gates when the diff plausibly changes who can see what.
 *
 * Usage:
 *   node scripts/security-gate.cjs assess   # classify staged diff, always exit 0
 *   node scripts/security-gate.cjs gate     # exit 2 (block) if risky and unaudited
 *   node scripts/security-gate.cjs pass 0   # record a clean audit for this tree
 *   node scripts/security-gate.cjs status    # show whether a valid pass is recorded
 *
 * The recorded pass is bound to a hash of the exact staged diff, so it cannot be
 * carried over to a later change — restage anything and the gate closes again.
 */

'use strict';

const { execFileSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const AUDIT_SQL = 'select * from public.security_posture_audit();';

// Paths where a change can plausibly alter who can read or write what.
const RISKY_PATHS = [
  { re: /^sql\//i, why: 'migration under sql/' },
  { re: /\.sql$/i, why: 'SQL file' },
  { re: /^supabase\/functions\//i, why: 'edge function' },
  { re: /^client-portal\//i, why: 'client portal — served to non-staff users' },
];

// Added lines that indicate an exposure-surface change. Matched against '+' lines
// only: removing a grant is not the risk, adding one is.
const RISKY_CONTENT = [
  { re: /\bsecurity\s+definer\b/i, why: 'SECURITY DEFINER — bypasses RLS' },
  { re: /\bsecurity_invoker\b/i, why: 'view security_invoker changed' },
  { re: /\bcreate\s+(or\s+replace\s+)?view\b/i, why: 'new or replaced view' },
  { re: /\bcreate\s+(or\s+replace\s+)?function\b/i, why: 'new or replaced function' },
  { re: /\bcreate\s+(table|materialized\s+view)\b/i, why: 'new table or matview — needs RLS' },
  { re: /\bselect\s+.*\binto\s+\w/i, why: 'SELECT INTO — creates a table with no RLS' },
  { re: /\bgrant\b/i, why: 'GRANT' },
  { re: /\brevoke\b/i, why: 'REVOKE — verify it is not a no-op against a PUBLIC grant' },
  { re: /\brow\s+level\s+security\b/i, why: 'RLS toggled' },
  { re: /\b(create|alter|drop)\s+policy\b/i, why: 'RLS policy changed' },
  { re: /\bservice_role\b/i, why: 'service_role referenced' },
  { re: /\banon\b/i, why: 'anon role referenced' },
  { re: /ANON_KEY/i, why: 'anon key referenced' },
  { re: /\.rpc\(/, why: 'new RPC call from the client' },
  { re: /\bauth\.uid\(\)/i, why: 'auth.uid() — access-scoping logic' },
  { re: /\bbackup\b/i, why: 'something named "backup" — the 2026-08-18 leak was a backup table' },
];

function repoRoot() {
  return execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
}

function stagedDiff(root) {
  return execFileSync('git', ['diff', '--cached'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
}

function stagedFiles(root) {
  return execFileSync('git', ['diff', '--cached', '--name-only'], { cwd: root, encoding: 'utf8' })
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
}

function assess(root) {
  const files = stagedFiles(root);
  const diff = stagedDiff(root);
  const reasons = [];

  for (const f of files) {
    for (const { re, why } of RISKY_PATHS) {
      if (re.test(f)) reasons.push(`${f}: ${why}`);
    }
  }

  const added = diff
    .split('\n')
    .filter((l) => l.startsWith('+') && !l.startsWith('+++'))
    .join('\n');

  for (const { re, why } of RISKY_CONTENT) {
    if (re.test(added)) reasons.push(`staged diff: ${why}`);
  }

  return {
    files,
    hash: crypto.createHash('sha256').update(diff).digest('hex'),
    risky: reasons.length > 0 && files.length > 0,
    reasons: [...new Set(reasons)],
  };
}

function tokenPath(root) {
  return path.join(root, '.claude', '.security-gate-pass');
}

function readToken(root) {
  try {
    return JSON.parse(fs.readFileSync(tokenPath(root), 'utf8'));
  } catch {
    return null;
  }
}

const BLOCK_MESSAGE = (reasons, hash) =>
  [
    'SECURITY GATE: this commit changes an exposure surface and has not been audited.',
    '',
    'Why it was flagged:',
    ...reasons.map((r) => `  - ${r}`),
    '',
    'Before committing, run the posture audit against the database:',
    '',
    `  ${AUDIT_SQL}`,
    '',
    'It must return ZERO rows. Any row is a live exposure — fix it, do not explain it away.',
    'Then record the clean result for this exact staged tree:',
    '',
    '  node scripts/security-gate.cjs pass 0',
    '',
    `(staged tree ${hash.slice(0, 12)} — restaging anything invalidates the pass)`,
    '',
    'What the audit cannot see, and you must check by hand if this diff adds either:',
    '  - a new view: does a portal client (authenticated, non-staff) get zero rows?',
    '  - a new definer RPC: does a portal-client JWT get 42501 rather than a result?',
    'Impersonate rather than reading the policy text — querying as postgres proves nothing,',
    'because postgres bypasses RLS. See sql/234 and the Security gate section of CLAUDE.md.',
  ].join('\n');

function main() {
  const cmd = process.argv[2] || 'assess';
  let root;
  try {
    root = repoRoot();
  } catch {
    process.exit(0); // not a git repo — nothing to gate
  }

  if (cmd === 'gate') {
    // Called from the PreToolUse hook with the tool payload on stdin. Exit fast
    // unless this really is a commit.
    let payload = '';
    try {
      payload = fs.readFileSync(0, 'utf8');
    } catch {
      /* no stdin */
    }
    let command = '';
    try {
      command = JSON.parse(payload)?.tool_input?.command || '';
    } catch {
      command = payload;
    }
    // Match a command that actually RUNS the commit — at the start of the string or
    // after a shell operator — rather than one that merely mentions the words inside a
    // quoted string, which would block innocent calls that talk about committing.
    // --no-verify is deliberately not an escape hatch: that skips git's own hooks, not this.
    // Leading git global options are skipped, including the ones that take a separate
    // value (`git -C /repo commit`), so the matcher still finds the subcommand.
    const GIT_OPTS =
      '(?:(?:-[cC]|--git-dir|--work-tree|--namespace|--exec-path)\\s+\\S+\\s+|--?\\S+\\s+)*';
    const RUNS_COMMIT = new RegExp(
      `(?:^|[;&|]|\\n)\\s*(?:sudo\\s+)?git\\s+${GIT_OPTS}commit\\b`
    );
    if (!RUNS_COMMIT.test(command)) process.exit(0);

    const a = assess(root);
    if (!a.risky) process.exit(0);

    const tok = readToken(root);
    if (tok && tok.hash === a.hash && tok.findings === 0) process.exit(0);

    process.stderr.write(BLOCK_MESSAGE(a.reasons, a.hash) + '\n');
    process.exit(2); // exit 2 = block the tool call, stderr goes back to Claude
  }

  if (cmd === 'pass') {
    const findings = Number(process.argv[3]);
    if (!Number.isInteger(findings)) {
      console.error('Usage: node scripts/security-gate.cjs pass <numberOfAuditFindings>');
      process.exit(1);
    }
    if (findings !== 0) {
      console.error(
        `Refusing to record a pass: the audit returned ${findings} finding(s). Fix them first.`
      );
      process.exit(1);
    }
    const a = assess(root);
    fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
    fs.writeFileSync(
      tokenPath(root),
      JSON.stringify({ hash: a.hash, findings: 0, files: a.files }, null, 2)
    );
    console.log(`Recorded clean audit for staged tree ${a.hash.slice(0, 12)}.`);
    process.exit(0);
  }

  if (cmd === 'status') {
    const a = assess(root);
    const tok = readToken(root);
    const valid = !!(tok && tok.hash === a.hash && tok.findings === 0);
    console.log(`staged tree : ${a.hash.slice(0, 12)}`);
    console.log(`risky       : ${a.risky ? 'YES' : 'no'}`);
    console.log(`audit pass  : ${valid ? 'valid' : 'none for this tree'}`);
    process.exit(0);
  }

  // assess
  const a = assess(root);
  if (!a.files.length) {
    console.log('No staged changes.');
    process.exit(0);
  }
  console.log(`Staged files: ${a.files.length}`);
  console.log(`Staged tree : ${a.hash.slice(0, 12)}`);
  if (!a.risky) {
    console.log('Classification: CLEAR — no exposure surface touched, no audit required.');
    process.exit(0);
  }
  console.log('Classification: SECURITY-RELEVANT — audit required before commit.');
  for (const r of a.reasons) console.log(`  - ${r}`);
  process.exit(0);
}

main();
