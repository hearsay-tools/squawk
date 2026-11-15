#!/usr/bin/env node
'use strict';

const { readdirSync, readFileSync } = require('node:fs');
const { join } = require('node:path');

/** Return whether the first heading has a valid status on the next line. */
function hasValidStatus(source) {
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  const title = lines.findIndex((line) => /^#\s+\S/.test(line));
  return title >= 0 && /^Status: (?:draft|active|done|superseded(?: by \S+\.md)?)$/.test(lines[title + 1] ?? '');
}

function checkDirectory(directory) {
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
    .filter((entry) => !hasValidStatus(readFileSync(join(directory, entry.name), 'utf8')))
    .map((entry) => join(directory, entry.name));
}

if (require.main === module) {
  const invalid = checkDirectory(process.argv[2] ?? '.ai/specs');
  for (const file of invalid) console.error(`${file}: add a valid Status line directly under the title`);
  process.exitCode = invalid.length ? 1 : 0;
}

module.exports = { hasValidStatus, checkDirectory };
