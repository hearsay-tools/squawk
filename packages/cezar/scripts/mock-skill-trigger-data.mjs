// Native captures from core/__fixtures__/<runner>/skill-trigger.json. See slice2-evidence.md.
export const captures = {
  "claude": [
    {
      "type": "user",
      "message": {
        "role": "user",
        "content": "<command-message>probe-project</command-message>\n<command-name>/probe-project</command-name>\n<command-args>fixture arguments</command-args>"
      }
    },
    {
      "type": "user",
      "isMeta": true,
      "message": {
        "role": "user",
        "content": [
          {
            "type": "text",
            "text": "Opening context: this is a native skill probe."
          },
          {
            "type": "text",
            "text": "Base directory for this skill: /probe/repo/.claude/skills/probe-project\n\nReply with exactly TRIGGER-FIXTURE. Do not use any tool.\n\n\nARGUMENTS: fixture arguments"
          }
        ]
      }
    },
    {
      "type": "assistant",
      "message": {
        "role": "assistant",
        "content": [
          {
            "type": "text",
            "text": "TRIGGER-FIXTURE"
          }
        ]
      }
    }
  ],
  "codex": [
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
  ],
  "opencode": [
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
  ],
  "pi": [
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
  ],
  "omp": [
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
  ]
};
