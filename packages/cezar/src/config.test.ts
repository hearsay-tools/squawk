import { sealTestRunners } from './core/runner-registry.testkit.ts';
import { Home } from './home/home.ts';
import { useTestHome } from './home/test-home.testkit.ts';
import { testHome } from './home/test-home.testkit.ts';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { projectPaths } from './project-paths.ts';
import { writeMergedConfig } from './server/config-merge.ts';
import { loadConfig, readRawConfig, resolveWorktreeRetention, updateConfigFile } from './config.ts';
import { claudeRunner } from './runners/claude/definition.ts';
import { codexRunner } from './runners/codex/definition.ts';
import { opencodeRunner } from './runners/opencode/definition.ts';

sealTestRunners(claudeRunner, codexRunner, opencodeRunner);

// `defaultModels` is a record keyed by registered id, and the cases use several runners' keys.

/**
 * `config.json` schema roundtrips (R2 2.3: `systemPrompt?`). The invariants
 * under test: the key is additive (old files keep loading exactly as before),
 * a bad value degrades per-key instead of discarding the whole config, and
 * the value is trimmed with blank treated as unset.
 */
describe('loadConfig systemPrompt', () => {
  let repoRoot: string;

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-config-'));
    mkdirSync(join(repoRoot, '.ai/cezar'), { recursive: true });
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  const write = (value: unknown) =>
    writeFileSync(join(repoRoot, '.ai/cezar', 'config.json'), JSON.stringify(value), 'utf8');

  it('is undefined when no config file exists (zero-config default)', async () => {
    const config = await loadConfig(repoRoot, testHome());
    expect(config.systemPrompt).toBeUndefined();
  });

  it('old config files without the key still load unchanged (additive proof)', async () => {
    write({ maxParallel: 5, defaultRunner: 'codex', baseBranch: 'develop' });
    const config = await loadConfig(repoRoot, testHome());
    expect(config.systemPrompt).toBeUndefined();
    expect(config.maxParallel).toBe(5);
    expect(config.defaultRunner).toBe('codex');
    expect(config.baseBranch).toBe('develop');
    expect(config.defaultModels).toBeUndefined();
    expect(config.worktreeRetention).toBe(10);
  });

  it('loads config.json with old skillsRepos and drops that key', async () => {
    write({ skillsRepos: [{ repo: 'acme/team-skills' }], maxParallel: 5, reviewGate: true });
    const config = await loadConfig(repoRoot, testHome());
    expect(config).not.toHaveProperty('skillsRepos');
    expect(config.maxParallel).toBe(5);
    expect(config.reviewGate).toBe(true);
    expect(JSON.parse(readFileSync(join(repoRoot, '.ai/cezar/config.json'), 'utf8'))).toHaveProperty('skillsRepos');
  });

  it('roundtrips a configured prompt, trimmed', async () => {
    write({ systemPrompt: '  Always answer in Polish.  ' });
    expect((await loadConfig(repoRoot, testHome())).systemPrompt).toBe('Always answer in Polish.');
  });

  it('treats a whitespace-only prompt as unset without touching other keys', async () => {
    write({ systemPrompt: '   ', maxParallel: 3 });
    const config = await loadConfig(repoRoot, testHome());
    expect(config.systemPrompt).toBeUndefined();
    expect(config.maxParallel).toBe(3);
  });

  it.each([
    ['over-long', 'x'.repeat(20_001), 4],
    ['wrong-typed', 42, 6],
  ])('degrades a %s prompt to unset per-key, keeping the rest', async (_label, systemPrompt, maxParallel) => {
    write({ systemPrompt, maxParallel });
    const config = await loadConfig(repoRoot, testHome());
    expect(config.systemPrompt).toBeUndefined();
    expect(config.maxParallel).toBe(maxParallel);
  });

  it('accepts a prompt at exactly the 20k cap', async () => {
    write({ systemPrompt: 'x'.repeat(20_000) });
    expect((await loadConfig(repoRoot, testHome())).systemPrompt).toHaveLength(20_000);
  });

  it('malformed JSON degrades to the full default (never throws)', async () => {
    writeFileSync(join(repoRoot, '.ai/cezar', 'config.json'), '{not json', 'utf8');
    const config = await loadConfig(repoRoot, testHome());
    expect(config.systemPrompt).toBeUndefined();
    expect(config.maxParallel).toBe(2);
  });

  /** `defaultModels?` (R6 1.5) rides the same additive-key rules as `systemPrompt`. */
  describe('defaultModels', () => {
    it('round-trips per-runner presets, trimmed', async () => {
      write({ defaultModels: { claude: ' opus ', opencode: 'openai/gpt-5.1' } });
      expect((await loadConfig(repoRoot, testHome())).defaultModels).toEqual({
        claude: 'opus',
        opencode: 'openai/gpt-5.1',
      });
    });

    it('degrades a bad value to unset per-key, keeping the rest of the config', async () => {
      write({ defaultModels: { claude: 42 }, maxParallel: 6 });
      const config = await loadConfig(repoRoot, testHome());
      expect(config.defaultModels).toBeUndefined();
      expect(config.maxParallel).toBe(6);
    });

    it('keeps a key for a runner no registered definition took, and drops a bad value for a registered one', async () => {
      // A config written before the runner-definitions slice, including a key no registered
      // definition took, loads with the same values: the known keys parse, the unknown key is
      // kept and ignored until that runner loads.
      write({ defaultModels: { claude: 'opus', ghost: 'gpt-x' } });
      expect((await loadConfig(repoRoot, testHome())).defaultModels).toEqual({ claude: 'opus', ghost: 'gpt-x' });

      write({ defaultModels: { claude: '', ghost: 'kept' }, maxParallel: 4 });
      const config = await loadConfig(repoRoot, testHome());
      expect(config.defaultModels).toEqual({ ghost: 'kept' });
      expect(config.maxParallel).toBe(4);

      write({ defaultModels: { claude: 'opus', ghost: null } });
      expect((await loadConfig(repoRoot, testHome())).defaultModels).toEqual({ claude: 'opus' });

      write({ defaultModels: { '': 'model', ['p'.repeat(65)]: 'model', [`gh${String.fromCharCode(10)}ost`]: 'model', ' padded ': 'model', ghost: 'gpt-x' } });
      expect((await loadConfig(repoRoot, testHome())).defaultModels).toEqual({ ghost: 'gpt-x' });
    });
  });

  it('keeps an unregistered defaultRunner and model key on disk across an unrelated settings write', async () => {
    write({ defaultRunner: 'ghost', defaultModels: { claude: 'opus', ghost: 'gpt-x' } });
    const dataDir = join(repoRoot, '.ai/cezar');
    expect(await writeMergedConfig(dataDir, { maxParallel: 4 })).toBeUndefined();
    expect(await writeMergedConfig(dataDir, { defaultModels: { codex: 'o3' } })).toBeUndefined();
    const raw = JSON.parse(readFileSync(join(dataDir, 'config.json'), 'utf8')) as Record<string, unknown>;
    expect(raw).toMatchObject({ defaultRunner: 'ghost', maxParallel: 4 });
    expect(raw.defaultModels).toEqual({ claude: 'opus', ghost: 'gpt-x', codex: 'o3' });
    const config = await loadConfig(repoRoot, testHome());
    expect(config.defaultRunner).toBe('ghost');
    expect(config.defaultModels).toEqual({ claude: 'opus', ghost: 'gpt-x', codex: 'o3' });
  });

  describe('modelsLocked', () => {
    it('is optional and preserves only boolean values', async () => {
      expect((await loadConfig(repoRoot, testHome())).modelsLocked).toBeUndefined();

      write({ modelsLocked: true });
      expect((await loadConfig(repoRoot, testHome())).modelsLocked).toBe(true);

      write({ modelsLocked: 'yes', defaultRunner: 'codex' });
      const config = await loadConfig(repoRoot, testHome());
      expect(config.modelsLocked).toBeUndefined();
      expect(config.defaultRunner).toBe('codex');
    });
  });

  /** `worktreeRetention` (#483): count-based, always materialized (default 10),
   *  `.catch(10)` so a bad value degrades to the default. `0` = unlimited. */
  describe('worktreeRetention', () => {
    it('round-trips a configured count', async () => {
      write({ worktreeRetention: 3 });
      expect((await loadConfig(repoRoot, testHome())).worktreeRetention).toBe(3);
    });

    it('keeps 0 as a meaningful value (unlimited)', async () => {
      write({ worktreeRetention: 0 });
      expect((await loadConfig(repoRoot, testHome())).worktreeRetention).toBe(0);
    });

    it.each([-4, 'lots'])('degrades invalid retention %s to 10 without changing other keys', async worktreeRetention => {
      write({ worktreeRetention, maxParallel: 6 });
      const config = await loadConfig(repoRoot, testHome());
      expect(config.worktreeRetention).toBe(10);
      expect(config.maxParallel).toBe(6);
    });
  });
});

