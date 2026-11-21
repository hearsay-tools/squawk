import { randomUUID } from 'node:crypto';
import type { ProviderSignIn } from '@open-mercato/cezar-contract/workspace';
import type { RunnerBrowserSignIn } from '../core/runner-definition.ts';

interface Entry { key: string; result: ProviderSignIn; flow: RunnerBrowserSignIn | undefined; timer: NodeJS.Timeout }

/** Memory-only, one browser flow per account. Completion erases the consent URL. */
export class ProviderSignIns {
  private readonly entries = new Map<string, Entry>();
  private readonly starting = new Map<string, Promise<ProviderSignIn>>();

  start(key: string, create: () => Promise<RunnerBrowserSignIn>, connected: () => Promise<void>): Promise<ProviderSignIn> {
    const current = [...this.entries.values()].find(entry => entry.key === key && entry.result.state === 'waiting');
    if (current) return Promise.resolve(current.result);
    const pending = this.starting.get(key);
    if (pending) return pending;
    const operation = this.create(key, create, connected).finally(() => this.starting.delete(key));
    this.starting.set(key, operation);
    return operation;
  }

  private async create(key: string, create: () => Promise<RunnerBrowserSignIn>, connected: () => Promise<void>): Promise<ProviderSignIn> {
    const flow = await create();
    const id = randomUUID();
    const entry: Entry = { key, flow, result: { id, state: 'waiting', url: flow.url }, timer: setTimeout(() => {
      void this.cancel(id).catch(() => {}).finally(() => this.entries.delete(id));
    }, 300_000) };
    entry.timer.unref();
    this.entries.set(id, entry);
    void flow.completion.then(async () => {
      if (entry.result.state !== 'waiting') return;
      await connected();
      if (entry.result.state === 'waiting') entry.result = { id, state: 'connected' };
    }).catch(() => {
      if (entry.result.state === 'waiting') entry.result = { id, state: 'failed', error: 'Sign-in failed or expired. Start a new sign-in.' };
    }).finally(() => { entry.flow = undefined; });
    return entry.result;
  }

  get(id: string): ProviderSignIn | undefined { return this.entries.get(id)?.result; }

  async redirect(id: string, url: string): Promise<ProviderSignIn | undefined> {
    const entry = this.entries.get(id);
    if (!entry) return undefined;
    if (entry.result.state !== 'waiting') throw new Error('This sign-in is no longer waiting for a redirect.');
    if (!entry.flow) throw new Error('This sign-in has ended.');
    await entry.flow.redirect(url);
    return entry.result;
  }

  async cancel(id: string): Promise<ProviderSignIn | undefined> {
    const entry = this.entries.get(id);
    if (!entry) return undefined;
    if (entry.result.state === 'waiting') entry.result = { id, state: 'cancelled' };
    const flow = entry.flow; entry.flow = undefined;
    await flow?.close();
    return entry.result;
  }
}
