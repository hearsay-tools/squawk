import { leadingSlashSkillName } from './prompts.ts';
import { productEnvEntries } from '../../core/product-env.ts';
import { atStepOpen, atContinue } from './launch-read-resolver.ts';
import type { DelegationProvisioner } from '../../delegation/provision.ts';
import { handoffPath, refreshHandoffRecords } from '../../handoff.ts';
import { agentTmpEnv } from '../../runs/agent-tmpdir.ts';
import type { WorkerStepIdentity } from '../../delegation/execution-identity.ts';
import { resolveLaunchParts, type LaunchCockpitAddress, type ResolvedLaunchParts } from '../../core/launch-registry.ts';
import { buildSessionContext, formatSessionContextReport, type SessionContext } from '../../session-context.ts';
import type { ActiveRun } from '../active-run.ts';
import type { RunModuleContext } from './types.ts';

type LaunchContext = Pick<RunModuleContext, 'store' | 'repoRoot' | 'dataDir' | 'home'>;
type CockpitAddress = { origin: string; projectId: string } | undefined;

export interface LaunchSettingsHost {
  active: ReadonlyMap<string, ActiveRun>;
  setCockpit(address: CockpitAddress): void;
  delegationProvisioner(): DelegationProvisioner | undefined;
  setProvisioner(provisioner: DelegationProvisioner | undefined): void;
  historyDeletionPending(runId: string): boolean;
}

export interface LaunchContextHost {
  agentEnv(runId: string): Record<string, string>;
  workerStep(runId: string, stepId: string | undefined): WorkerStepIdentity | undefined;
}

/** Env for the rolling handoff, the task and the cockpit. Launch parts add their own env.
 *
 *  `TMPDIR`/`TEMP`/`TMP` (#785) point at this run's own scratch directory
 *  instead of the machine-wide one every agent used to share. Created and
 *  write-probed here, on the last common path before a spawn, so an unusable
 *  temp directory throws `AgentTempDirError` at the caller rather than
 *  turning into empty command output inside a running agent. */
export function agentEnv({ dataDir }: LaunchContext, cockpit: CockpitAddress, runId: string): Record<string, string> {
  return {
    ...productEnvEntries('HANDOFF_FILE', handoffPath(dataDir, runId)),
    ...productEnvEntries('TASK_ID', runId),
    ...agentTmpEnv(dataDir, runId),
    ...(cockpit ? { ...productEnvEntries('COCKPIT_URL', cockpit.origin), ...productEnvEntries('PROJECT_ID', cockpit.projectId) } : {}),
  };
}

export function agentEnvForStep(...args: Parameters<typeof atStepOpen.agentEnvForStep>): ReturnType<typeof atStepOpen.agentEnvForStep> {
  const reads = args[4]?.phase === 'continue' ? atContinue : atStepOpen;
  return reads.agentEnvForStep(...args);
}

/** The registered launch parts for one launch: their env and system-prompt parts, read when a
 *  session starts. `env` is the step's profile env, which each part can read. */
export function launchParts({ repoRoot, dataDir, home }: LaunchContext, cockpit: CockpitAddress, runId: string, env: Readonly<Record<string, string>>): Promise<ResolvedLaunchParts> {
  const address: LaunchCockpitAddress = cockpit ? { origin: cockpit.origin, projectId: cockpit.projectId } : undefined;
  return resolveLaunchParts({ runId, dataDir, repoRoot, home, cockpit: address, env });
}

/**
 * One launch's session-start context (hearsay-tools/cezarion#1584): the run's own handoff,
 * then the project's `context.yaml` rules for this recipient, read now and rendered once.
 * Every launch reports its outcome as one lifecycle line. Both launch sites — a fresh step
 * and `runContinuation` — come here; a live message never does. The prefix goes into the
 * opening message only, never the system prompt a worker inherits (#778).
 */
export function sessionContextFor({ store, repoRoot, dataDir }: LaunchContext, runId: string, state: ActiveRun, stepId: string, openingPrompt: string): SessionContext {
  const run = store.getRun(runId);
  const role = run?.delegation?.role === 'worker' ? 'worker' : 'parent';
  const handoff = handoffPath(dataDir, runId);
  refreshHandoffRecords(store, dataDir, runId);
  // A structured skill has already consumed its slash text. Unconverted native commands
  // still need character zero, so they keep the handoff read instruction instead of a prefix.
  const context: SessionContext = leadingSlashSkillName(openingPrompt)
    ? { prefix: '', handoffInjected: false, reports: [{ id: 'session-context', status: 'skipped', sources: [], reason: 'the opening message is a slash command, which must stay at its start' }] }
    : buildSessionContext({
      projectRoot: repoRoot,
      cwd: state.liveSession.cwd,
      role,
      handoffPath: handoff,
      variables: {
        ...(run ? atStepOpen.contextVariables(run) : {}),
        'run.id': runId,
        role,
        'step.id': stepId,
        'project.root': repoRoot,
        'worktree.root': state.liveSession.cwd,
        'handoff.path': handoff,
      },
    });
  store.eventLog.appendEvent(runId, { type: 'lifecycle', message: formatSessionContextReport(context.reports) });
  return context;
}

/** The pinned identity one agent step of an owned worker runs under; undefined for ordinary and internal runs. */
export const workerStep = atStepOpen.workerStep;

export function setCockpitAddress(host: LaunchSettingsHost, address: CockpitAddress): void {
  host.setCockpit(address ? { ...address } : undefined);
}

export function cockpitAddress(cockpit: CockpitAddress): CockpitAddress {
  return cockpit ? { ...cockpit } : undefined;
}

export function setDelegationProvisioner(host: LaunchSettingsHost, provisioner: DelegationProvisioner): () => void {
  host.setProvisioner(provisioner);
  return () => {
    if (host.delegationProvisioner() === provisioner) host.setProvisioner(undefined);
    for (const state of host.active.values()) { state.liveSession.revokeDelegation?.(); state.liveSession.clearDelegationRevoker(); }
  };
}

export function provisionSession(host: LaunchSettingsHost, runId: string, state: ActiveRun) {
  state.liveSession.revokeDelegation?.(); state.liveSession.clearDelegationRevoker();
  if (host.historyDeletionPending(runId)) return;
  const session = host.delegationProvisioner()?.(runId);
  state.liveSession.installDelegationRevoker(session?.revoke);
  return session;
}
