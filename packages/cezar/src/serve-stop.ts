import type { Server } from 'node:http';
import type { DelegationController } from './delegation/provision.ts';
import type { PreviewHost } from './preview/host.ts';
import type { RunStore } from './runs/store.ts';
import type { StoppableServer, StopServeOptions } from './serve-boot.ts';

/** What `serve` has built so far. Boot fills each field as the part comes to exist. */
export interface ServeParts {
  listener?: Pick<Server, 'close' | 'closeAllConnections'>;
  store?: Pick<RunStore, 'close'>;
  delegation?: Pick<DelegationController, 'close'>;
  previewHost?: Pick<PreviewHost, 'close'> | undefined;
  /** Set once `startServer` returned: its own shutdown then stops every part above. */
  server?: StoppableServer;
}

export interface ServeStopDeps {
  process: { on(event: NodeJS.Signals, listener: () => void): unknown; exit(code?: number): unknown };
  stopServe: (server: StoppableServer, signal: NodeJS.Signals, opts: StopServeOptions) => Promise<void>;
  onTerminal: () => boolean;
  ignoreHangupOffTerminal: () => void;
  watchSupervisor: (onLost: () => void) => unknown;
}

export interface ServeStop {
  readonly parts: ServeParts;
  /** True once a signal started the stop: boot then starts nothing more. */
  readonly stopping: boolean;
  /** The stop in progress, which ends the process; undefined while none started. */
  readonly stopped: Promise<void> | undefined;
}

/** The shutdown of a serve that has not started its server yet: the parts that exist, store last. */
export function partialServe(parts: ServeParts): StoppableServer {
  return {
    shutdownForRestart: async () => {
      await parts.previewHost?.close().catch(() => undefined);
      await parts.delegation?.close().catch(() => undefined);
      parts.listener?.close();
      parts.listener?.closeAllConnections();
      parts.store?.close();
    },
  };
}

/**
 * Install serve's stop before the first boot step that can start a process
 * (hearsay-tools/cezarion#991). Recovery resumes agents in their own process groups, so a signal
 * that arrived before this handler ended Squawk by the default action and left those agents
 * running. The stop shuts down what exists at the signal and forwards it to the agent groups
 * last, through `stopServe`. One stop per process: a repeated signal does not start a second one.
 */
export function installServeStop(deps: ServeStopDeps): ServeStop {
  const parts: ServeParts = {};
  let stopped: Promise<void> | undefined;
  const stop = (signal: NodeJS.Signals) => {
    if (stopped) return;
    stopped = deps.stopServe(parts.server ?? partialServe(parts), signal, { store: parts.store })
      .finally(() => { deps.process.exit(0); });
  };
  deps.process.on('SIGINT', () => stop('SIGINT'));
  deps.process.on('SIGTERM', () => stop('SIGTERM'));
  if (deps.onTerminal()) deps.process.on('SIGHUP', () => stop('SIGHUP'));
  else deps.ignoreHangupOffTerminal();
  deps.watchSupervisor(() => stop('SIGTERM'));
  return {
    parts,
    get stopping() { return stopped !== undefined; },
    get stopped() { return stopped; },
  };
}
