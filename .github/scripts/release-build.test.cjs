const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { MANIFEST, REQUIRED, packBuild, verifyBuild } = require('./release-build.cjs');

const SOURCE = 'a'.repeat(40);
const DISPATCH = 'b'.repeat(40);

function write(root, rel, text = rel) {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), text);
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'release-build-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const tooling = path.join(root, 'tooling');
  const source = path.join(root, 'source');
  for (const file of REQUIRED.tooling) write(tooling, file);
  for (const file of REQUIRED.source) write(source, file);
  write(source, 'packages/cezar/web/dist/assets/app.js');
  write(source, 'packages/cezar/package.json', 'checked in, not built');
  const heads = { [tooling]: DISPATCH, [source]: SOURCE };
  const head = (dir) => heads[dir];
  const out = path.join(root, 'artifact');
  const digest = packBuild({ toolingRoot: tooling, sourceRoot: source, sourceSha: SOURCE, dispatchSha: DISPATCH, out, head });
  // The publishing job starts from clean checkouts: no build outputs.
  const pubTooling = path.join(root, 'pub-tooling');
  const pubSource = path.join(root, 'pub-source');
  fs.mkdirSync(pubTooling);
  fs.mkdirSync(pubSource);
  heads[pubTooling] = DISPATCH;
  heads[pubSource] = SOURCE;
  const verify = (change = {}) => verifyBuild({
    dir: out, digest, toolingRoot: pubTooling, sourceRoot: pubSource, sourceSha: SOURCE, dispatchSha: DISPATCH, head, ...change,
  });
  return { root, tooling, source, out, digest, heads, head, pubTooling, pubSource, verify };
}

test('a verified artifact puts the built outputs into both publishing checkouts', (t) => {
  const f = fixture(t);
  const manifest = JSON.parse(fs.readFileSync(path.join(f.out, MANIFEST), 'utf8'));
  assert.equal(manifest.sourceSha, SOURCE);
  assert.equal(manifest.dispatchSha, DISPATCH);
  assert.ok(!manifest.files.some((file) => file.path.endsWith('package.json')), 'checked-in files come from the checkout');
  assert.deepEqual(f.verify(), { files: manifest.files.length });
  assert.equal(fs.readFileSync(path.join(f.pubSource, 'packages/cezar/web/dist/assets/app.js'), 'utf8'), 'packages/cezar/web/dist/assets/app.js');
  for (const file of REQUIRED.tooling) assert.ok(fs.existsSync(path.join(f.pubTooling, file)), file);
  for (const file of REQUIRED.source) assert.ok(fs.existsSync(path.join(f.pubSource, file)), file);
});

test('the build job refuses an incomplete build or a checkout at another commit', (t) => {
  const f = fixture(t);
  const pack = (change = {}) => packBuild({
    toolingRoot: f.tooling, sourceRoot: f.source, sourceSha: SOURCE, dispatchSha: DISPATCH, out: path.join(f.root, 'again'), head: f.head, ...change,
  });
  fs.rmSync(path.join(f.source, 'packages/cezar/web/dist/index.html'));
  assert.throws(() => pack(), /the source build has no packages\/cezar\/web\/dist\/index\.html/);
  assert.throws(() => pack({ sourceSha: 'c'.repeat(40) }), /the source checkout is at a{40}, not the planned source commit c{40}/);
  assert.throws(() => pack({ sourceSha: 'main' }), /full SHAs/);
});

const rejections = [
  ['a changed file', (f) => fs.appendFileSync(path.join(f.out, 'source/packages/cezar/dist/index.js'), 'evil'), /source\/packages\/cezar\/dist\/index\.js differs from the artifact manifest/],
  ['a missing file', (f) => fs.rmSync(path.join(f.out, 'tooling/packages/cezar/dist/release/stable.js')), /has no tooling\/packages\/cezar\/dist\/release\/stable\.js/],
  ['an extra file', (f) => write(f.out, 'source/packages/cezar/dist/extra.js'), /holds source\/packages\/cezar\/dist\/extra\.js, which its manifest does not list/],
  ['an extra top-level entry', (f) => write(f.out, 'package.json'), /holds package\.json/],
  ['a link', (f) => fs.symlinkSync('/etc/passwd', path.join(f.out, 'source/packages/cezar/dist/link.js')), /is a link/],
  ['a changed manifest', (f) => fs.appendFileSync(path.join(f.out, MANIFEST), ' '), /does not match the digest of the build job/],
];

for (const [name, change, error] of rejections) {
  test(`verification stops on ${name} and copies nothing`, (t) => {
    const f = fixture(t);
    change(f);
    assert.throws(() => f.verify(), error);
    assert.deepEqual(fs.readdirSync(f.pubSource), []);
    assert.deepEqual(fs.readdirSync(f.pubTooling), []);
  });
}

test('verification stops on a manifest that lists a path outside the build outputs, even with a matching digest', (t) => {
  const f = fixture(t);
  const file = path.join(f.out, MANIFEST);
  const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
  write(f.out, 'source/packages/cezar/package.json', '{}');
  manifest.files.push({ path: 'source/packages/cezar/package.json', sha256: require('node:crypto').createHash('sha256').update('{}').digest('hex') });
  const text = JSON.stringify(manifest);
  fs.writeFileSync(file, text);
  const digest = require('node:crypto').createHash('sha256').update(text).digest('hex');
  assert.throws(() => f.verify({ digest }), /lists source\/packages\/cezar\/package\.json, outside the build outputs/);
});

test('verification stops on another commit than the plan names', (t) => {
  const f = fixture(t);
  assert.throws(() => f.verify({ sourceSha: 'c'.repeat(40) }), /built from a{40}, not the planned source commit c{40}/);
  assert.throws(() => f.verify({ dispatchSha: 'c'.repeat(40) }), /tooling was built from b{40}, not the dispatch commit c{40}/);
  f.heads[f.pubSource] = 'd'.repeat(40);
  assert.throws(() => f.verify(), /the source checkout is at d{40}/);
  assert.throws(() => f.verify({ digest: '' }), /passed no artifact digest/);
});

test('the required tooling files are exactly the compiled modules scripts/release.mjs imports', () => {
  const script = fs.readFileSync(path.join(__dirname, '..', '..', 'scripts', 'release.mjs'), 'utf8');
  const imports = [...script.matchAll(/from '\.\.\/(packages\/cezar\/dist\/[^']+)'/g)].map((match) => match[1]);
  assert.deepEqual([...new Set(imports)].sort(), [...REQUIRED.tooling].sort());
});
