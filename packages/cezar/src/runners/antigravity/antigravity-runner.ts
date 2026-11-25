import { type AgentEvent, type AgentRunResult, type AgentRunSpec, type AgentRunner, type AgentSession, type SessionOptions, productEnv } from '@hearsay-tools/squawk/plugin';
import { nativeMockPath } from '@hearsay-tools/squawk/plugin/runtime';
import { ANTIGRAVITY_FACTS } from './facts.ts';
import { ANTIGRAVITY_MOCK } from './mock.ts';
import { ANTIGRAVITY_SPEC_SUPPORT } from './spec-support.ts';
import { AntigravitySession } from './antigravity-session.ts';
export class AntigravityRunner implements AgentRunner {
  readonly backend = 'antigravity';
  readonly facts = ANTIGRAVITY_FACTS;
  readonly inputDelivery = ANTIGRAVITY_FACTS.inputDelivery;
  readonly systemPromptOnResume = ANTIGRAVITY_FACTS.systemPromptOnResume;
  readonly specSupport = ANTIGRAVITY_SPEC_SUPPORT;
  private lastSession: AgentSession | undefined;
  constructor(private readonly options: { bin?: string; timeoutMs?: number } = {}) {}
  run(spec: AgentRunSpec, event?: (event: AgentEvent) => void): Promise<AgentRunResult> {
    return this.startSession(spec, event, { autoEndAfterFirstTurn: true }).result;
  }
  async interrupt(): Promise<void> { this.lastSession?.interrupt(); }
  startSession(spec: AgentRunSpec, onEvent?: (event: AgentEvent) => void, options: SessionOptions = {}): AgentSession {
    // Unset: the session leases the managed install, else finds the CLI on PATH.
    const bin = this.options.bin || productEnv('ANTIGRAVITY_BIN') || (productEnv('DRY_RUN') === '1'
      ? nativeMockPath(ANTIGRAVITY_MOCK) : undefined);
    return this.lastSession = new AntigravitySession(bin, spec, onEvent, options, this.options.timeoutMs);
  }
}
