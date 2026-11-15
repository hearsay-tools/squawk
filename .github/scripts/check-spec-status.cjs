#!/usr/bin/env node
'use strict';

const { readdirSync, readFileSync } = require('node:fs');
const { join } = require('node:path');

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/;
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})\s*$/;

/** Return where the code span that opens with the backtick run at `start` ends, or -1 when it does not close. */
function codeSpanEnd(line, start, ticks) {
  const close = new RegExp(`(?<!\`)\`{${ticks}}(?!\`)`, 'g');
  close.lastIndex = start + ticks;
  const match = close.exec(line);
  return match ? match.index + ticks : -1;
}

/** Return whether the line leaves an HTML comment open, given whether it starts inside one. */
function endsInComment(line, inComment) {
  let at = 0;
  for (;;) {
    if (inComment) {
      const close = line.indexOf('-->', at);
      if (close < 0) return true;
      at = close + 3;
      inComment = false;
      continue;
    }
    const open = line.indexOf('<!--', at);
    const tick = /`+/g;
    tick.lastIndex = at;
    const run = tick.exec(line);
    if (run && (open < 0 || run.index < open)) {
      const end = codeSpanEnd(line, run.index, run[0].length);
      at = end < 0 ? run.index + run[0].length : end;
      continue;
    }
    if (open < 0) return false;
    at = open + 4;
    inComment = true;
  }
}

/** Return the first heading line that sits outside HTML comments and code fences, or -1. */
function titleIndex(lines) {
  let fence = null;
  let inComment = false;
  for (const [index, line] of lines.entries()) {
    if (fence) {
      const close = FENCE_CLOSE.exec(line);
      if (close && close[1][0] === fence[0] && close[1].length >= fence.length) fence = null;
    } else if (inComment) {
      inComment = endsInComment(line, true);
    } else if (FENCE_OPEN.test(line)) {
      fence = FENCE_OPEN.exec(line)[1];
    } else {
      inComment = endsInComment(line, false);
      if (/^#\s+\S/.test(line)) return inComment ? -1 : index;
    }
  }
  return -1;
}

/** Return whether the first heading has a valid status on the next line. */
function hasValidStatus(source) {
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  const title = titleIndex(lines);
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
