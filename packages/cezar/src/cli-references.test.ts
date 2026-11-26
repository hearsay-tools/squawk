// Every `hsq <noun> <verb>` (or `cez …`) that skills, docs, shipped source text and the delegation
// prompt name must be a verb that noun's parser accepts (hearsay-tools/squawk#4293).
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { WORKER_OPERATIONS, MESSAGE_OPERATIONS } from './delegation/cli.ts';
import { OPERATIONS as TASK_OPERATIONS } from './task-cli/cli.ts';
import { AUTOMATION_COMMANDS } from './automations/automation-cli.ts';
import { WEBHOOK_COMMANDS } from './webhooks/cli.ts';
import { ARTIFACT_COMMANDS } from './artifacts/cli.ts';
import { JOB_ACTIONS } from './features/jobs/cli.ts';
import { BACKUP_COMMANDS } from './home/backup-args.ts';
import { PROJECTS_SUBCOMMANDS } from './workspace/projects-cli.ts';
import { DISCOVER_KINDS } from './discovery/cli.ts';
import { REMOTE_SETTINGS_COMMANDS } from './remote-settings-cli.ts';
import { provisionDelegationSession } from './delegation/provision.ts';
import { fixture } from './delegation/service.testkit.ts';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));

/** Each noun with verbs, read from the tables its parser checks. */
const VERBS: Record<string, readonly string[]> = {
  worker: WORKER_OPERATIONS, message: MESSAGE_OPERATIONS, task: Object.keys(TASK_OPERATIONS),
  automation: AUTOMATION_COMMANDS, webhook: WEBHOOK_COMMANDS, artifact: ARTIFACT_COMMANDS, job: JOB_ACTIONS,
  backup: BACKUP_COMMANDS, projects: PROJECTS_SUBCOMMANDS, discover: DISCOVER_KINDS,
  'remote-settings': REMOTE_SETTINGS_COMMANDS,
};
const NOUNS = Object.keys(VERBS).join('|');
const COMMAND = new RegExp(`\\b(?:hsq|cez) (${NOUNS}) ([a-z][a-z-]*)`, 'g');
/** The delegation prompt runs the bundled entry by path: `'…/index.ts' worker spawn`. */
const BUNDLED = new RegExp(`\\.(?:ts|js)' (${NOUNS}) ([a-z][a-z-]*)`, 'g');

const TEXT = /\.(?:md|mdx|ts|tsx|cjs|mjs|js|yml|yaml|json)$/;
const SKIP = /(?:^|\/)(?:node_modules|dist)(?:\/|$)|\.test\.tsx?$/;

function files(path: string): string[] {
  const absolute = join(ROOT, path);
  if (statSync(absolute).isFile()) return [path];
  return readdirSync(absolute, { recursive: true, encoding: 'utf8' })
    .map(entry => join(path, entry))
    .filter(entry => TEXT.test(entry) && !SKIP.test(entry) && statSync(join(ROOT, entry)).isFile());
}

/** `where: <noun> <verb>` for every reference the noun's parser rejects. */
function unknownVerbs(where: string, text: string, pattern: RegExp): string[] {
  const found: string[] = [];
  text.split('\n').forEach((line, index) => {
    for (const [, noun, verb] of line.matchAll(pattern)) {
      if (!VERBS[noun!]!.includes(verb!)) found.push(`${where}:${index + 1}: ${noun} ${verb} (known: ${VERBS[noun!]!.join(', ')})`);
    }
  });
  return found;
}

const SCANNED = ['AGENTS.md', 'README.md', '.ai/skills', 'docs', 'packages/cezar/src', 'packages/contract/src', 'packages/api-client/src', 'packages/web/src'];

describe('CLI references in skills, docs and shipped text', () => {
  it('reads a verb list for every noun', () => {
    for (const [noun, verbs] of Object.entries(VERBS)) expect(verbs.length, noun).toBeGreaterThan(0);
  });

  it('names only verbs the CLI accepts', () => {
    const scanned = SCANNED.flatMap(files);
    expect(scanned.length).toBeGreaterThan(100);
    const unknown = scanned.flatMap(path => unknownVerbs(relative(ROOT, join(ROOT, path)), readFileSync(join(ROOT, path), 'utf8'), COMMAND));
    expect(unknown).toEqual([]);
  });

  describe('the delegation prompt', () => {
    let f: ReturnType<typeof fixture> | undefined;
    afterEach(async () => { await f?.close(); f = undefined; });
    it('names only verbs the CLI accepts', () => {
      f = fixture();
      const session = provisionDelegationSession({ projectId: 'project', runId: f.parent.id, store: f.store, credentials: f.credentials, url: 'http://127.0.0.1:12345/api/v1/delegation' })!;
      expect(session.instructions.match(BUNDLED)?.length).toBeGreaterThan(10);
      expect(unknownVerbs('delegation prompt', session.instructions, BUNDLED)).toEqual([]);
    });
  });
});
