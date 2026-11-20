// Native captures for the codex mock, equal to runners/codex/__fixtures__/skill-list.json and skill-trigger.json.
// skillList: metadata excerpts, no skill bodies. skillTrigger: the minimal native frames of one skill turn.
export const skillList = {
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
};

export const skillTrigger = [
  {
    "method": "item/completed",
    "params": {
      "item": {
        "type": "userMessage",
        "id": "01a1e643-bfff-7ef0-82eb-ce4be47adf26",
        "clientId": null,
        "content": [
          {
            "type": "text",
            "text": "fixture arguments\n\nOpening context: this is a native skill probe.",
            "text_elements": []
          },
          {
            "type": "skill",
            "name": "probe-project",
            "path": "/probe/repo/.agents/skills/probe-project/SKILL.md"
          }
        ]
      },
      "threadId": "01a1e643-bb67-73c2-861d-72bcb2b3aa72",
      "turnId": "01a1e643-bbb2-70c2-9cb8-9b4451cb79b7",
      "completedAtMs": 1794864562177
    },
    "emittedAtMs": 1794864562180
  }
];
