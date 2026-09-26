#!/bin/sh
# Money-logic tests before a commit lands (tests/money, `npm test`).
# Runs only when the commit touches code the tests cover. Installed as
# .git/hooks/pre-commit, which git does not version: on a fresh clone run
#   cp scripts/pre-commit-tests.sh .git/hooks/pre-commit
# The Vercel build runs the same tests, so skipping this only moves the
# failure to the deploy.
if git diff --cached --name-only | grep -qE '^(src/|tests/|package(-lock)?\.json$|vitest\.config\.js$)'; then
  echo "pre-commit: running money-logic tests..."
  npx vitest run --reporter=dot || {
    echo "pre-commit: tests failed; commit blocked. Run 'npm test' to see which."
    exit 1
  }
fi
