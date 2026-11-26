import './ci-wait/tools.testkit.ts';
import { registerBuiltInCliCommands, sealBuiltInCliCommands } from './built-in-cli-commands.ts';
import { registerCliCommand } from './core/cli-registry.ts';
import { jobCliCommand } from './features/jobs/index.ts';

// The shipped command table, with the bundled jobs feature's `job` as boot registers it. A later
// `bootRuntime()` loads the jobs feature again; registering the same command object is a no-op.
registerBuiltInCliCommands();
registerCliCommand(jobCliCommand);
sealBuiltInCliCommands();
