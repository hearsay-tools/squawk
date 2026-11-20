import type { QueryClient } from '@tanstack/react-query'
import type { RunnersResponse } from '@open-mercato/cezar-api-client/contract/runners'

import { runnersQueryKey } from '@/api/runners'

const EDITOR_PLUS_COMMIT =
  'An editor-plus-commit: a saved change reaches a run after you commit it to the base branch.'

const GROUPS = [
  { id: 'settings', label: 'Settings' },
  { id: 'mcp', label: 'MCP' },
  { id: 'memory', label: 'Memory & instructions' },
] as const

const auto = (desc: string) => ({ suggested: [{ id: '', label: 'auto', desc }], retired: [] })

/** `GET /api/v1/runners` as the server answers it with today's built-in runners, in display order. */
export const RUNNERS_RESPONSE: RunnersResponse = {
  runners: [
    {
      id: 'claude', displayName: 'Claude Code', modelListName: 'Claude', modelIdScope: 'own',
      pickerLabel: 'claude', pickerDescription: 'Claude Code CLI', icon: 'bot',
      installHint: 'npm i -g @anthropic-ai/claude-code', loginCommand: 'claude auth login',
      accountFolderExample: '~/.claude-second',
      models: {
        suggested: [
          { id: '', label: 'auto', desc: 'Pick the best model per step' },
          { id: 'opus', label: 'opus', desc: 'Deep reasoning for hard tasks' },
          { id: 'sonnet', label: 'sonnet', desc: 'Fast and cheap' },
          { id: 'haiku', label: 'haiku', desc: 'Fastest — simple, scoped tasks' },
        ],
        retired: ['claude-fable-5', 'claude-opus-4-8', 'claude-sonnet-5', 'claude-haiku-4-5'],
      },
      agentConfig: {
        label: 'Claude',
        groups: [
          GROUPS[0],
          { ...GROUPS[1], note: 'A dedicated .mcp.json (key: mcpServers), shared via version control.', showsUserMcp: true },
          GROUPS[2],
        ],
      },
    },
    {
      id: 'codex', displayName: 'Codex', modelListName: 'Codex', modelIdScope: 'own',
      pickerLabel: 'codex', pickerDescription: 'OpenAI Codex (app-server)', icon: 'sparkles',
      installHint: 'npm i -g @openai/codex', loginCommand: 'codex login',
      accountFolderExample: '~/.codex-second',
      models: auto('Use your Codex default model'),
      agentConfig: {
        label: 'Codex', note: EDITOR_PLUS_COMMIT,
        groups: [GROUPS[0], { ...GROUPS[1], note: 'Inside config.toml under [mcp_servers.<id>] — the same file as Codex’s settings.' }, GROUPS[2]],
      },
    },
    {
      id: 'opencode', displayName: 'OpenCode', modelListName: 'OpenCode', modelIdScope: 'provider-spanning',
      pickerLabel: 'opencode', pickerDescription: 'OpenCode (serve)', icon: 'bot',
      installHint: 'https://opencode.ai', loginCommand: 'opencode auth login',
      models: auto('Use your OpenCode default model'),
      agentConfig: {
        label: 'OpenCode', note: EDITOR_PLUS_COMMIT,
        groups: [GROUPS[0], { ...GROUPS[1], note: 'Under the "mcp" key in opencode.json — the same file as OpenCode’s settings.' }, GROUPS[2]],
      },
    },
    {
      id: 'pi', displayName: 'pi', modelListName: 'Pi', modelIdScope: 'provider-spanning',
      pickerLabel: 'pi', pickerDescription: 'pi CLI (provider/model)', icon: 'bot',
      installHint: 'https://github.com/badlogic/pi-mono', loginCommand: 'pi /login',
      accountFolderExample: '~/.pi-second/agent',
      models: auto('Use your pi default model'),
      agentConfig: {
        label: 'Pi', note: EDITOR_PLUS_COMMIT,
        groups: [
          GROUPS[0],
          {
            ...GROUPS[1],
            note: 'Pi ships no MCP client, so it has no MCP file to edit.',
            empty: 'Nothing to list: Pi’s README says "No MCP." Give Pi tools as CLI programs with a README (Pi skills), or install a Pi extension that adds MCP support and configure servers there.',
          },
          GROUPS[2],
        ],
      },
    },
    {
      id: 'omp', displayName: 'OMP', modelListName: 'OMP', modelIdScope: 'provider-spanning',
      pickerLabel: 'OMP', pickerDescription: 'Oh My Pi CLI (provider/model)', icon: 'bot',
      installHint: 'https://omp.sh', loginCommand: 'omp login',
      models: auto('Use your OMP default model'),
      agentConfig: {
        label: 'OMP', note: EDITOR_PLUS_COMMIT,
        groups: [GROUPS[0], { ...GROUPS[1], note: 'A dedicated mcp.json (key: mcpServers) at ~/.omp/agent and in the project’s .omp/ folder.' }, GROUPS[2]],
      },
    },
  ],
}

/** The fixture's runner ids, in display order. */
export const RUNNER_IDS: readonly string[] = RUNNERS_RESPONSE.runners.map((entry) => entry.id)

/** The URL the cockpit reads the runners from. */
export const RUNNERS_PATH = '/api/v1/runners'

/** Put the fixture in `queryClient`'s cache, as if the runners query had answered. Returns the
 *  client, so a render can seed it inline. */
export function seedRunners<Client extends QueryClient>(queryClient: Client, runners: RunnersResponse = RUNNERS_RESPONSE): Client {
  queryClient.setQueryData(runnersQueryKey, runners)
  return queryClient
}
