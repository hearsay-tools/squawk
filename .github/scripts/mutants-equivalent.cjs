'use strict';
// The optional equivalent-mutant records (spec Decisions 2), read by the PR job and the
// whole-file command (hearsay-tools/cezarion#2282). Matching uses full source text.
// Each source file has its own record file, `<EQUIVALENT_DIR>/<source path>.json`, so two
// changes that add entries for different source files do not conflict
// (hearsay-tools/squawk#4362). An entry holds no `file`: the reader takes it from the path.
const fs = require('node:fs');
const path = require('node:path');

const EQUIVALENT_DIR = '.github/mutants/equivalent';
const FIELDS = ['function', 'mutator', 'original', 'replacement', 'reason'];

function checkEntries(entries) {
  if (!Array.isArray(entries)) throw new Error('expected an array');
  if (!entries.length) throw new Error('expected at least one entry; delete an empty file');
  if (entries.some(entry => entry && Object.hasOwn(entry, 'file'))) {
    throw new Error('an entry must not hold file; the record path names the source file');
  }
  if (entries.some(entry => !entry || FIELDS.some(key => typeof entry[key] !== 'string' || !entry[key].trim()))) {
    throw new Error('each entry needs non-empty function, mutator, original, replacement and reason strings');
  }
  if (entries.some(entry => entry.site !== undefined && (typeof entry.site !== 'string' || !entry.site.trim()))) {
    throw new Error('site must be a non-empty source prefix string');
  }
}

/** Every record file below dir, as `/`-separated paths relative to dir, in a stable order. */
function recordFiles(dir, io, relative = '') {
  const names = io.readdirSync(path.join(dir, relative), { withFileTypes: true })
    .map(entry => ({ name: entry.name, directory: entry.isDirectory() }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return names.flatMap(({ name, directory }) => {
    const child = relative ? `${relative}/${name}` : name;
    if (directory) return recordFiles(dir, io, child);
    if (!name.endsWith('.json')) throw new Error(`${child} is not a .json record file`);
    return [child];
  });
}

/** Read the optional records without making a broken record stop the advisory report. */
function readEquivalent(dir = EQUIVALENT_DIR, io = fs) {
  let current = '';
  try {
    const entries = [];
    for (const record of recordFiles(dir, io)) {
      current = `${record}: `;
      const rows = JSON.parse(io.readFileSync(path.join(dir, record), 'utf8'));
      checkEntries(rows);
      const file = record.slice(0, -'.json'.length);
      entries.push(...rows.map(row => ({ file, ...row })));
    }
    return { entries, warning: '' };
  } catch (error) {
    if (error.code === 'ENOENT' && !current) return { entries: [], warning: '' };
    return { entries: [], warning: `Could not read equivalent mutants: ${`${current}${error.message}`.replace(/\s+/g, ' ').slice(0, 240)}` };
  }
}

/** Exact line prefix before the mutant, with indentation removed and trailing spaces kept. */
function sourceSite(source, { start }) {
  return source.split('\n')[start.line - 1]?.slice(0, start.column - 1).trimStart();
}

function matchesEntry(entry, mutant) {
  return entry.file === mutant.file && entry.mutator === mutant.mutator
    && (entry.site === undefined || entry.site === mutant.site)
    && entry.original === mutant.original
    && entry.replacement === mutant.replacement
    && (typeof mutant.function === 'string' && entry.function === mutant.function);
}

const findEquivalent = (entries, mutant) => entries.find(entry => matchesEntry(entry, mutant));

module.exports = { EQUIVALENT_DIR, readEquivalent, matchesEntry, findEquivalent, sourceSite };
