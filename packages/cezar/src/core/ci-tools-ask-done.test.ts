import '../ci-wait/tools.testkit.ts';
import './every-runner.testkit.ts';
import { CI_NATIVE_GROUPS, registerCiNativeTools } from './ci-tools.testkit.ts';

registerCiNativeTools(CI_NATIVE_GROUPS.askDone);
