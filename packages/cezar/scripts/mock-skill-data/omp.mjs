// Native captures for the omp mock, equal to runners/omp/__fixtures__/skill-list.json and skill-trigger.json.
// skillList: metadata excerpts, no skill bodies. skillTrigger: the minimal native frames of one skill turn.
export const skillList = {
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
};

export const skillTrigger = [
  {
    "type": "message_start",
    "message": {
      "role": "custom",
      "customType": "skill-prompt",
      "content": "[IMPORTANT: User invoked the \"probe-project\" skill; follow its instructions. Full skill below.]\n\nReply with exactly TRIGGER-FIXTURE. Do not use any tool.\n\n---\n\n[Skill directory: /probe/repo/.omp/skills/probe-project]\nResolve relative paths in this skill (e.g. `scripts/foo.js`, `templates/config.yaml`) against this absolute directory; read referenced assets and templates; run scripts with the terminal tool when skill instructions call for it.\nUser: fixture arguments",
      "display": true,
      "details": {
        "name": "probe-project",
        "path": "/probe/repo/.omp/skills/probe-project/SKILL.md",
        "args": "fixture arguments",
        "prompt": "/skill:probe-project fixture arguments",
        "lineCount": 1,
        "__queueChipText": "/skill:probe-project fixture arguments"
      },
      "attribution": "user",
      "timestamp": 1794864791306
    },
    "messageId": "msg-3"
  }
];
