import type { AgentBrowser } from './agent-browser'

/**
 * Run `work` while the current tab's new documents have no SharedWorker, so the cockpit sends its
 * live demand as finite HTTP that `routeJson` fixtures answer. The live SharedWorker outlives
 * documents in this browser profile and pushes real server state over its socket: its health
 * snapshot replaces a routed health fixture, and a routed version that differs from it reads as
 * a server upgrade, which reloads the page (hearsay-tools/squawk#4094). The block mirrors
 * `tab-coordination.e2e.ts`.
 */
export async function withFiniteLive(browser: AgentBrowser, work: () => void): Promise<void> {
  const currentUrl = browser.url()
  await browser.withCdp(async (request) => {
    const { targetInfos } = await request('Target.getTargets')
    const page = targetInfos.find((target: { type: string; url: string }) => target.type === 'page' && target.url === currentUrl)
    if (!page) throw new Error(`No agent-browser page at ${currentUrl}`)
    const { sessionId } = await request('Target.attachToTarget', { targetId: page.targetId, flatten: true })
    try {
      await request('Page.enable', {}, sessionId)
      const { identifier } = await request('Page.addScriptToEvaluateOnNewDocument', {
        source: 'globalThis.SharedWorker=class{constructor(){throw new Error("blocked: this test serves routed fixtures")}}',
      }, sessionId)
      try {
        work()
      } finally {
        await request('Page.removeScriptToEvaluateOnNewDocument', { identifier }, sessionId)
      }
    } finally {
      await request('Target.detachFromTarget', { sessionId })
    }
  })
}
