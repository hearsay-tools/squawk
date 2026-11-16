// Keep native runner discovery in sync with the canonical repository skills.
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..', '..');
const canonical = '.ai/skills';
const names = fs.readdirSync(path.join(root, canonical), { withFileTypes: true })
  .filter(entry => entry.isDirectory()).map(entry => entry.name).sort();

for (const mirror of ['.agents/skills', '.claude/skills']) {
  test(`${mirror} tracks one relative link for every repository skill`, () => {
    // Inspect tracked entries so npx skills installs and provisioning stay local.
    const tracked = execFileSync('git', ['ls-files', '-z', '--', mirror], { cwd: root, encoding: 'utf8' })
      .split('\0').filter(Boolean).map(file => file.slice(mirror.length + 1))
      .filter(file => file !== '.gitignore').sort();
    assert.deepEqual(tracked, names, `${mirror}: tracked links must match ${canonical} folders`);
    for (const name of names) {
      const link = path.join(root, mirror, name);
      assert.ok(fs.lstatSync(link).isSymbolicLink(), `${mirror}/${name} must be a symbolic link`);
      assert.equal(fs.readlinkSync(link), `../../${canonical}/${name}`);
      assert.equal(fs.realpathSync(link), fs.realpathSync(path.join(root, canonical, name)));
      assert.ok(fs.statSync(path.join(link, 'SKILL.md')).isFile());
    }
  });
}
