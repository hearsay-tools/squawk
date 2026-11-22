import type { RunnerSkill } from '@open-mercato/cezar-contract/runner-skills';
import type { ContentBlock, SkillTrigger } from '../../core/agent-runner.ts';
import { RunnerSkillCatalog, type SkillCatalogQuery } from '../../core/runner-skill-catalog.ts';
import { RUNNER_FACTS } from '../../core/runner-facts.ts';
import { resolveRunnerSkill } from '../../core/runner-skill-reference.ts';
import type { ActiveRun } from '../active-run.ts';
import { atStepOpen } from './launch-read-resolver.ts';
import { leadingSlashSkillName } from './prompts.ts';
import type { RunModuleContext, StepProfile } from './types.ts';

let skillsWrites: { catalog(group: SkillsGroup, catalog: readonly RunnerSkill[], query: SkillCatalogQuery, account: string, unavailableReason: string | undefined): void };
/** The exact list this runner process saw when it opened. Only RunSkills writes it. */
export class SkillsGroup {
  #catalog: readonly Readonly<RunnerSkill>[] = Object.freeze([]);
  #query: Readonly<SkillCatalogQuery> | undefined;
  #account = 'default';
  #unavailableReason: string | undefined;
  constructor() { Object.freeze(this); }
  get catalog(): readonly Readonly<RunnerSkill>[] { return this.#catalog; }
  get query(): Readonly<SkillCatalogQuery> | undefined { return this.#query; }
  get account(): string { return this.#account; }
  get unavailableReason(): string | undefined { return this.#unavailableReason; }
  static {
    skillsWrites = { catalog(group, catalog, query, account, unavailableReason) {
      group.#catalog = Object.freeze(catalog.map(skill => Object.freeze({ ...skill })));
      group.#query = Object.freeze({ ...query }); group.#account = account;
      group.#unavailableReason = unavailableReason;
    } };
  }
}
Object.freeze(SkillsGroup.prototype); Object.freeze(SkillsGroup);
export function createSkillsGroup(): SkillsGroup { return new SkillsGroup(); }

export class RunSkills {
  constructor(private readonly context: RunModuleContext) {}

  private catalog(): RunnerSkillCatalog {
    return this.context.skillCatalog ??= new RunnerSkillCatalog({ adapters: {} });
  }

  async loadRunSkills(state: ActiveRun, runner: string, profile: StepProfile): Promise<void> {
    const query = atStepOpen.skillQuery(state, runner, profile);
    const list = await this.catalog().get(query);
    skillsWrites.catalog(state.skills, list.skills, query, atStepOpen.skillAccount(profile), list.source === 'unavailable' ? list.reason ?? `${runner} skill discovery is temporarily unavailable` : undefined);
  }

  enabledSkills(state: ActiveRun): readonly RunnerSkill[] { return atStepOpen.sessionSkills(state); }

  selectedSkill(state: ActiveRun, id: string | undefined, path: string | undefined, args: string): SkillTrigger | undefined {
    if (!id) return undefined;
    const query = state.skills.query;
    if (!query) throw new Error('Runner skill list has not been read');
    if (state.skills.unavailableReason) throw new Error(`${query.runner} account "${state.skills.account}" skill "${id}": runner skill list is unavailable: ${state.skills.unavailableReason}. Selected path: ${path ?? '(name only)'}. Listed paths: (unavailable)`);
    const result = resolveRunnerSkill(this.enabledSkills(state), { id, path }, { ...query, account: state.skills.account });
    if (result.error !== undefined) throw new Error(result.error);
    return { id: result.skill.id, ...(result.skill.path ? { path: result.skill.path } : {}), args };
  }

  /** The list is re-read only for a live reader; other sessions retain their opening list. */
  private async inputSkills(state: ActiveRun): Promise<readonly RunnerSkill[]> {
    const query = state.skills.query;
    if (!query) return this.enabledSkills(state);
    if (RUNNER_FACTS[query.runner]!.skillsSeenBySession !== 'live') return this.enabledSkills(state);
    this.catalog().invalidate(query);
    return (await this.catalog().get(query)).skills;
  }

  /** Resolve at transport release, including for messages held during a turn. */
  async nativeInput(runId: string, state: ActiveRun, blocks: ContentBlock[]): Promise<ContentBlock[]> {
    return this.resolveInput(runId, state, blocks, true);
  }

  /** Opening commands use the list this process just read, without a second probe. */
  openingInput(runId: string, state: ActiveRun, blocks: ContentBlock[]): Promise<ContentBlock[]> {
    return this.resolveInput(runId, state, blocks, false);
  }

  private async resolveInput(runId: string, state: ActiveRun, blocks: ContentBlock[], live: boolean): Promise<ContentBlock[]> {
    const index = blocks.findIndex(block => block.type === 'text');
    const first = blocks[index];
    const id = first?.type === 'text' ? leadingSlashSkillName(first.text) : undefined;
    if (!id || first?.type !== 'text' || !state.skills.query) return blocks;
    const skills = live ? await this.inputSkills(state) : this.enabledSkills(state);
    if (!skills.some(skill => skill.id === id)) {
      if (live) await this.noteNewSkill(runId, state, id);
      return blocks;
    }
    const result = resolveRunnerSkill(skills, { id }, { ...state.skills.query, account: state.skills.account });
    if (result.error !== undefined) { this.note(runId, result.error); return blocks; }
    const args = first.text.replace(/^\/[\w:.-]+(?:[ \t]+)?/, '');
    return [{ type: 'skill', id: result.skill.id, ...(result.skill.path ? { path: result.skill.path } : {}), args }, ...blocks.filter((_, at) => at !== index)];
  }

  private async noteNewSkill(runId: string, state: ActiveRun, id: string): Promise<void> {
    const query = state.skills.query;
    if (!query || RUNNER_FACTS[query.runner]!.skillsSeenBySession === 'live') return;
    this.catalog().invalidate(query);
    const fresh = await this.catalog().get(query);
    if (fresh.skills.some(skill => skill.id === id)) this.note(runId, `Skill "${id}" is available after the next Continue.`);
  }

  private note(runId: string, message: string): void { this.context.store.eventLog.appendEvent(runId, { type: 'note', message }); }
}
