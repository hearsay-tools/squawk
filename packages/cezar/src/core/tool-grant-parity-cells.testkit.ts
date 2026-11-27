import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { AgentEvent, ToolGrant } from './agent-runner.ts';
import { TOOL_GRANT_KINDS } from './agent-runner-values.ts';
import { driveSeam } from './harness-parity-core.testkit.ts';
import { allowedToolsForStep, DEFAULT_ALLOWED_TOOLS } from '../workflows/types.ts';
import { runnerGolden } from './runner-golden.testkit.ts';
import { runnerDefinition } from './runner-registry.ts';
import { allowProbePermissions, policyResponses } from './permission-policy.testkit.ts';
import { BUILT_IN_RUNNER_IDS } from './built-in-runner-ids.testkit.ts';

/**
 * The Tool-list kinds case table (.ai/specs/TEMPLATE.md § Case tables) as cells on every runner's native
 * mock wire (hearsay-tools/cezarion#1810). Each case is one input kind the table requires, as the
 * `ToolGrant` Squawk resolves for it. Each runner's golden (`toolGrant`) pins the tool flags its
 * mock records; a runner that cannot restrict tools must record exactly what the unset case records.
 */
export type ToolGrantCaseId =
  | 'unset'
  | 'step-default'
  | 'inherited'
  | 'explicit-copy'
  | 'extra-built-in'
  | 'extra-mcp'
  | 'narrowed'
  | 'empty'
  | 'bash-allowlist'
  | 'unset-bash-allowlist';

export type ToolGrantCase = {
  readonly id: ToolGrantCaseId;
  readonly name: string;
  readonly grant: (backend: string) => ToolGrant;
  /** omp refuses an MCP name its settings do not register; the mock reads them from here. */
  readonly env?: Readonly<Record<string, string>>;
};

const stepDefault = (backend: string): string[] => allowedToolsForStep(undefined, backend);
/** Extra tools from another runner's default for TG3 (`inherited`) when the runner under test
 *  declares no extra tools of its own, so the inherited list differs from its own `step-default`.
 *  Kept as plain data so per-runner tool-grant tests load no other runner's `extra-tools.ts`;
 *  `core/runner-fact-rows.test.ts` pins this value to `extraToolRows()` (hearsay-tools/squawk#4175). */
export const FOREIGN_EXTRA_TOOLS: readonly string[] = ['Subagent', 'SubagentSupervisor', 'SubagentWait'];
const inheritedTools = (backend: string): string[] =>
  runnerDefinition(backend).extraTools.length === 0 ? [...DEFAULT_ALLOWED_TOOLS, ...FOREIGN_EXTRA_TOOLS] : [...DEFAULT_ALLOWED_TOOLS];

export const TOOL_GRANT_CASES: readonly ToolGrantCase[] = [
  { id: 'unset', name: 'TG1 an unset grant', grant: () => ({ kind: 'unset' }) },
  { id: 'step-default', name: 'TG2 the step default', grant: backend => ({ kind: 'step-default', tools: stepDefault(backend) }) },
  {
    id: 'inherited',
    name: 'TG3 a list inherited from another runner\'s default',
    grant: backend => ({ kind: 'inherited', tools: inheritedTools(backend) }),
  },
  { id: 'explicit-copy', name: 'TG4 a hand-written copy of the default', grant: backend => ({ kind: 'explicit', tools: stepDefault(backend) }) },
  { id: 'extra-built-in', name: 'TG5 the default plus a built-in', grant: backend => ({ kind: 'explicit', tools: [...stepDefault(backend), 'WebFetch'] }) },
  {
    id: 'extra-mcp',
    name: 'TG6 the default plus an mcp__ name',
    grant: backend => ({ kind: 'explicit', tools: [...stepDefault(backend), 'mcp__docs__search'] }),
    env: { CEZ_MOCK_OMP_MCP_TOOLS: 'mcp__docs_search' },
  },
  { id: 'narrowed', name: 'TG7 a narrowed list', grant: () => ({ kind: 'explicit', tools: ['Read', 'Grep'] }) },
  { id: 'empty', name: 'TG8 an empty list', grant: () => ({ kind: 'explicit', tools: [] }) },
  {
    id: 'bash-allowlist',
    name: 'TG9 the step default with a bashAllowlist',
    grant: backend => ({ kind: 'step-default', tools: stepDefault(backend), bashAllowlist: ['git status'] }),
  },
  { id: 'unset-bash-allowlist', name: 'TG10 an unset grant with a bashAllowlist', grant: () => ({ kind: 'unset', bashAllowlist: ['git status'] }) },
];

const SQUAWK_TOOLS = ['cezar_wait', 'cezar_ask', 'cezar_cancel_wait', 'cezar_done', 'cezar_schedule_task', 'cezar_automation', 'cezar_scheduled_tasks'];
const DESCRIPTOR = { name: 'cezar_ci_probe', command: 'node', args: ['/installed/ci-wait/mcp.js'] };
/** The golden's `{squawk-mcp}` and `{squawk}`: the Squawk tool names as MCP names, and plain. */
const SQUAWK_NAMES = { '{squawk-mcp}': SQUAWK_TOOLS.map(tool => `mcp__${DESCRIPTOR.name}__${tool}`).join(','), '{squawk}': SQUAWK_TOOLS.join(',') };

