/**
 * Native model-settings readers (`@hearsay-tools/squawk/plugin/model-settings`). Kept separate
 * from `@hearsay-tools/squawk/plugin` so TOML and YAML parsers load only when model settings or
 * runtime config files are read.
 * Unstable: it may change in any release until Squawk installs plugins from npm or git.
 */

export {
  configuredString, firstConfiguredModel, firstConfiguredProvider, parseConfigContent, readNativeSettingsFiles,
} from '../agent-config/model-settings/shared.ts';
export type { NativeSettingsFile } from '../agent-config/model-settings/shared.ts';
