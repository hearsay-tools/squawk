import { fileURLToPath } from 'node:url';
import type { AgentEvent, AgentRunResult, AgentRunSpec, AgentRunner, AgentSession, SessionOptions } from '../../core/agent-runner.ts';
import { productEnv } from '../../core/product-env.ts';
import { ANTIGRAVITY_FACTS } from './facts.ts';
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
    const bin = this.options.bin ?? productEnv('ANTIGRAVITY_BIN') ?? (productEnv('DRY_RUN') === '1'
      ? fileURLToPath(new URL('../../../scripts/mock-acp.mjs', import.meta.url)) : 'agy');
    return this.lastSession = new AntigravitySession(bin, spec, onEvent, options, this.options.timeoutMs);
  }
}