/** A runner that cannot restrict tools sends each case exactly as it sends the unset one. */
const SAME_AS_UNSET = 'same as unset';
type Expected = readonly string[] | typeof SAME_AS_UNSET;
type ToolFlags = { readonly values: readonly string[]; readonly switches: readonly string[] };

/** Today's flags, from the runner's own golden. A gap a case shows stays pinned until its issue changes it. */
function expectedGrants(backend: string): { flags?: ToolFlags; cases: Readonly<Record<ToolGrantCaseId, Expected>> } {
  const golden = runnerGolden(backend, 'toolGrant');
  if (typeof golden === 'object' && 'wire' in golden) return { cases: golden.cases as Record<ToolGrantCaseId, Expected> };
  if (golden === SAME_AS_UNSET) return { cases: Object.fromEntries(TOOL_GRANT_CASES.map(entry => [entry.id, SAME_AS_UNSET])) as Record<ToolGrantCaseId, Expected> };
  const expand = (flag: string) => flag.replace(/\{squawk(?:-mcp)?\}/g, name => SQUAWK_NAMES[name as keyof typeof SQUAWK_NAMES]);
  const cases = Object.fromEntries(Object.entries(golden.cases).map(([id, flags]) => [id, flags === SAME_AS_UNSET ? flags : flags.map(expand)]));
  return { flags: golden.flags, cases: cases as Record<ToolGrantCaseId, Expected> };
}

function toolFlags(flags: ToolFlags | undefined, argv: readonly string[]): string[] {
  if (!flags) return [];
  return argv.flatMap((arg, index) => {
    if (flags.switches.includes(arg)) return [arg];
    if (!flags.values.includes(arg)) return [];
    const value = argv[index + 1] ?? '';
    return [arg, arg === '--extension' ? basename(value) : value];
  });
}

/** The mock's record of what reached it: argv or requests, then stdin where hooked. */
function readRecording(dir: string, name: string): string[] {
  return [`${name}.args.ndjson`, `${name}.stdin.ndjson`].flatMap(file => {
    const path = join(dir, file);
    return existsSync(path) ? readFileSync(path, 'utf8').trim().split('\n').filter(Boolean) : [];
  });
}

export function describeToolGrantParity(scope: string | 'once'): void {
  if (scope === 'once') {
    describe('harness parity — tool-grant cases', () => {
      it('the cases cover every ToolGrant kind', () => {
        for (const backend of BUILT_IN_RUNNER_IDS) {
          expect(new Set(TOOL_GRANT_CASES.map(entry => entry.grant(backend).kind)), backend).toEqual(new Set(TOOL_GRANT_KINDS));
        }
      });
      it('runs each case exactly once, and each restricting runner pins every case', () => {
        const ids = TOOL_GRANT_CASES.map(entry => entry.id);
        expect(new Set(ids).size).toBe(ids.length);
        for (const backend of BUILT_IN_RUNNER_IDS) {
          expect(Object.keys(expectedGrants(backend).cases).sort(), backend).toEqual([...ids].sort());
        }
      });
    });
    return;
  }
  const backend = scope;
  describe(`harness parity — ${backend} tool-grant cases (hearsay-tools/cezarion#1810)`, () => {
    let dir = '';
    const recordings = new Map<ToolGrantCaseId, string[]>();
    const errors = new Map<ToolGrantCaseId, AgentEvent[]>();

    beforeAll(async () => {
      dir = mkdtempSync(join(tmpdir(), `cez-tool-grant-${backend}-`));
      for (const entry of TOOL_GRANT_CASES) {
        // Relative recording paths: the mock resolves them against its cwd, which is `dir`.
        const policy = runnerDefinition(backend).mock.toolGrantObservation === 'permission-policy';
        const obs = await driveSeam(backend, 'baseline', { ...(policy ? { whileOpen: allowProbePermissions } : {}), spec: {
          cwd: dir, sessionId: undefined, toolGrant: entry.grant(backend), squawkTools: DESCRIPTOR,
          env: { CEZ_MOCK_ARGS_FILE: `${entry.id}.args.ndjson`, CEZ_MOCK_STDIN_FILE: `${entry.id}.stdin.ndjson`, CEZ_HANDOFF_FILE: '', ...(policy ? { CEZ_MOCK_PERMISSION_PROBE: '1' } : {}), ...entry.env },
        } });
        errors.set(entry.id, obs.v1.filter(event => event.type === 'error'));
        recordings.set(entry.id, readRecording(dir, entry.id));
      }
    }, 120_000);

    afterAll(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    for (const entry of TOOL_GRANT_CASES) {
      it(`${backend} ${entry.name}`, () => {
        expect(errors.get(entry.id)).toEqual([]);
        const recording = recordings.get(entry.id) ?? [];
        expect(recording.length).toBeGreaterThan(0);
        const { flags, cases } = expectedGrants(backend);
        const expected = cases[entry.id];
        if (runnerDefinition(backend).mock.toolGrantObservation === 'permission-policy') {
          expect(policyResponses(recording)).toEqual(expected);
        } else if (expected === SAME_AS_UNSET) {
          expect(recording).toEqual(recordings.get('unset'));
        } else {
          expect(toolFlags(flags, JSON.parse(recording[0]!) as string[])).toEqual(expected);
        }
      });
    }
  });
}