/**
 * `resolveWorktreeRetention` — what every enforcement site (boot sweeps,
 * terminal transitions, the reclaim route) asks instead of reading the parsed
 * `worktreeRetention`. The workspace's `resources.worktreeRetentionDefault`
 * only *seeds* repos that set none, which is exactly what Settings → Worktrees
 * tells the user, so the precedence is the contract under test here.
 */
describe('resolveWorktreeRetention', () => {
  let repoRoot: string;
  let cezHome: string;
  const savedHome = process.env.CEZ_HOME;

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-retention-'));
    mkdirSync(join(repoRoot, '.ai/cezar'), { recursive: true });
    // Pinned so the suite never reads (or writes) the developer's real ~/.cezar.
    cezHome = mkdtempSync(join(tmpdir(), 'cez-home-'));
    useTestHome(cezHome ? Home.sandbox(cezHome) : undefined);
  });

  afterEach(() => {
    if (savedHome === undefined) useTestHome(undefined);
    else useTestHome(savedHome ? Home.sandbox(savedHome) : undefined);
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(cezHome, { recursive: true, force: true });
  });

  const writeRepo = (value: unknown) =>
    writeFileSync(join(repoRoot, '.ai/cezar', 'config.json'), JSON.stringify(value), 'utf8');
  const writeWorkspace = (value: unknown) =>
    Home.seedBytes(Home.sandbox(cezHome), Home.sandbox(cezHome).workspaceConfig, Buffer.from(JSON.stringify(value)));

  it('inherits the workspace default when the repo sets nothing', async () => {
    writeWorkspace({ resources: { worktreeRetentionDefault: 4 } });
    expect(await resolveWorktreeRetention(repoRoot, testHome())).toBe(4);
  });

  it('inherits it when the repo has no config file at all', async () => {
    rmSync(join(repoRoot, '.ai/cezar'), { recursive: true, force: true });
    writeWorkspace({ resources: { worktreeRetentionDefault: 7 } });
    expect(await resolveWorktreeRetention(repoRoot, testHome())).toBe(7);
  });

  it('inherits 0 (unlimited) — the workspace default is a value, not a truthiness test', async () => {
    writeWorkspace({ resources: { worktreeRetentionDefault: 0 } });
    expect(await resolveWorktreeRetention(repoRoot, testHome())).toBe(0);
  });

  it("keeps the repo's own value, workspace default ignored", async () => {
    writeRepo({ worktreeRetention: 3 });
    writeWorkspace({ resources: { worktreeRetentionDefault: 99 } });
    expect(await resolveWorktreeRetention(repoRoot, testHome())).toBe(3);
  });

  it('keeps a repo value that happens to equal the historical default (10 is not a sentinel)', async () => {
    writeRepo({ worktreeRetention: 10 });
    writeWorkspace({ resources: { worktreeRetentionDefault: 2 } });
    expect(await resolveWorktreeRetention(repoRoot, testHome())).toBe(10);
  });

  it("keeps the repo's explicit 0 over the workspace default", async () => {
    writeRepo({ worktreeRetention: 0 });
    writeWorkspace({ resources: { worktreeRetentionDefault: 5 } });
    expect(await resolveWorktreeRetention(repoRoot, testHome())).toBe(0);
  });

  it('falls back to 10 when the workspace config is absent', async () => {
    writeRepo({ maxParallel: 5 });
    expect(await resolveWorktreeRetention(repoRoot, testHome())).toBe(10);
  });

  it('falls back to 10 when the workspace config is corrupt (unreadable)', async () => {
    Home.seedBytes(Home.sandbox(cezHome), Home.sandbox(cezHome).workspaceConfig, Buffer.from('{ not json'));
    expect(await resolveWorktreeRetention(repoRoot, testHome())).toBe(10);
  });

  it('falls back to 10 when the workspace default itself is out of bounds', async () => {
    writeWorkspace({ resources: { worktreeRetentionDefault: -1 } });
    expect(await resolveWorktreeRetention(repoRoot, testHome())).toBe(10);
  });

  it('treats a repo value the schema would refuse as unset, so the workspace seeds it', async () => {
    writeRepo({ worktreeRetention: 'lots' });
    writeWorkspace({ resources: { worktreeRetentionDefault: 6 } });
    expect(await resolveWorktreeRetention(repoRoot, testHome())).toBe(6);
  });

  it('treats a malformed repo config as unset', async () => {
    writeFileSync(join(repoRoot, '.ai/cezar', 'config.json'), '{ nope', 'utf8');
    writeWorkspace({ resources: { worktreeRetentionDefault: 8 } });
    expect(await resolveWorktreeRetention(repoRoot, testHome())).toBe(8);
  });
});

