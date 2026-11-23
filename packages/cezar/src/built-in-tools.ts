import { coreAgentTools } from './built-in-tool-definitions.ts';
import { previewAgentTools } from './preview/agent-tools.ts';
import { automationAgentTools } from './automations/agent-tools.ts';
import { registerAgentTool } from './ci-wait/tool-registry.ts';
export { sealAgentTools as sealBuiltInTools } from './ci-wait/tool-registry.ts';
/** Shell boot registers every built-in before the caller seals the registry. */
export function registerBuiltInTools(): void {
  for (const tool of [...coreAgentTools, ...previewAgentTools, ...automationAgentTools]) registerAgentTool(tool);
}
