#!/usr/bin/env node
'use strict';

// not-selected: scripts/e2e-affected.mjs --ci chose to run no spec on a pull request.
// Only the PR step accepts it, with --allow-not-selected; the merge queue runs every spec.
function lastE2eStatus(text) {
  const matches = [...String(text).matchAll(/^TEST_E2E_STATUS=(passed|skipped|failed|not-selected)\s*$/gm)];
  return matches.length ? matches[matches.length - 1][1] : null;
}

function main(text, argv = []) {
  const status = lastE2eStatus(text);
  if (status === 'passed') return 0;
  if (status === 'not-selected' && argv.includes('--allow-not-selected')) return 0;
  process.stderr.write(
    `Cockpit browser E2E must pass in CI; got TEST_E2E_STATUS=${status ?? 'missing'}\n`,
  );
  return 1;
}

if (require.main === module) {
  const fs = require('node:fs');
  process.exit(main(fs.readFileSync(0, 'utf8'), process.argv.slice(2)));
}

module.exports = { lastE2eStatus, main };
