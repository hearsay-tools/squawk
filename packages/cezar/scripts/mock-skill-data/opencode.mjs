// Native captures for the opencode mock, equal to runners/opencode/__fixtures__/skill-list.json and skill-trigger.json.
// skillList: metadata excerpts, no skill bodies. skillTrigger: the minimal native frames of one skill turn.
export const skillList = [
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
];

export const skillTrigger = [
  {
    "id": "evt_1e644647c001JBwTUFa85HuwXe",
    "type": "message.updated",
    "properties": {
      "sessionID": "ses_e19bb9f24ffeDLvpKOwIDRYASe",
      "info": {
        "id": "msg_1e6446472001QbxAqCh8Ka3c05",
        "role": "user",
        "sessionID": "ses_e19bb9f24ffeDLvpKOwIDRYASe",
        "time": {
          "created": 1794864604274
        },
        "agent": "build",
        "model": {
          "providerID": "zai-coding-plan",
          "modelID": "glm-5.3-flash",
          "variant": "low"
        }
      }
    }
  },
  {
    "id": "evt_1e644647f001kxHleStwdpUoJf",
    "type": "message.part.updated",
    "properties": {
      "sessionID": "ses_e19bb9f24ffeDLvpKOwIDRYASe",
      "part": {
        "type": "text",
        "text": "Reply with exactly TRIGGER-FIXTURE. Do not use any tool.\n\n\nBase directory for this skill: /probe/repo/.agents/skills/probe-project\nRelative paths in this skill (e.g., scripts/, references/) are relative to this base directory.\n\nfixture arguments\n\nOpening context: this is a native skill probe.",
        "messageID": "msg_1e6446472001QbxAqCh8Ka3c05",
        "sessionID": "ses_e19bb9f24ffeDLvpKOwIDRYASe",
        "id": "prt_1e644647a001VORV1UrikmnbBw"
      },
      "time": 1794864604287
    }
  },
  {
    "id": "evt_1e644650a001T722fN64VA9xFq",
    "type": "message.updated",
    "properties": {
      "sessionID": "ses_e19bb9f24ffeDLvpKOwIDRYASe",
      "info": {
        "role": "user",
        "time": {
          "created": 1794864604274
        },
        "agent": "build",
        "model": {
          "providerID": "zai-coding-plan",
          "modelID": "glm-5.3-flash",
          "variant": "low"
        },
        "id": "msg_1e6446472001QbxAqCh8Ka3c05",
        "sessionID": "ses_e19bb9f24ffeDLvpKOwIDRYASe",
        "summary": {
          "diffs": []
        }
      }
    }
  }
];
