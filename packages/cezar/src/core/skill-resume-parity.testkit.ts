import { BUILT_IN_RUNNER_IDS } from './built-in-runner-ids.testkit.ts';
import { mkdtempSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect } from 'vitest';
import { PINNED_SESSION_ID, driveSeam, seedMockSession } from './harness-parity-core.testkit.ts';
import type { CellBody } from './parity-partition.testkit.ts';
import { createRunner } from './runner-registry.ts';
import { runnerGolden } from './runner-golden.testkit.ts';
import { readMockRecords } from '../mock-records.testkit.ts';
import type { WireRow } from '../workflows/native-session-wire.testkit.ts';
import { sessionWire } from '../workflows/runner-session-wires.testkit.ts';
import { skillResumeParity, type SkillResumeCells } from './skill-resume-rows.testkit.ts';

// R56 and the systemPromptOnResume declaration drive each runner at its seam and load no engine.
// The other cells run a workflow through RunManager: their part files call
// installSkillResumeEngine() (skill-resume-engine.testkit.ts) before they register, so a seam
// part file never imports run.ts.

type EngineCellBody = 'lostSession';
type EngineRunnerCell = 'resumedContinue' | 'recoveredContinuation' | 'recordedSession' | 'interruptedContinue' | 'skillGone' | 'freshSession';
export type SkillResumeEngineCells = Pick<SkillResumeCells, EngineCellBody | EngineRunnerCell>;

let engineCells: SkillResumeEngineCells | undefined;

/** Called by `skill-resume-engine.testkit.ts` only. */
export function setSkillResumeEngineCells(cells: SkillResumeEngineCells): void {
  engineCells = cells;
}

function installed(cell: string): SkillResumeEngineCells {
  if (!engineCells) throw new Error(`${cell} runs on the engine: call installSkillResumeEngine() before describeSkillResumeParity`);
  return engineCells;
}

const engineCell = (key: EngineCellBody): CellBody => () => installed(key)[key]();
const engineRunnerCell = (key: EngineRunnerCell) => (backend: string): CellBody => () => installed(`${backend} ${key}`)[key](backend)();

export function parsedLines(recording: string): unknown[] {
  return recording.split('\n').filter(Boolean).flatMap((line) => {
    try {
      return [JSON.parse(line) as unknown];
    } catch {
      return [];
    }
  });
}

export function asRecord(row: unknown): Record<string, unknown> | undefined {
  return row && typeof row === 'object' ? row as Record<string, unknown> : undefined;
}

export function opencodeSessionGets(recording: string): string[] {
  return parsedLines(recording).flatMap((row) => {
    const rec = asRecord(row);
    if (rec?.method !== 'GET' || typeof rec.url !== 'string') return [];
    const match = /^\/session\/([^/]+)$/.exec(rec.url);
    return match ? [match[1]!] : [];
  });
}

export function readRecording(argsFile: string, stdinFile: string): string {
  const args = existsSync(argsFile) ? readFileSync(argsFile, 'utf8') : '';
  const stdin = existsSync(stdinFile) ? readFileSync(stdinFile, 'utf8') : '';
  return args.endsWith('\n') || args.length === 0 ? `${args}${stdin}` : `${args}\n${stdin}`;
}

export const describeSkillResumeParity = skillResumeParity({
  resumedContinue: engineRunnerCell('resumedContinue'),
  recoveredContinuation: engineRunnerCell('recoveredContinuation'),
  recordedSession: engineRunnerCell('recordedSession'),
  interruptedContinue: engineRunnerCell('interruptedContinue'),
  skillGone: engineRunnerCell('skillGone'),
  freshSession: engineRunnerCell('freshSession'),
  declaresResumeMode: async () => {
    for (const backend of BUILT_IN_RUNNER_IDS) {
      expect((await createRunner(backend)).systemPromptOnResume, backend).toBe(runnerGolden(backend, 'systemPromptOnResume'));
    }
  },
  declarationWire: backend => async () => {
    const dir = mkdtempSync(join(tmpdir(), `cez-skill-resume-decl-${backend}-`));
    try {
      const freshName = 'fresh';
      const resumeName = 'resume';
      const fresh = await driveSeam(backend, 'baseline', {
        spec: {
          cwd: dir,
          systemPrompt: 'SENTINEL-790-SYSTEM',
          env: {
            CEZ_MOCK_ARGS_FILE: `${freshName}.args.ndjson`,
            CEZ_MOCK_STDIN_FILE: `${freshName}.stdin.ndjson`,
            CEZ_HANDOFF_FILE: '',
          },
        },
      });
      expect(fresh.v1.filter((event) => event.type === 'error')).toEqual([]);
      // A mock that resumes only a session it knows must hold the pinned one, or the resume falls back.
      seedMockSession(backend, join(dir, `${resumeName}.args.ndjson`));
      const resumed = await driveSeam(backend, 'baseline', {
        spec: {
          cwd: dir,
          resume: true,
          systemPrompt: 'SENTINEL-790-SYSTEM',
          env: {
            CEZ_MOCK_ARGS_FILE: `${resumeName}.args.ndjson`,
            CEZ_MOCK_STDIN_FILE: `${resumeName}.stdin.ndjson`,
            CEZ_HANDOFF_FILE: '',
          },
        },
      });
      expect(resumed.v1.filter((event) => event.type === 'error')).toEqual([]);
      const freshWire = readRecording(join(dir, `${freshName}.args.ndjson`), join(dir, `${freshName}.stdin.ndjson`));
      const resumeWire = readRecording(join(dir, `${resumeName}.args.ndjson`), join(dir, `${resumeName}.stdin.ndjson`));
      const mode = (await createRunner(backend)).systemPromptOnResume;
      if (mode === 'resent') {
        expect(freshWire).toContain('SENTINEL-790-SYSTEM');
        expect(resumeWire).toContain('SENTINEL-790-SYSTEM');
        expect(resumeWire).toMatch(/--resume|--session|thread\/resume|session\/(?:load|resume)/);
      } else {
        expect(freshWire).toContain('SENTINEL-790-SYSTEM');
        // The runner's reader shows which session each launch resumed: the pinned one, and none fresh.
        const resumedIn = (name: string) => sessionWire(backend).resumed(readMockRecords<WireRow>(join(dir, `${name}.args.ndjson`)));
        expect(resumedIn(resumeName)).toEqual([PINNED_SESSION_ID]);
        expect(resumedIn(freshName)).toEqual([]);
        // The pinned session reopened: no fallback opened a fresh one beside the resume request.
        expect(sessionWire(backend).freshSessions(readMockRecords<WireRow>(join(dir, `${resumeName}.args.ndjson`)))).toBe(0);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
  lostSession: engineCell('lostSession'),
});
