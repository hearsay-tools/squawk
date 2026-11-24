import type { DiscoveredTasks, DiscoveryRequest } from '@open-mercato/cezar-contract/discovery';
import { messagingAllowed } from '@open-mercato/cezar-contract/task-options';
import { deriveAttention } from '@open-mercato/cezar-contract/attention';
import type { RunStore } from '../runs/store.ts';
import { conversationOf, finishing, grantsOf, historyDeleting, isRootTask } from '../runs/task-rights.ts';
import { DelegationPolicyError, requireMessagingAllowed } from './policy.ts';
import { conversationCapacity } from './questions.ts';

/** Read stored summaries too: review and terminal peers must remain discoverable. */
export function discoverTasks(store: RunStore, callerId: string, request: Extract<DiscoveryRequest, { kind: 'tasks' }>): DiscoveredTasks {
  const caller = store.getRun(callerId);
  if (!caller || !grantsOf(caller).message.includes('peer') || historyDeleting(caller)) throw new DelegationPolicyError('denied_scope', 'Worker scope denied');
  // Peer discovery is peer messaging (hearsay-tools/cezarion#2784).
  requireMessagingAllowed(caller);
  const page = store.queries.listPeerTaskSummaries({ callerId, ...request });
  const tasks = page.runs.flatMap(run => {
    const current = store.getRun(run.id);
    if (!isRootTask(current) || historyDeleting(current)) return [];
    const attention = deriveAttention(run);
    const open = messagingAllowed(current);
    const accepts = open && ['queued', 'running', 'waiting'].includes(current.status) && !current.stopping && !finishing(current);
    const state = current.stopping ? 'stopping' : finishing(current) ? 'finishing' : current.status;
    return [{ id: run.id, title: run.titleSummary ?? run.title, ...(run.runner === undefined ? {} : { runner: run.runner }),
      status: run.status, attention: attention.bucket, attentionLabel: attention.label, accepts,
      ...(accepts ? {} : { reason: open ? `${state}: only its human can continue it` : 'task messaging is off: it does not accept task messages' }) }];
  });
  // Only a root task discovers peers, so its own ledger is its family ledger, read as last committed:
  // discovery writes nothing, and the next send's commit moves settled history out (hearsay-tools/squawk#4192).
  return { tasks, ...(page.nextOffset === undefined ? {} : { nextOffset: page.nextOffset }),
    capacity: conversationCapacity(conversationOf(caller) ?? { messages: [], outcomes: [] }) };
}
