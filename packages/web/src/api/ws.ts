/** Topic demand belongs to the shared owner; a document without one reconciles over HTTP. */
import { subscribeLive } from './live-coordinator'
export { createTopicSocket } from './topic-socket'
export type { TopicSocket, TopicListener } from './topic-socket'
import type { TopicListener } from './topic-socket'

export function subscribeTopic(topic: string, listener: TopicListener): () => void {
  return subscribeLive({ kind: 'topic', topic }, { value: listener })
}
