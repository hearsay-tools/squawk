import type { AgentConfigFile, Runner } from '@open-mercato/cezar-api-client'
import type { RunnerEntry, RunnersResponse } from '@open-mercato/cezar-api-client/contract/runners'
import { runnerEntries } from '@/api/runners'

/**
 * Per-agent descriptor driving the Settings → Agent config pane (spec
 * 2026-07-17-agent-config-by-agent, amending #404): the UI is grouped by AGENT —
 * selector first, then that agent's settings, MCP and memory together — not by
 * purpose across agents. The descriptor's labels, notes and empty-state copy come from the
 * runner's `agentConfig` in `GET /api/v1/runners` (the `configFiles` part of its definition,
 * hearsay-tools/squawk#3898); only the file filter below lives in the cockpit. A new agent is
 * its definition plus its catalog files — no layout or route work.
 *
 * A runner the vendor gives no editable file for still gets its tab: the group carries `empty`
 * copy saying why there is nothing to list and what to try instead, rather than the agent being
 * hidden (#322 — Pi's MCP group is the worked example: Pi's README says "No MCP.").
 *
 * Group membership derives from the flat `/api/agent-config` listing: a file
 * belongs to an agent when `runners` INCLUDES it (not `runners[0]` — the shared
 * `AGENTS.md` entry is read by Codex AND OpenCode and must show under both), and
 * `holdsMcp` promotes a file into the MCP group as well as its own kind — for
 * Codex/OpenCode the main config genuinely is where MCP servers live.
 */

export interface AgentGroup {
  id: 'settings' | 'mcp' | 'memory'
  label: string
  /** Group-level caveat — e.g. where this agent keeps its MCP servers. */
  note?: string | undefined
  /**
   * Shown instead of the file list when the group has nothing to list — why it is empty and
   * what to try. A group without it renders nothing when empty (Claude's MCP group, absent
   * `.mcp.json` aside, has always behaved that way).
   */
  empty?: string
  /** The group also shows the user-level MCP listing (`~/.claude.json`), even with no file. */
  showsUserMcp?: true
  files: (f: AgentConfigFile) => boolean
}

export interface AgentDescriptor {
  id: Runner
  label: string
  /** Pane-level caveat shown under the agent's heading. */
  note?: string | undefined
  groups: AgentGroup[]
}

function ownedBy(agent: Runner) {
  return (f: AgentConfigFile) => f.runners.includes(agent)
}

/** The filter that decides which of the listing's files a group shows for `agent`. */
function memberOf(agent: Runner, id: AgentGroup['id']): AgentGroup['files'] {
  const owned = ownedBy(agent)
  // `holdsMcp` files appear in the MCP group AND their own kind group — both
  // occurrences open the same editor; hiding either would misstate the file.
  return id === 'mcp'
    ? (f) => owned(f) && (f.holdsMcp === true || f.kind === 'mcp')
    : (f) => owned(f) && f.kind === id
}

/** One runner's pane: its `agentConfig` from the runners list, with each group's file filter. */
export function agentDescriptor(entry: RunnerEntry): AgentDescriptor {
  const { label, note, groups } = entry.agentConfig
  return {
    id: entry.id,
    label,
    note,
    groups: groups.map(({ id, label: groupLabel, note: groupNote, empty, showsUserMcp }) => ({
      id,
      label: groupLabel,
      note: groupNote,
      ...(empty ? { empty } : {}),
      ...(showsUserMcp ? { showsUserMcp } : {}),
      files: memberOf(entry.id, id),
    })),
  }
}

/** Every registered runner's pane, in display order. Empty until the runners query answers. */
export function agentDescriptors(runners: RunnersResponse | undefined): AgentDescriptor[] {
  return runnerEntries(runners).map(agentDescriptor)
}
