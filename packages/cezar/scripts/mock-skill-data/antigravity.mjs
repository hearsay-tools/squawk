// Native captures for the antigravity mock, equal to runners/antigravity/__fixtures__/skill-list.json and skill-trigger.json.
// skillList: metadata excerpts, no skill bodies. skillTrigger: the minimal native frames of one skill turn.
export const skillList = {
  "event": "command_result",
  "command": {
    "name": "skills",
    "data": {
      "skills": [
        {
          "name": "agy-customizations",
          "description": "Comprehensive guide and reference for the Antigravity Customization System. Use to explain how customizations work, their loading priority, discovery mechanisms, and to guide the creation of skills, rules, plugins, hooks, and MCP servers.",
          "path": "/home/probe/.gemini/antigravity-cli/builtin/skills/agy-customizations/SKILL.md",
          "builtin": true,
          "model_invocable": true
        },
        {
          "name": "apptension-review:code-review",
          "description": "Methodical code review of a changeset.",
          "path": "/home/probe/.gemini/config/plugins/apptension-review/skills/code-review/SKILL.md",
          "plugin": "apptension-review",
          "builtin": false,
          "model_invocable": true
        },
        {
          "name": "probe-project",
          "description": "Project probe skill.",
          "path": "/tmp/skill-list-probe/repo/.agents/skills/probe-project/SKILL.md",
          "builtin": false,
          "model_invocable": true
        },
        {
          "name": "probe-user",
          "description": "User probe skill.",
          "path": "/home/probe/.gemini/config/skills/probe-user/SKILL.md",
          "builtin": false,
          "model_invocable": true
        }
      ]
    }
  }
};

const skillRead = {
  toolCallId: 'call_598714134544840670',
  name: 'read_file',
  args: { Path: '/probe/repo/.agents/skills/probe-project/SKILL.md' },
  kind: 'read',
  title: 'File .agents/skills/probe-project/SKILL.md',
  locations: [{ path: '/probe/repo/.agents/skills/probe-project/SKILL.md' }],
  rawInput: { Path: '/probe/repo/.agents/skills/probe-project/SKILL.md' },
};

const sessionUpdate = update => ({
  from: 'agent',
  frame: {
    jsonrpc: '2.0',
    method: 'session/update',
    params: { sessionId: '89c39b17-7545-4378-80be-0b3b92ead252', update },
  },
});

export const skillTrigger = [
  sessionUpdate({ sessionUpdate: 'tool_call', ...skillRead, status: 'in_progress' }),
  sessionUpdate({ sessionUpdate: 'tool_call_update', ...skillRead, status: 'completed' }),
  sessionUpdate({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'TRIGGER-FIXTURE' } }),
];