/**
 * Machine-wide agent defaults (spec 2026-07-29-agent-profiles): what a repo that has set none of
 * its own runs, so a second login and a model preference are configured once instead of per
 * checkout.
 *
 * The load-bearing property is that these are DEFAULTS. A repo key always wins, and the fallback is
 * applied to the RAW object before parsing — `defaultRunner`'s `.default('claude')` materializes the
 * key, so after a parse there is no telling "the user chose claude" from "the user said nothing".
 */
describe('loadConfig machine-wide agent defaults', () => {
  let repoRoot: string;
  let cezHome: string;
  const savedHome = process.env.CEZ_HOME;

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-machine-defaults-'));
    cezHome = mkdtempSync(join(tmpdir(), 'cez-machine-home-'));
    mkdirSync(join(repoRoot, '.ai/cezar'), { recursive: true });
    useTestHome(cezHome ? Home.sandbox(cezHome) : undefined);
  });

  afterEach(() => {
    if (savedHome === undefined) useTestHome(undefined);
    else useTestHome(savedHome ? Home.sandbox(savedHome) : undefined);
    for (const dir of [repoRoot, cezHome]) rmSync(dir, { recursive: true, force: true });
  });

  const writeRepo = (value: unknown) =>
    writeFileSync(join(repoRoot, '.ai/cezar', 'config.json'), JSON.stringify(value), 'utf8');
  const writeMachine = (agentDefaults: unknown) =>
    Home.seedBytes(Home.sandbox(cezHome), Home.sandbox(cezHome).workspaceConfig, Buffer.from(JSON.stringify({ agentDefaults })));

  it('fills a repo that has no config file at all', async () => {
    writeMachine({ runner: 'codex', models: { codex: 'gpt-5' } });
    const config = await loadConfig(repoRoot, testHome());
    expect(config.defaultRunner).toBe('codex');
    expect(config.defaultModels?.codex).toBe('gpt-5');
  });

  it('fills a repo whose config says nothing about the runner', async () => {
    writeMachine({ runner: 'codex' });
    writeRepo({ systemPrompt: 'be brief' });
    expect((await loadConfig(repoRoot, testHome())).defaultRunner).toBe('codex');
  });

  it('NEVER overrules a repo that chose — that is what makes it a default', async () => {
    writeMachine({ runner: 'codex' });
    writeRepo({ defaultRunner: 'claude' });
    expect((await loadConfig(repoRoot, testHome())).defaultRunner).toBe('claude');
  });

  it('merges models per RUNNER, so pinning one does not discard the others', async () => {
    // Whole-object precedence would silently drop the machine's codex preset the moment a repo
    // pinned claude's — a loss nobody asked for and nothing would report.
    writeMachine({ models: { claude: 'machine-claude', codex: 'machine-codex' } });
    writeRepo({ defaultModels: { claude: 'repo-claude' } });
    const config = await loadConfig(repoRoot, testHome());
    expect(config.defaultModels).toEqual({ claude: 'repo-claude', codex: 'machine-codex' });
  });

  it('changes nothing when the machine has no opinion — the zero-config path', async () => {
    writeRepo({ systemPrompt: 'be brief' });
    const config = await loadConfig(repoRoot, testHome());
    expect(config.defaultRunner).toBe('claude');
    expect(config.defaultModels).toBeUndefined();
  });

  it('degrades to the built-in default when the machine file is corrupt', async () => {
    Home.seedBytes(Home.sandbox(cezHome), Home.sandbox(cezHome).workspaceConfig, Buffer.from('{not json'));
    expect((await loadConfig(repoRoot, testHome())).defaultRunner).toBe('claude');
  });

  it('keeps a machine runner no definition registered, and drops one the stored bound refuses', async () => {
    writeMachine({ runner: 'not-an-agent' });
    writeRepo({ systemPrompt: 'be brief' });
    const kept = await loadConfig(repoRoot, testHome());
    expect(kept.defaultRunner).toBe('not-an-agent');
    expect(kept.systemPrompt).toBe('be brief');

    writeMachine({ runner: `bad${String.fromCharCode(10)}id` });
    const dropped = await loadConfig(repoRoot, testHome());
    expect(dropped.defaultRunner).toBe('claude');
    expect(dropped.systemPrompt).toBe('be brief');
  });

  it('keeps an unregistered repo runner and drops an illegal one without losing the file', async () => {
    writeRepo({ defaultRunner: 'ghost', systemPrompt: 'be brief' });
    expect((await loadConfig(repoRoot, testHome())).defaultRunner).toBe('ghost');

    writeRepo({ defaultRunner: `gho${String.fromCharCode(10)}st`, maxParallel: 3 });
    const config = await loadConfig(repoRoot, testHome());
    expect(config.defaultRunner).toBe('claude');
    expect(config.maxParallel).toBe(3);
  });
});

