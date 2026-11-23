import type { AutomationToolService } from '../workflows/run/types.ts';
import type { SquawkToolHandlers } from '../ci-wait/controller.ts';
import { scheduleRefusal } from './tool-errors.ts';

export function automationSessionHandlers(host: { awaitAutomationTools(signal: AbortSignal): Promise<AutomationToolService | undefined> }): Pick<SquawkToolHandlers, 'automation' | 'scheduleTask' | 'scheduledTasks'> {
  return {
    automation: async (request, signal) => {
      const tools = await host.awaitAutomationTools(signal);
      return tools?.automation ? tools.automation(request, signal) : scheduleRefusal('unavailable');
    },
    // A schedule belongs to the project, not to this run: any session there may manage one.
    scheduleTask: async (request, signal) => {
      const tools = await host.awaitAutomationTools(signal);
      return tools ? tools.scheduleTask(request) : scheduleRefusal('unavailable');
    },
    scheduledTasks: async (request, signal) => {
      const tools = await host.awaitAutomationTools(signal);
      return tools ? tools.scheduledTasks(request) : scheduleRefusal('unavailable');
    },
  };
}
