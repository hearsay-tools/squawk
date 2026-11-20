import { readFileSync } from 'node:fs';
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
  resumeCommand: string;
  /** The golden whose events the tool tracker sees, and what it must show after them (`activity/tool-activity-runners.test.ts`). */
  toolActivity: { fixture: string; calls: number; latest: Omit<ActivityTool, 'startedAt' | 'endedAt'> };
  /** The status probe command, and what that command prints when the account is connected (recorded
   *  from the real CLI) and when it is not. */
  providerAuth: { command: { executable: string; args: readonly string[] }; connected: ProviderCommandResult; disconnected: ProviderCommandResult };
  /** The line the dry-run installer writes for this runner (`server-install/steps.test.ts`). */
  installerDryRun: string;
  /** The planner and namer model aliases a default runner passes; empty when it passes none. */
  plannerModels: { planner?: string; namer?: string };
  /** A worker account binding that must parse and survive JSON persistence. */
  workerAccountBinding: Record<string, unknown>;
  /** What `GET /api/v1/runners` sends for this runner, and its Agent config pane. */
  runnerEntry: {
    displayName: string; modelListName: string; modelIdScope: string;
    pickerLabel: string; pickerDescription: string; icon: string; installHint: string; loginCommand: string;
    accountFolderExample?: string;
    suggested: string[]; retired: string[];
    paneLabel: string; paneNote?: string; showsUserMcp: boolean; emptyGroups: string[];
  };
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
