import * as fs from "node:fs"
import type { Hooks } from "@opencode-ai/plugin"
import type { Plugin as V2Plugin } from "@opencode/plugin"
import { loadPluginConfig } from "../plugin-config"
import { createPluginModule } from "../testing/create-plugin-module"
import { translateAgentToV2Draft } from "./translate-agent"
import { buildV1Input, v2LocationDirectory } from "./v1-input"
import { createV1ClientAdapter } from "./v1-client"

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
type V2Registration = { dispose: () => Promise<void> }

function safeStringify(value: unknown): string {
  if (typeof value === "string") return value
  try {
    const text = JSON.stringify(value)
    return typeof text === "string" ? text : String(value)
  } catch {
    return String(value)
  }
}

async function bridgeToolHooks(ctx: V2Context, hooks: Hooks, registrations: V2Registration[]): Promise<void> {
  const v1Before = hooks["tool.execute.before"]
  if (v1Before !== undefined) {
    registrations.push(
      await ctx.tool.hook("execute.before", async (e) => {
        const outputView = {
          get args(): unknown {
            return e.input
          },
          set args(value: unknown) {
            e.input = value
          },
        }
        try {
          await v1Before({ tool: e.tool, sessionID: e.sessionID, callID: e.id } as never, outputView as never)
        } catch (error: unknown) {
          // Intentional rethrow: V1 semantics treat a before-hook throw as
          // "block the tool call".
          throw error
        }
      }),
    )
    spikeLog("v2_bridge_before_registered")
  } else {
    spikeLog("v2_bridge_before_absent")
  }

  const v1After = hooks["tool.execute.after"]
  if (v1After !== undefined) {
    registrations.push(
      await ctx.tool.hook("execute.after", async (e) => {
        const outputView = {
          title: "",
          output: e.status === "completed" ? safeStringify(e.result) : "",
          metadata: e,
        }
        try {
          await v1After(
            { tool: e.tool, sessionID: e.sessionID, callID: e.id, args: e.input } as never,
            outputView as never,
          )
        } catch (error: unknown) {
          // V1 after-hooks catch internally; guard anyway so a regression can
          // never break tool-result delivery.
          spikeLog("v2_bridge_after_failed", { message: error instanceof Error ? error.message : String(error) })
        }
      }),
    )
    spikeLog("v2_bridge_after_registered")
  } else {
    spikeLog("v2_bridge_after_absent")
  }
}

/**
 * Phase 2a setup: Phase 1 spike (provider/model transforms, sisyphus upsert)
 * plus a guarded boot of the real V1 factory with the adapted client, then
 * Session+ToolGuard coverage via tool.execute.before/after bridges.
 * A factory failure degrades to Phase-1-only behavior — setup never throws.
 */
export function createV2SpikeSetup(): V2Plugin.Plugin {
  return {
    id: "oh-my-openagent",
    setup: async (ctx: V2Context): Promise<V2Plugin.Cleanup | void> => {
      const directory = v2LocationDirectory(ctx)
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

      const registrations: V2Registration[] = []
      let v1dispose: (() => Promise<void>) | undefined
      try {
        const client = createV1ClientAdapter(ctx)
        const v1input = buildV1Input(ctx, client)
        const v1hooks = await createPluginModule().server(v1input, {})
        spikeLog("v2_factory_booted", { keys: Object.keys(v1hooks) })
        await bridgeToolHooks(ctx, v1hooks, registrations)
        if (typeof v1hooks.dispose === "function") {
          const dispose = v1hooks.dispose.bind(v1hooks)
          v1dispose = () => dispose() as Promise<void>
        }
      } catch (error: unknown) {
        spikeLog("v2_factory_failed", {
          message: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack?.slice(0, 600) : undefined,
        })
      }

      spikeLog("v2_setup_ready", { bridges: registrations.length })
      return async () => {
        for (const registration of registrations) {
          try {
            await registration.dispose()
          } catch (error: unknown) {
            spikeLog("v2_dispose_failed", { message: error instanceof Error ? error.message : String(error) })
          }
        }
        if (v1dispose !== undefined) {
          try {
            await v1dispose()
          } catch (error: unknown) {
            spikeLog("v2_v1_dispose_failed", { message: error instanceof Error ? error.message : String(error) })
          }
        }
        spikeLog("v2_setup_cleanup")
      }
    },
  }
}
