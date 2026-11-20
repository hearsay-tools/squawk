// Native captures for the pi mock, equal to runners/pi/__fixtures__/skill-list.json and skill-trigger.json.
// skillList: metadata excerpts, no skill bodies. skillTrigger: the minimal native frames of one skill turn.
export const skillList = {
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
};

export const skillTrigger = [
  {
    "type": "message_start",
    "message": {
      "role": "user",
      "content": [
        {
          "type": "text",
          "text": "<skill name=\"probe-project\" location=\"/probe/repo/.pi/skills/probe-project/SKILL.md\">\nReferences are relative to /probe/repo/.pi/skills/probe-project.\n\nReply with exactly TRIGGER-FIXTURE. Do not use any tool.\n</skill>\n\nfixture arguments\n\nOpening context: this is a native skill probe."
        }
      ],
      "timestamp": 1794864645778
    }
  }
];