/** #917: `worktreeSetup` is parsed loosely here so a bad value can never reset the whole file;
 *  `resolveWorktreeSetup` judges it and the run reports it. */
describe('loadConfig worktreeSetup', () => {
  let repoRoot: string;

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-config-setup-'));
    mkdirSync(join(repoRoot, '.ai/cezar'), { recursive: true });
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  it('an invalid worktreeSetup keeps every other key', async () => {
    writeFileSync(
      join(repoRoot, '.ai/cezar', 'config.json'),
      JSON.stringify({ systemPrompt: 'keep me', worktreeSetup: { commands: 'npm ci' } }),
      'utf8',
    );
    const config = await loadConfig(repoRoot, testHome());
    expect(config.systemPrompt).toBe('keep me');
    expect(config.worktreeSetup).toEqual({ commands: 'npm ci' });
  });

  it('is undefined when the key is absent', async () => {
    expect((await loadConfig(repoRoot, testHome())).worktreeSetup).toBeUndefined();
  });
});

describe('readRawConfig and updateConfigFile (hearsay-tools/cezarion#279)', () => {
  let dataDir: string;
  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'cez-config-write-'));
  });
  afterEach(() => rmSync(dataDir, { recursive: true, force: true }));
  const path = () => join(dataDir, 'config.json');

  it('reads a missing file as an empty object and keeps unknown keys', async () => {
    expect(await readRawConfig(dataDir)).toEqual({ ok: true, raw: {} });
    writeFileSync(path(), JSON.stringify({ mine: 1, skillsRepos: [{ repo: 'a/b' }] }));
    expect(await readRawConfig(dataDir)).toEqual({ ok: true, raw: { mine: 1, skillsRepos: [{ repo: 'a/b' }] } });
  });

  it('reports malformed JSON and a non-object', async () => {
    for (const text of ['{ nope', '[]']) {
      writeFileSync(path(), text);
      const read = await readRawConfig(dataDir);
      expect(read.ok).toBe(false);
      if (!read.ok) expect(read.issue.startsWith(`${path()} cannot be read: `)).toBe(true);
    }
  });

  it.each(['cezar', 'squawk'])('names the project config file it read in .ai/%s', async folder => {
    const root = mkdtempSync(join(tmpdir(), 'cez-config-issue-'));
    try {
      mkdirSync(join(root, '.ai', folder), { recursive: true });
      writeFileSync(join(root, '.ai', folder, 'config.json'), '{ nope');
      const read = await readRawConfig(projectPaths(root).write);
      expect(read.ok).toBe(false);
      if (!read.ok) expect(read.issue).toMatch(new RegExp(`^\\.ai/${folder}/config\\.json cannot be read: `));
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('serializes concurrent writers, so neither drops the other one\'s key', async () => {
    writeFileSync(path(), JSON.stringify({ base: true }));
    const set = (key: string) => updateConfigFile(dataDir, (current) =>
      current.ok ? { write: { ...current.raw, [key]: true }, result: key } : { refuse: 'refused' });
    expect(await Promise.all([set('one'), set('two'), set('three')])).toEqual(['one', 'two', 'three']);
    expect(JSON.parse(readFileSync(path(), 'utf8'))).toEqual({ base: true, one: true, two: true, three: true });
  });

  it('writes nothing on a refusal and leaves no temporary file', async () => {
    writeFileSync(path(), '{ nope');
    expect(await updateConfigFile(dataDir, () => ({ refuse: 'no' }))).toBe('no');
    expect(readFileSync(path(), 'utf8')).toBe('{ nope');
    await updateConfigFile(dataDir, () => ({ write: { fresh: 1 }, result: undefined }));
    expect(readdirSync(dataDir)).toEqual(['config.json']);
  });
});
