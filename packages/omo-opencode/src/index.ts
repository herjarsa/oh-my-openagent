import type { PluginModule } from "@opencode-ai/plugin"
import { createPluginModule } from "./testing/create-plugin-module"
import { omoV2Plugin } from "./plugin-v2"

const pluginModule: PluginModule = createPluginModule()

export const omoPlugin = pluginModule.server

/**
 * Dual V1+V2 default export. V1 hosts read `.server`; V2 hosts require
 * `.id` + `.setup`/`.effect`. Extra keys are tolerated by both loaders
 * (proven live: V2 registers the id, V1 keeps working).
 */
const dualPluginModule = { ...pluginModule, ...omoV2Plugin }

export default dualPluginModule

export type {
  AgentName,
  AgentOverrideConfig,
  AgentOverrides,
  BuiltinCommandName,
  HookName,
  McpName,
  OhMyOpenCodeConfig,
} from "./config"

export type { ConfigLoadError } from "./shared/config-errors"
