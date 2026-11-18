'use strict';

// The release build artifact (hearsay-tools/squawk#3321). The `build` job of release.yml
// installs and builds without `id-token: write`, then packs what the publishing jobs read:
// the release tooling's compiled modules from the dispatch commit, and the candidate's
// build outputs from the source commit. The publishing jobs check out both commits with
// no install and no build, verify the artifact against the digest the `build` job passed
// as a job output, and copy the outputs into the checkouts before `npm publish`.
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const MANIFEST = 'release-build.json';
const FORMAT = 1;

// Build outputs per checkout. Each root is a directory or one file, relative to the checkout.
const ROOTS = {
  tooling: ['packages/cezar/dist'],
  source: ['packages/cezar/dist', 'packages/cezar/web/dist', 'packages/cezar/README.md'],
};

// Files the publication cannot run without. Tooling: every module scripts/release.mjs
// imports (release-build.test.cjs keeps this list in step with its imports).
const REQUIRED = {
  tooling: [
    'packages/cezar/dist/core/product-env.js',
    'packages/cezar/dist/release/manifests.js',
    'packages/cezar/dist/release/compatibility.js',
    'packages/cezar/dist/release/publication.js',
    'packages/cezar/dist/release/snapshot.js',
    'packages/cezar/dist/release/stable.js',
  ],
  source: [
    'packages/cezar/dist/index.js',
    'packages/cezar/dist/hsq.js',
    'packages/cezar/web/dist/index.html',
    'packages/cezar/README.md',
  ],
};

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
  const [side, ...rest] = file.split('/');
  const rel = rest.join('/');
  if (!ROOTS[side] || rest.some((part) => part === '' || part === '.' || part === '..')) return false;
  return ROOTS[side].some((root) => rel === root || rel.startsWith(`${root}/`));
}

function checkHeads({ toolingRoot, sourceRoot, sourceSha, dispatchSha, head }) {
  if (!isSha(sourceSha) || !isSha(dispatchSha)) throw new Error('release build: the planned source and dispatch commits must be full SHAs.');
  const source = head(sourceRoot);
  if (source !== sourceSha) throw new Error(`release build: the source checkout is at ${source}, not the planned source commit ${sourceSha}.`);
  const tooling = head(toolingRoot);
  if (tooling !== dispatchSha) throw new Error(`release build: the tooling checkout is at ${tooling}, not the dispatch commit ${dispatchSha}.`);
}

/** Copy the build outputs of both checkouts into `out` with a manifest; return its digest. */
function packBuild({ toolingRoot, sourceRoot, sourceSha, dispatchSha, out, head = gitHead }) {
  checkHeads({ toolingRoot, sourceRoot, sourceSha, dispatchSha, head });
  const checkouts = { tooling: toolingRoot, source: sourceRoot };
  fs.rmSync(out, { recursive: true, force: true });
  const files = [];
  for (const [side, roots] of Object.entries(ROOTS)) {
    const listed = roots.flatMap((root) => listFiles(checkouts[side], root));
    const missing = REQUIRED[side].filter((file) => !listed.includes(file));
    if (missing.length) throw new Error(`release build: the ${side} build has no ${missing.join(', ')}.`);
    for (const rel of listed) {
      const bytes = fs.readFileSync(path.join(checkouts[side], rel));
      const target = path.join(out, side, rel);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, bytes);
      files.push({ path: `${side}/${rel}`, sha256: sha256(bytes) });
    }
  }
  const manifest = `${JSON.stringify({ format: FORMAT, sourceSha, dispatchSha, files }, null, 2)}\n`;
  fs.writeFileSync(path.join(out, MANIFEST), manifest);
  return sha256(manifest);
}

/**
 * Verify a downloaded artifact before publication, then copy its outputs into the
 * checkouts. Any changed, missing, extra or misplaced file, or a commit other than the
 * planned ones, throws before anything is copied.
 */
function verifyBuild({ dir, digest, toolingRoot, sourceRoot, sourceSha, dispatchSha, head = gitHead }) {
  if (!/^[a-f0-9]{64}$/.test(digest ?? '')) throw new Error('release build: the build job passed no artifact digest.');
  const bytes = fs.readFileSync(path.join(dir, MANIFEST));
  if (sha256(bytes) !== digest) throw new Error('release build: the artifact manifest does not match the digest of the build job.');
  const manifest = JSON.parse(bytes.toString('utf8'));
  if (manifest.format !== FORMAT) throw new Error(`release build: unknown artifact format ${manifest.format}.`);
  if (manifest.sourceSha !== sourceSha) throw new Error(`release build: the artifact was built from ${manifest.sourceSha}, not the planned source commit ${sourceSha}.`);
  if (manifest.dispatchSha !== dispatchSha) throw new Error(`release build: the artifact tooling was built from ${manifest.dispatchSha}, not the dispatch commit ${dispatchSha}.`);
  checkHeads({ toolingRoot, sourceRoot, sourceSha, dispatchSha, head });

  const expected = new Map(manifest.files.map((file) => [file.path, file.sha256]));
  if (expected.size !== manifest.files.length) throw new Error('release build: the artifact manifest lists a file twice.');
  const present = Object.keys(ROOTS).flatMap((side) => listFiles(dir, side));
  const extra = fs.readdirSync(dir).filter((name) => name !== MANIFEST && !ROOTS[name]);
  for (const file of [...present, ...extra]) {
    if (!expected.has(file)) throw new Error(`release build: the artifact holds ${file}, which its manifest does not list.`);
  }
  for (const [file, hash] of expected) {
    if (!allowed(file)) throw new Error(`release build: the artifact manifest lists ${file}, outside the build outputs.`);
    const full = path.join(dir, file);
    if (!fs.lstatSync(full, { throwIfNoEntry: false })?.isFile()) throw new Error(`release build: the artifact has no ${file}.`);
    if (sha256(fs.readFileSync(full)) !== hash) throw new Error(`release build: ${file} differs from the artifact manifest.`);
  }
  for (const [side, required] of Object.entries(REQUIRED)) {
    const missing = required.filter((file) => !expected.has(`${side}/${file}`));
    if (missing.length) throw new Error(`release build: the ${side} build has no ${missing.join(', ')}.`);
  }

  const checkouts = { tooling: toolingRoot, source: sourceRoot };
  for (const file of expected.keys()) {
    const [side, ...rest] = file.split('/');
    const target = path.join(checkouts[side], ...rest);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(dir, file), target);
  }
  return { files: expected.size };
}

function main(argv, env = process.env) {
  const common = {
    toolingRoot: env.GITHUB_WORKSPACE,
    sourceRoot: path.join(env.GITHUB_WORKSPACE, 'source'),
    sourceSha: env.SOURCE_SHA,
    dispatchSha: env.DISPATCH_SHA,
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

module.exports = { MANIFEST, REQUIRED, ROOTS, packBuild, verifyBuild };
