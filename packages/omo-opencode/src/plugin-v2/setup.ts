import * as fs from "node:fs"
import type { Plugin as V2Plugin } from "@opencode/plugin"
import { loadPluginConfig } from "../plugin-config"
import { translateAgentToV2Draft } from "./translate-agent"

// SPIKE-ONLY log. Never console.* (leaks into the TUI). The real port routes
// diagnostics through its own file logger like meta-governor does.
const SPIKE_LOG = "C:\\Users\\herna\\AppData\\Local\\Temp\\opencode\\omo-v2-spike-log.jsonl"

function spikeLog(event: string, data: Record<string, unknown> = {}): void {
  try {
    fs.appendFileSync(SPIKE_LOG, `${JSON.stringify({ event, ...data })}\n`)
  } catch {
    // Spike observability must never break setup.
  }
}

type V2Context = V2Plugin.Context

function locationDirectory(ctx: V2Context): string {
  const location = (ctx as unknown as { location?: { directory?: unknown } }).location
  return typeof location?.directory === "string" && location.directory.length > 0
    ? location.directory
    : process.cwd()
}

/**
 * Phase 1 spike setup: dual-export companion to the V1 `server` module.
 * Boots the smallest real state first (provider/model transforms, one agent
 * upsert from the live `omo.jsonc`). Full V1 factory boot + hook bridging
 * arrive in Phase 2.
 */
export function createV2SpikeSetup(): V2Plugin.Plugin {
  return {
    id: "oh-my-openagent",
    setup: async (ctx: V2Context): Promise<V2Plugin.Cleanup | void> => {
      const directory = locationDirectory(ctx)
      spikeLog("v2_setup_start", { directory })

      let config: ReturnType<typeof loadPluginConfig>
      try {
        config = loadPluginConfig(directory, null)
      } catch (error: unknown) {
        spikeLog("v2_config_failed", { message: error instanceof Error ? error.message : String(error) })
        return
      }

      try {
        await ctx.provider.transform((editor) => {
          spikeLog("v2_provider_transform", { providers: editor.list().length })
        })
      } catch (error: unknown) {
        spikeLog("v2_provider_failed", { message: error instanceof Error ? error.message : String(error) })
      }

      try {
        await ctx.model.transform((editor) => {
          spikeLog("v2_model_transform", { models: editor.list().length })
        })
      } catch (error: unknown) {
        spikeLog("v2_model_failed", { message: error instanceof Error ? error.message : String(error) })
      }

      const agents = (config as unknown as { agents?: Record<string, unknown> }).agents ?? {}
      const sisyphus = agents["sisyphus"]
      if (sisyphus !== null && typeof sisyphus === "object") {
        const draft = translateAgentToV2Draft("sisyphus", sisyphus as Parameters<typeof translateAgentToV2Draft>[1])
        if (draft !== null) {
          try {
            await ctx.agent.transform((editor) => {
              editor.update(draft.id, (agent) => {
                const target = agent as unknown as Record<string, unknown>
                if (draft.description !== undefined) target["description"] = draft.description
                if (draft.mode !== undefined) target["mode"] = draft.mode
                if (draft.model !== undefined) target["model"] = draft.model
                if (draft.color !== undefined) target["color"] = draft.color
              })
            })
            spikeLog("v2_agent_upserted", { id: draft.id, model: draft.model })
          } catch (error: unknown) {
            spikeLog("v2_agent_failed", { message: error instanceof Error ? error.message : String(error) })
          }
        } else {
          spikeLog("v2_agent_skipped", { id: "sisyphus", reason: "disabled" })
        }
      } else {
        spikeLog("v2_agent_skipped", { id: "sisyphus", reason: "no-override" })
      }

      spikeLog("v2_setup_ready")
      return () => {
        spikeLog("v2_setup_cleanup")
      }
    },
  }
}
