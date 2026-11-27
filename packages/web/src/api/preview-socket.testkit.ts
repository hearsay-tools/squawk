/** A browser WebSocket for preview tests: records what a server would see; lifecycle is driven by hand. */
export class FakeWebSocket {
  static instances: FakeWebSocket[] = []

  url: string
  binaryType = 'blob'
  readyState = 0
  sent: string[] = []
  private handlers = new Map<string, Set<(event: unknown) => void>>()

  constructor(url: string) {
    this.url = url
    FakeWebSocket.instances.push(this)
  }

  addEventListener(name: string, handler: (event: unknown) => void): void {
    const set = this.handlers.get(name) ?? new Set()
    set.add(handler)
    this.handlers.set(name, set)
  }

  send(data: string): void {
    this.sent.push(data)
  }

  close(): void {
    this.readyState = 3
  }

  open(): void {
    this.readyState = 1
    this.fire('open', {})
  }

  message(data: unknown): void {
    this.fire('message', { data })
  }

  /** A failed upgrade or a drop: browsers fire `error` then `close`. */
  drop(): void {
    this.readyState = 3
    this.fire('error', {})
    this.fire('close', {})
  }

  private fire(name: string, event: unknown): void {
    for (const handler of [...(this.handlers.get(name) ?? [])]) handler(event)
  }
}
