const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { MANIFEST, packBuild, requiredFiles, verifyBuild } = require('./release-build.cjs');

const SOURCE = 'a'.repeat(40);
const sha256 = (text) => createHash('sha256').update(text).digest('hex');

const listed = (root) => fs.readdirSync(root, { recursive: true, withFileTypes: true })
  .filter((entry) => entry.isFile()).map((entry) => path.relative(root, path.join(entry.parentPath, entry.name)));

function write(root, rel, text = rel) {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), text);
}

const BIN = { cezarion: 'dist/index.js', cez: 'dist/index.js', hsq: 'dist/hsq.js' };
const REQUIRED = ['packages/cezar/dist/index.js', 'packages/cezar/dist/hsq.js', 'packages/cezar/web/dist/index.html', 'packages/cezar/README.md'];

function fixture(t, bin = BIN) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'release-build-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'source');
  for (const file of new Set(Object.values(bin))) write(source, `packages/cezar/${file}`);
  for (const file of ['packages/cezar/web/dist/index.html', 'packages/cezar/README.md', 'packages/cezar/web/dist/assets/app.js']) write(source, file);
  const manifest = JSON.stringify({ name: '@wjarka/cezarion', bin });
  write(source, 'packages/cezar/package.json', manifest);
  const heads = { [source]: SOURCE };
  const head = (dir) => heads[dir];
  const out = path.join(root, 'artifact');
  const digest = packBuild({ sourceRoot: source, sourceSha: SOURCE, out, head });
  // The publishing job starts from a clean checkout of the same commit: no build outputs.
  const publish = path.join(root, 'publish');
  write(publish, 'packages/cezar/package.json', manifest);
  heads[publish] = SOURCE;
  const verify = (change = {}) => verifyBuild({ dir: out, digest, sourceRoot: publish, sourceSha: SOURCE, head, ...change });
  return { root, source, out, digest, heads, head, publish, verify };
}

test('a verified artifact puts the built outputs into the publishing checkout', (t) => {
  const f = fixture(t);
  const manifest = JSON.parse(fs.readFileSync(path.join(f.out, MANIFEST), 'utf8'));
  assert.equal(manifest.sourceSha, SOURCE);
  assert.ok(!manifest.files.some((file) => file.path.endsWith('package.json')), 'checked-in files come from the checkout');
  assert.deepEqual(f.verify(), { files: manifest.files.length });
  assert.equal(fs.readFileSync(path.join(f.publish, 'packages/cezar/web/dist/assets/app.js'), 'utf8'), 'packages/cezar/web/dist/assets/app.js');
  for (const file of REQUIRED) assert.ok(fs.existsSync(path.join(f.publish, file)), file);
});

test('the required files follow the candidate manifest, so a rollback to a commit before an entry still builds', (t) => {
  const f = fixture(t, { cezarion: 'dist/index.js', cez: 'dist/index.js' });
  assert.deepEqual(requiredFiles(f.source), ['packages/cezar/dist/index.js', 'packages/cezar/web/dist/index.html', 'packages/cezar/README.md']);
  assert.ok(f.verify().files > 0);
  assert.deepEqual(requiredFiles(fixture(t).source).sort(), [...REQUIRED].sort());
});

test('the build job refuses an incomplete build or a checkout at another commit', (t) => {
  const f = fixture(t);
  const pack = (change = {}) => packBuild({ sourceRoot: f.source, sourceSha: SOURCE, out: path.join(f.root, 'again'), head: f.head, ...change });
  fs.rmSync(path.join(f.source, 'packages/cezar/web/dist/index.html'));
  assert.throws(() => pack(), /the build has no packages\/cezar\/web\/dist\/index\.html/);
  assert.throws(() => pack({ sourceSha: 'c'.repeat(40) }), /the source checkout is at a{40}, not the planned source commit c{40}/);
  assert.throws(() => pack({ sourceSha: 'main' }), /full SHA/);
});

const rejections = [
  ['a changed file', (f) => fs.appendFileSync(path.join(f.out, 'packages/cezar/dist/index.js'), 'evil'), /packages\/cezar\/dist\/index\.js differs from the artifact manifest/],
  ['a missing file', (f) => fs.rmSync(path.join(f.out, 'packages/cezar/dist/hsq.js')), /has no packages\/cezar\/dist\/hsq\.js/],
  ['an extra file', (f) => write(f.out, 'packages/cezar/dist/extra.js'), /holds packages\/cezar\/dist\/extra\.js, which its manifest does not list/],
  ['an extra file outside the outputs', (f) => write(f.out, 'scripts/release.mjs'), /holds scripts\/release\.mjs/],
  ['a link', (f) => fs.symlinkSync('/etc/passwd', path.join(f.out, 'packages/cezar/dist/link.js')), /is a link/],
  ['a changed manifest', (f) => fs.appendFileSync(path.join(f.out, MANIFEST), ' '), /does not match the digest of the build job/],
];

for (const [name, change, error] of rejections) {
  test(`verification stops on ${name} and copies nothing`, (t) => {
    const f = fixture(t);
    change(f);
    assert.throws(() => f.verify(), error);
    assert.deepEqual(listed(f.publish), ['packages/cezar/package.json']);
  });
}

test('verification stops on a manifest that lists a path outside the build outputs, even with a matching digest', (t) => {
  const f = fixture(t);
  const file = path.join(f.out, MANIFEST);
  const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
  write(f.out, 'scripts/release.mjs', 'injected');
  manifest.files.push({ path: 'scripts/release.mjs', sha256: sha256('injected') });
  const text = JSON.stringify(manifest);
  fs.writeFileSync(file, text);
  assert.throws(() => f.verify({ digest: sha256(text) }), /lists scripts\/release\.mjs, outside the build outputs/);
  assert.deepEqual(listed(f.publish), ['packages/cezar/package.json']);
});

test('verification stops on another commit than the plan names', (t) => {
  const f = fixture(t);
  assert.throws(() => f.verify({ sourceSha: 'c'.repeat(40) }), /built from a{40}, not the planned source commit c{40}/);
  f.heads[f.publish] = 'd'.repeat(40);
  assert.throws(() => f.verify(), /the source checkout is at d{40}/);
  assert.throws(() => f.verify({ digest: '' }), /passed no artifact digest/);
});

test('the release tooling loads from the dispatch checkout source, never from a build', () => {
  const script = fs.readFileSync(path.join(__dirname, '..', '..', 'scripts', 'release.mjs'), 'utf8');
  const imports = [...script.matchAll(/from '(\.[^']+)'/g)].map((match) => match[1]);
  assert.ok(imports.length > 0);
  for (const specifier of imports) assert.match(specifier, /^\.\.\/packages\/cezar\/src\/.+\.ts$/, specifier);
});
