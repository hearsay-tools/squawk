'use strict';

// The release build artifact (hearsay-tools/squawk#3321). The `build` job of release.yml
// installs and builds the candidate without `id-token: write`, then packs its build
// outputs. The publishing jobs check out the candidate with no install and no build,
// verify the artifact against the digest the `build` job passed as a job output, and copy
// the outputs into the checkout before `npm publish`. The artifact holds package data
// only: nothing in it runs in a publishing job. The release tooling loads from the
// dispatch checkout's TypeScript source, which no install script could have changed.
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const MANIFEST = 'release-build.json';
const FORMAT = 1;

// The candidate's build outputs. Each root is a directory or one file, relative to the
// checkout. Checked-in files come from the publishing job's own checkout.
const ROOTS = ['packages/cezar/dist', 'packages/cezar/web/dist', 'packages/cezar/README.md'];

// Files the published package cannot work without: every `bin` entry its own manifest
// declares (a rollback candidate can predate an entry), the cockpit and the README.
function requiredFiles(sourceRoot) {
  const manifest = JSON.parse(fs.readFileSync(path.join(sourceRoot, 'packages/cezar/package.json'), 'utf8'));
  const bins = Object.values(manifest.bin ?? {}).map((bin) => path.posix.join('packages/cezar', bin));
  return [...new Set([...bins, 'packages/cezar/web/dist/index.html', 'packages/cezar/README.md'])];
}

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const gitHead = (root) => execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
const isSha = (value) => /^[a-f0-9]{40}$/.test(value ?? '');

function listFiles(root, rel) {
  const full = path.join(root, rel);
  const stat = fs.lstatSync(full, { throwIfNoEntry: false });
  if (!stat) return [];
  if (stat.isSymbolicLink()) throw new Error(`release build: ${rel} is a link.`);
  if (stat.isFile()) return [rel];
  if (!stat.isDirectory()) throw new Error(`release build: ${rel} is not a file or a directory.`);
  return fs.readdirSync(full).sort().flatMap((name) => listFiles(root, path.posix.join(rel, name)));
}

function allowed(file) {
  if (file.split('/').some((part) => part === '' || part === '.' || part === '..')) return false;
  return ROOTS.some((root) => file === root || file.startsWith(`${root}/`));
}

function checkHead({ sourceRoot, sourceSha, head }) {
  if (!isSha(sourceSha)) throw new Error('release build: the planned source commit must be a full SHA.');
  const source = head(sourceRoot);
  if (source !== sourceSha) throw new Error(`release build: the source checkout is at ${source}, not the planned source commit ${sourceSha}.`);
}

/** Copy the candidate's build outputs into `out` with a manifest; return its digest. */
function packBuild({ sourceRoot, sourceSha, out, head = gitHead }) {
  checkHead({ sourceRoot, sourceSha, head });
  fs.rmSync(out, { recursive: true, force: true });
  const listed = ROOTS.flatMap((root) => listFiles(sourceRoot, root));
  const missing = requiredFiles(sourceRoot).filter((file) => !listed.includes(file));
  if (missing.length) throw new Error(`release build: the build has no ${missing.join(', ')}.`);
  const files = [];
  for (const rel of listed) {
    const bytes = fs.readFileSync(path.join(sourceRoot, rel));
    const target = path.join(out, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, bytes);
    files.push({ path: rel, sha256: sha256(bytes) });
  }
  const manifest = `${JSON.stringify({ format: FORMAT, sourceSha, files }, null, 2)}\n`;
  fs.writeFileSync(path.join(out, MANIFEST), manifest);
  return sha256(manifest);
}

/**
 * Verify a downloaded artifact before publication, then copy its outputs into the
 * checkout. Any changed, missing, extra or misplaced file, or a commit other than the
 * planned one, throws before anything is copied.
 */
function verifyBuild({ dir, digest, sourceRoot, sourceSha, head = gitHead }) {
  if (!/^[a-f0-9]{64}$/.test(digest ?? '')) throw new Error('release build: the build job passed no artifact digest.');
  const bytes = fs.readFileSync(path.join(dir, MANIFEST));
  if (sha256(bytes) !== digest) throw new Error('release build: the artifact manifest does not match the digest of the build job.');
  const manifest = JSON.parse(bytes.toString('utf8'));
  if (manifest.format !== FORMAT) throw new Error(`release build: unknown artifact format ${manifest.format}.`);
  if (manifest.sourceSha !== sourceSha) throw new Error(`release build: the artifact was built from ${manifest.sourceSha}, not the planned source commit ${sourceSha}.`);
  checkHead({ sourceRoot, sourceSha, head });

  const expected = new Map(manifest.files.map((file) => [file.path, file.sha256]));
  if (expected.size !== manifest.files.length) throw new Error('release build: the artifact manifest lists a file twice.');
  const present = listFiles(dir, '.').filter((file) => file !== MANIFEST);
  for (const file of present) {
    if (!expected.has(file)) throw new Error(`release build: the artifact holds ${file}, which its manifest does not list.`);
  }
  for (const [file, hash] of expected) {
    if (!allowed(file)) throw new Error(`release build: the artifact manifest lists ${file}, outside the build outputs.`);
    const full = path.join(dir, file);
    if (!fs.lstatSync(full, { throwIfNoEntry: false })?.isFile()) throw new Error(`release build: the artifact has no ${file}.`);
    if (sha256(fs.readFileSync(full)) !== hash) throw new Error(`release build: ${file} differs from the artifact manifest.`);
  }
  const missing = requiredFiles(sourceRoot).filter((file) => !expected.has(file));
  if (missing.length) throw new Error(`release build: the build has no ${missing.join(', ')}.`);

  for (const file of expected.keys()) {
    const target = path.join(sourceRoot, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(dir, file), target);
  }
  return { files: expected.size };
}

function main(argv, env = process.env) {
  const common = {
    sourceRoot: path.join(env.GITHUB_WORKSPACE, 'source'),
    sourceSha: env.SOURCE_SHA,
    dir: env.BUILD_DIR,
  };
  if (argv[0] === 'pack') {
    const digest = packBuild({ ...common, out: common.dir });
    console.log(`release build: packed ${common.dir}, manifest digest ${digest}`);
    if (env.GITHUB_OUTPUT) fs.appendFileSync(env.GITHUB_OUTPUT, `digest=${digest}\n`);
    return;
  }
  if (argv[0] === 'verify') {
    const { files } = verifyBuild({ ...common, digest: env.BUILD_DIGEST });
    console.log(`release build: verified ${files} files built from ${common.sourceSha} and copied them into the checkouts.`);
    return;
  }
  throw new Error('usage: release-build.cjs pack|verify');
}

if (require.main === module) {
  try { main(process.argv.slice(2)); } catch (error) {
    console.error(`::error::${error.message}`);
    process.exit(1);
  }
}

module.exports = { MANIFEST, ROOTS, packBuild, requiredFiles, verifyBuild };
