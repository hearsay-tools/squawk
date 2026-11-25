import { readFileSync } from 'node:fs';
import { expect } from 'vitest';
import type { ActivityTool } from '@open-mercato/cezar-contract';
import type { ProviderCommandResult } from './provider-auth.ts';

/**
 * One runner's own expected values, `runners/<id>/__fixtures__/golden.json`: each is a fact of that
 * runner that a test pins from outside the runner's code (a command, a recorded CLI output, a
 * label). A test reads its runner's golden here, never a table of every runner, so a new runner adds
 * its own file. A test that reads a golden the runner did not write fails naming the missing piece.
 */
export interface RunnerGolden {
  /** The take-over command for session id `s1` (`test/fixtures/resume-commands.ts`). */
  resumeCommand: string | null;
  /** The golden whose events the tool tracker sees, and what it must show after them (`activity/tool-activity-runners.test.ts`). */
  toolActivity: { fixture: string; calls: number; latest: Omit<ActivityTool, 'startedAt' | 'endedAt'> };
  /** The status probe command, and what that command prints when the account is connected (recorded
   *  from the real CLI) and when it is not. */
  providerAuth: { connectedEnv?: Record<string, string>; command: { executable: string; args: readonly string[] }; connected: ProviderCommandResult; disconnected: ProviderCommandResult };
  /** The line the dry-run installer writes for this runner (`server-install/steps.test.ts`). */
  installerDryRun: string;
  /** The planner and namer model aliases a default runner passes; empty when it passes none. */
  plannerModels: { planner?: string; namer?: string };
  /** A worker account binding that must parse and survive JSON persistence. */
  workerAccountBinding: Record<string, unknown>;
  /** The kind of each ask a human can answer on this runner's wire, in its mock's `askResumeCases`
   *  order (`core/harness-parity-cells.testkit.ts`, R26). It is written apart from the mock, so a
   *  deleted ask variant fails the guard. */
  askKinds: string[];
  /**
   * The tool flags the runner's mock records for each Tool-list case (`core/tool-grant-parity-cells.testkit.ts`).
   * `same as unset`: the runner cannot restrict tools, so every case records what the unset case
   * records. Otherwise `flags` names the argv flags that carry tool access (`--extension` keeps its
   * basename), and `cases` gives each case's flags; `{squawk}` stands for the Squawk tool names
   * and `{squawk-mcp}` for them as MCP names. `notes` says why a case records what it does.
   */
  toolGrant: 'same as unset' | { wire: 'permission-policy'; cases: Record<string, string[]> } | {
    flags: { values: string[]; switches: string[] };
    cases: Record<string, string[] | 'same as unset'>;
    notes?: Record<string, string>;
  };
  /** The notes a run shows for the mock's recoverable skill diagnostics (R44/R45,
   *  `core/harness-parity-run.cells.testkit.ts`); only a runner those rows select writes it. */
  skillWarningNotes: string[];
  /** R15 (`core/harness-parity-run.cells.testkit.ts`): what the runner does with a child's frames
   *  that arrive after the parent parked. `shown`: they become child items after the park.
   *  `discarded`: the runner drops a closed child scope, so its child items all predate the park
   *  and only the mock's usage barrier shows the late frames crossed the transport. */
  postParkChildFrames: 'shown' | 'discarded';
  /** What a provider refusal of agent input does to the session (`core/native-delivery-control.test.ts`).
   *  `keeps-session`: the session stays open and takes the next input. `ends-session`: the runner
   *  fails the session, so a retry needs a reopened process. Not written by a runner that is exempt
   *  from U13 (no provider refusal on its wire). */
  rejectedAgentInput: 'keeps-session' | 'ends-session';
  /** The shipped plugin scripts (file names in `runners/<id>/`) a governed session's runtime
   *  config loads, in order (D1, `core/harness-parity-session.cells.testkit.ts`). Only a runner that
   *  governs a session through a runtime plugin writes it. */
  runtimePlugins: string[];
  /** How the runner carries a system prompt onto a resumed session, as its built runner reports it
   *  (`core/skill-resume-parity.testkit.ts`). */
  systemPromptOnResume: 'resent' | 'in-thread';
  /** What `GET /api/v1/runners` sends for this runner, and its Agent config pane. */
  runnerEntry: {
    displayName: string; modelListName: string; modelIdScope: string;
    pickerLabel: string; pickerDescription: string; icon: string; installHint: string; loginCommand: string;
    accountFolderExample?: string;
    suggested: string[]; retired: string[];
    paneLabel: string; paneNote?: string; showsUserMcp: boolean; emptyGroups: string[];
  };
}

/** Matches a path to a runner's shipped script `name` (`runners/<id>/<name>`). */
export function shippedScriptPath(name: string): unknown {
  return expect.stringMatching(new RegExp(`runners/[^/]+/${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`));
}

/** The value `key` of runner `runner`'s golden. */
export function runnerGolden<Key extends keyof RunnerGolden>(runner: string, key: Key): RunnerGolden[Key] {
  const file = `runners/${runner}/__fixtures__/golden.json`;
  let golden: Partial<RunnerGolden>;
  try { golden = JSON.parse(readFileSync(new URL(`../${file}`, import.meta.url), 'utf8')) as Partial<RunnerGolden>; }
  catch (error) { throw new Error(`${file} is missing or not JSON: ${(error as Error).message}`); }
  const value = golden[key];
  if (value === undefined) throw new Error(`${file} has no "${key}"`);
  return value;
}
