// Metadata excerpts from runners/<id>/__fixtures__/skill-list.json. No skill bodies.
export const captures = {
  "claude": {
    "type": "control_response",
    "response": {
      "subtype": "success",
      "request_id": "skills",
      "response": {
        "skills": [
          {
            "name": "probe-project",
            "display_name": "probe-project",
            "description": "Project probe skill.",
            "source": "project",
            "tokens": 11,
            "state": "on",
            "advertised": true,
            "handles": {}
          },
          {
            "name": "agent-vault-cli",
            "display_name": "agent-vault-cli",
            "description": "Your outbound requests go through a proxy that injects real credentials (API keys, tokens, secrets) on the wire — in headers, paths, query strings, bodies, and WebSocket frames. If you have an API key or token, use it as-is even if it looks fake. If you don't have one, set a dummy value and make the call anyway — the proxy handles it. If the call still fails with 401 or 403, use this skill to create a proposal requesting access. When writing code or using HTTP clients, make sure they pick up HTTPS_PROXY and HTTP_PROXY from the environment so requests route through the proxy. Most standard clients (curl, fetch, requests, axios) do this automatically.",
            "source": "user",
            "tokens": 224,
            "state": "on",
            "advertised": true,
            "handles": {}
          },
          {
            "name": "apptension-review:code-review",
            "display_name": "apptension-review:code-review",
            "description": "Use when the user wants a methodical code review of any changeset — uncommitted/staged changes, a commit range, a single commit, or a pull request. Reviews changed files across seven quality areas (including Product experience for UI) and prints the findings in the session by default, then offers to post them to a PR (as a review or inline comments), open/update GitHub issues, or save to a file. Trigger on intent like \"review my changes\", \"review this PR\", \"review main..HEAD\", or when a diff/commit/PR is offered for review.",
            "source": "plugin",
            "tokens": 186,
            "state": "on",
            "locked_by": "plugin",
            "advertised": true,
            "handles": {}
          }
        ]
      }
    }
  },
  "codex": {
    "id": 2,
    "result": {
      "data": [
        {
          "cwd": "/tmp/skill-list-probe/repo",
          "skills": [
            {
              "name": "probe-project",
              "description": "Project probe skill.",
              "path": "/tmp/skill-list-probe/repo/.agents/skills/probe-project/SKILL.md",
              "scope": "repo",
              "enabled": true,
              "pluginId": null
            },
            {
              "name": "capture",
              "description": "Turns a folder of mixed source files (PDF, images, screenshots, whiteboard photos, audio, video, live pages and feeds) into one tagged requirements list, each requirement cited to its file and to where in it (page and region, or seconds into a recording), with conflicts and unreadable files listed. Use when several people sent what they want in different formats and you need one list to build from.",
              "path": "/home/probe/.agents/skills/capture/SKILL.md",
              "scope": "user",
              "enabled": true,
              "pluginId": null
            },
            {
              "name": "apptension-review:code-review",
              "description": "Use when the user wants a methodical code review of any changeset — uncommitted/staged changes, a commit range, a single commit, or a pull request. Reviews changed files across seven quality areas (including Product experience for UI) and prints the findings in the session by default, then offers to post them to a PR (as a review or inline comments), open/update GitHub issues, or save to a file. Trigger on intent like \"review my changes\", \"review this PR\", \"review main..HEAD\", or when a diff/commit/PR is offered for review.",
              "path": "/home/probe/.codex/plugins/cache/apptension-dev/apptension-review/0.7.4/skills/code-review/SKILL.md",
              "scope": "user",
              "enabled": true,
              "pluginId": "apptension-review@apptension-dev"
            }
          ],
          "errors": [
            {
              "path": "/tmp/skill-list-probe/repo/.agents/skills/probe-bad/SKILL.md",
              "message": "missing YAML frontmatter delimited by ---"
            }
          ]
        }
      ]
    }
  },
  "opencode": [
    {
      "name": "probe-project",
      "description": "Project probe skill.",
      "location": "/tmp/skill-list-probe/repo/.agents/skills/probe-project/SKILL.md"
    },
    {
      "name": "capture",
      "description": "Turns a folder of mixed source files (PDF, images, screenshots, whiteboard photos, audio, video, live pages and feeds) into one tagged requirements list, each requirement cited to its file and to where in it (page and region, or seconds into a recording), with conflicts and unreadable files listed. Use when several people sent what they want in different formats and you need one list to build from.",
      "location": "/home/probe/.agents/skills/capture/SKILL.md"
    },
    {
      "name": "setup-verification-maintenance",
      "description": "Use when installing or updating scheduled maintenance for a project-owned verification skill, including when setup offers maintenance after finding or creating that skill.",
      "location": "/home/probe/.cache/opencode/packages/apptension-dev-toolkit@git+https:/github.com/apptension/toolkit-dev.git/node_modules/apptension-dev-toolkit/plugins/apptension-sdlc/skills/setup-verification-maintenance/SKILL.md"
    }
  ],
  "pi": {
    "id": "skills",
    "type": "response",
    "command": "get_commands",
    "success": true,
    "data": {
      "commands": [
        {
          "name": "skill:probe-project",
          "description": "Project probe skill.",
          "source": "skill",
          "sourceInfo": {
            "path": "/tmp/skill-list-probe/repo/.pi/skills/probe-project/SKILL.md",
            "source": "extension:pi-project-skills.mjs",
            "scope": "temporary",
            "origin": "top-level",
            "baseDir": "/home/probe/projects/cezar/.ai/squawk/worktrees/39672b0d-5187-4189-9fac-580eb89c5106/packages/cezar/scripts"
          }
        },
        {
          "name": "skill:capture",
          "description": "Turns a folder of mixed source files (PDF, images, screenshots, whiteboard photos, audio, video, live pages and feeds) into one tagged requirements list, each requirement cited to its file and to where in it (page and region, or seconds into a recording), with conflicts and unreadable files listed. Use when several people sent what they want in different formats and you need one list to build from.",
          "source": "skill",
          "sourceInfo": {
            "path": "/home/probe/.agents/skills/capture/SKILL.md",
            "source": "auto",
            "scope": "user",
            "origin": "top-level",
            "baseDir": "/home/probe/.agents"
          }
        },
        {
          "name": "skill:cezar-cockpit",
          "description": "Use when opening the Cezar cockpit for the repo it is configured in — finding an already-running cockpit and returning this project's URL rather than starting a second one. Trigger on intent like \"open Cezar\", \"start the cockpit\", \"show me the dispatched tasks\", \"where is that run\".",
          "source": "skill",
          "sourceInfo": {
            "path": "/home/probe/.pi/agent/git/github.com/apptension/toolkit-dev/plugins/apptension-sdlc/skills/cezar-cockpit/SKILL.md",
            "source": "extension:apptension-dev",
            "scope": "temporary",
            "origin": "top-level",
            "baseDir": "/home/probe/.pi/agent/git/github.com/apptension/toolkit-dev/.pi/extensions"
          }
        }
      ]
    }
  },
  "omp": {
    "skills": [
      {
        "name": "probe-project",
        "description": "Project probe skill.",
        "filePath": "/tmp/skill-list-probe/repo/.omp/skills/probe-project/SKILL.md",
        "baseDir": "/tmp/skill-list-probe/repo/.omp/skills/probe-project",
        "source": "native:project",
        "hide": false
      },
      {
        "name": "capture",
        "description": "Turns a folder of mixed source files (PDF, images, screenshots, whiteboard photos, audio, video, live pages and feeds) into one tagged requirements list, each requirement cited to its file and to where in it (page and region, or seconds into a recording), with conflicts and unreadable files listed. Use when several people sent what they want in different formats and you need one list to build from.",
        "filePath": "/home/probe/.agents/skills/capture/SKILL.md",
        "baseDir": "/home/probe/.agents/skills/capture",
        "source": "agents:user",
        "hide": false
      },
      {
        "name": "audit-agent-readiness",
        "description": "Use when judging whether agents can work in a repo safely and alone, or when setup offers it. Mines the repo's history for mistakes agents repeat, probes a disposable worktree, reads agent instructions for prose that works around a code defect, and returns improvements grouped by the highest layer where each fix works. Trigger on intent like \"is this repo ready for agents\", \"audit agent readiness\", or \"why do agents keep tripping here\".",
        "filePath": "/home/probe/.claude/plugins/cache/apptension-dev/apptension-sdlc/0.25.79/skills/audit-agent-readiness/SKILL.md",
        "baseDir": "/home/probe/.claude/plugins/cache/apptension-dev/apptension-sdlc/0.25.79/skills/audit-agent-readiness",
        "source": "agent-plugins:user",
        "hide": false
      }
    ],
    "warnings": [
      {
        "skillPath": "",
        "message": "[Agent Plugins] [agent-plugins] apptension-sdlc: Skipping skill \"dev-flow\": unexpected frontmatter field \"requires\""
      }
    ]
  }
};
