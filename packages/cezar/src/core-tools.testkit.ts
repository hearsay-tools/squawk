import { coreAgentTools } from './built-in-tool-definitions.ts';
import { registerAgentTool, sealAgentTools } from './ci-wait/tool-registry.ts';

// Registers and seals only the four core agent tools (`cezar_wait`, `cezar_ask`,
// `cezar_cancel_wait`, `cezar_done`) without pulling feature tools (`preview`, `automations`)
// or sealing wait kinds / removal slots.
for (const tool of coreAgentTools) registerAgentTool(tool);
sealAgentTools();
