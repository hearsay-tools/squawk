import './ci-wait/tools.testkit.ts';
import { registerBuiltInCliCommands, sealBuiltInCliCommands } from './built-in-cli-commands.ts';
import { registerCliCommand } from './core/cli-registry.ts';
import { jobCliCommand } from './features/jobs/index.ts';
import { mcpCliCommand } from './features/mcp/index.ts';

// The shipped command table, with the bundled feature commands as boot registers them. A later
// `bootRuntime()` loads the bundled features again; registering the same command object is a no-op.
registerBuiltInCliCommands();
registerCliCommand(jobCliCommand);
registerCliCommand(mcpCliCommand);
sealBuiltInCliCommands();
