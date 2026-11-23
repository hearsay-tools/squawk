import './ci-wait/tools.testkit.ts';
import { registerBuiltInCliCommands, sealBuiltInCliCommands } from './built-in-cli-commands.ts';
registerBuiltInCliCommands();
sealBuiltInCliCommands();
