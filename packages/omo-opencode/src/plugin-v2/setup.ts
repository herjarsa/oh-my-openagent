import * as fs from "node:fs"
import type { Hooks } from "@opencode-ai/plugin"
import type { Plugin as V2Plugin } from "@opencode/plugin"
import { loadPluginConfig } from "../plugin-config"
import { createPluginModule } from "../testing/create-plugin-module"
import { applyChatMessageView, buildChatMessageView } from "./hook-bridge-chat"
import { buildV1EventView } from "./hook-bridge-events"
import { applyChatParamsView, buildChatHeadersView, buildChatParamsView } from "./hook-bridge-params"
import { bridgeTransforms } from "./hook-bridge-transforms"
import { registerBuiltinMcps } from "./mcp-bridge-register"
import { registerV1Tools } from "./tool-bridge-register"
import { createBuiltinAgents } from "../agents/builtin-agents"
import { translateAgentConfigToV2Draft, translateAgentToV2Draft } from "./translate-agent"
import { buildV1Input, v2LocationDirectory } from "./v1-input"
import { createV1ClientAdapter } from "./v1-client"

// SPIKE-ONLY log. Never console.* (leaks into the TUI). The real port routes
// diagnostics through its own file logger like meta-governor does.
import { portLogPath } from "./log"

const SPIKE_LOG = portLogPath()

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

async function bridgeChatMessage(ctx: V2Context, hooks: Hooks, registrations: V2Registration[]): Promise<void> {
  const v1ChatMessage = (hooks as unknown as Record<string, unknown>)["chat.message"]
  if (typeof v1ChatMessage !== "function") {
    spikeLog("v2_bridge_chat_absent")
    return
  }
  const handler = v1ChatMessage as (input: unknown, output: unknown) => Promise<unknown>
  registrations.push(
    await ctx.session.hook("prompt", async (e) => {
      try {
        const prompt = e.prompt as unknown as { text?: unknown }
        const before = typeof prompt.text === "string" ? prompt.text : ""
        const { input, output } = buildChatMessageView({ sessionID: e.sessionID, prompt: e.prompt })
        await handler(input as never, output as never)
        if (applyChatMessageView(prompt, before, output)) {
          spikeLog("v2_bridge_chat_rewrote", { sessionID: e.sessionID })
        }
      } catch (error: unknown) {
        // Never break prompt admission because of governance injection.
        spikeLog("v2_bridge_chat_failed", { message: error instanceof Error ? error.message : String(error) })
      }
    }),
  )
  spikeLog("v2_bridge_chat_registered")
}

const droppedEventTypes = new Map<string, number>()

async function bridgeChatParams(ctx: V2Context, hooks: Hooks, registrations: V2Registration[]): Promise<void> {
  const v1ChatParams = (hooks as unknown as Record<string, unknown>)["chat.params"]
  if (typeof v1ChatParams !== "function") {
    spikeLog("v2_bridge_params_absent")
    return
  }
  const handler = v1ChatParams as (input: unknown, output: unknown) => Promise<unknown>
  registrations.push(
    await ctx.session.hook("context", async (e) => {
      try {
        const view = buildChatParamsView({
          sessionID: e.sessionID,
          agent: (e as unknown as { agent?: unknown }).agent,
          model: (e as unknown as { model?: { providerID?: unknown; id?: unknown } }).model,
          options: e.options as Record<string, unknown>,
        })
        if (view === null) return
        await handler(view.input as never, view.output as never)
        applyChatParamsView(e.options as Record<string, unknown>, view.output)
      } catch (error: unknown) {
        spikeLog("v2_bridge_params_failed", { message: error instanceof Error ? error.message : String(error) })
      }
    }),
  )
  spikeLog("v2_bridge_params_registered")
}

async function bridgeChatHeaders(ctx: V2Context, hooks: Hooks, registrations: V2Registration[]): Promise<void> {
  const v1ChatHeaders = (hooks as unknown as Record<string, unknown>)["chat.headers"]
  if (typeof v1ChatHeaders !== "function") {
    spikeLog("v2_bridge_headers_absent")
    return
  }
  const handler = v1ChatHeaders as (input: unknown, output: unknown) => Promise<unknown>
  registrations.push(
    await ctx.session.hook("model.request", async (e) => {
      try {
        const view = buildChatHeadersView({
          sessionID: e.sessionID,
          model: (e as unknown as { model?: { providerID?: unknown } }).model,
        })
        if (view === null) return
        await handler(view.input as never, view.output as never)
        Object.assign(e.headers, view.output.headers)
      } catch (error: unknown) {
        spikeLog("v2_bridge_headers_failed", { message: error instanceof Error ? error.message : String(error) })
      }
    }),
  )
  spikeLog("v2_bridge_headers_registered")
}

async function bridgeServerEvents(
  ctx: V2Context,
  hooks: Hooks,
  abort: AbortController,
): Promise<void> {
  const v1Event = (hooks as unknown as Record<string, unknown>)["event"]
  if (typeof v1Event !== "function") {
    spikeLog("v2_bridge_event_absent")
    return
  }
  const handler = v1Event as (input: unknown) => Promise<unknown>
  spikeLog("v2_bridge_event_subscribed")
  try {
    for await (const event of ctx.event.subscribe({ signal: abort.signal })) {
      const rec = (event !== null && typeof event === "object" ? event : {}) as { type?: unknown; data?: unknown }
      if (typeof rec.type !== "string") continue
      const view = buildV1EventView({ type: rec.type, data: rec.data })
      if (view === null) {
        const count = (droppedEventTypes.get(rec.type) ?? 0) + 1
        droppedEventTypes.set(rec.type, count)
        if (count === 1) spikeLog("v2_bridge_event_dropped", { type: rec.type })
        continue
      }
      try {
        await handler({ event: view } as never)
      } catch (error: unknown) {
        spikeLog("v2_bridge_event_failed", {
          type: rec.type,
          message: error instanceof Error ? error.message : String(error),
        })
      }
    }
  } catch (error: unknown) {
    // Abort on cleanup lands here — expected, not an error.
    spikeLog("v2_bridge_event_loop_ended", { message: error instanceof Error ? error.message : String(error) })
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

      const rootConfig = config as unknown as {
        agents?: Record<string, unknown>
        categories?: Record<string, never>
        disabled_agents?: string[]
        disabled_skills?: string[]
        disabled_tools?: string[]
        disabled_mcps?: string[]
        websearch?: { provider?: string }
        git_master?: { commit_footer?: boolean }
        browser_automation_engine?: { provider?: string }
        new_task_system_enabled?: boolean
        experimental?: { disable_omo_env?: boolean }
        team_mode?: { enabled?: boolean }
        sisyphus_agent?: { planner_enabled?: boolean }
      }
      const agents = rootConfig.agents ?? {}
      const applyDraft = (
        editor: {
          update: (id: string, update: (agent: unknown) => void) => void
        },
        id: string,
        draft: {
          description?: string
          mode?: "primary" | "subagent" | "all"
          model?: { providerID: string; id: string; variant?: string }
          color?: string
          steps?: number
          system?: string
          permissions?: { action: string; resource: string; effect: "allow" | "ask" | "deny" }[]
        },
      ): void => {
        editor.update(id, (agent) => {
          const target = agent as unknown as Record<string, unknown>
          if (draft.description !== undefined) target["description"] = draft.description
          if (draft.mode !== undefined) target["mode"] = draft.mode
          if (draft.model !== undefined) target["model"] = draft.model
          if (draft.color !== undefined) target["color"] = draft.color
          if (draft.steps !== undefined) target["steps"] = draft.steps
          if (draft.system !== undefined) target["system"] = draft.system
          if (draft.permissions !== undefined) target["permissions"] = draft.permissions
        })
      }

      // Full path: resolve all builtin agents through the real V1 factory
      // (categories, overrides, model chains) and upsert each in ONE transform.
      let fullAgentsDone = false
      try {
        const builtin = await createBuiltinAgents(
          rootConfig.disabled_agents ?? [],
          (rootConfig.agents ?? {}) as never,
          directory,
          undefined,
          rootConfig.categories as never,
          rootConfig.git_master as never,
          [],
          undefined,
          rootConfig.browser_automation_engine?.provider as never,
          undefined,
          rootConfig.disabled_skills !== undefined ? new Set(rootConfig.disabled_skills) : undefined,
          rootConfig.new_task_system_enabled ?? false,
          rootConfig.experimental?.disable_omo_env ?? false,
          rootConfig.team_mode?.enabled ?? false,
        )
        const entries = Object.entries(builtin)
        await ctx.agent.transform((editor) => {
          for (const [name, agentConfig] of entries) {
            const draft = translateAgentConfigToV2Draft(name, agentConfig as never)
            if (draft === null) {
              spikeLog("v2_agent_skipped", { id: name, reason: "disabled" })
              continue
            }
            try {
              applyDraft(
                editor as never,
                draft.id,
                draft as never,
              )
            } catch (error: unknown) {
              spikeLog("v2_agent_failed", {
                id: name,
                message: error instanceof Error ? error.message : String(error),
              })
            }
          }
        })
        spikeLog("v2_agents_upserted", { count: entries.length, names: entries.map(([name]) => name) })
        fullAgentsDone = true

        // Stage 2 (mirrors createCoreAgentConfig in
        // plugin-handlers/agent-config-assembly.ts): prometheus via its
        // builder (when the planner is enabled) and sisyphus-junior via its
        // overrides factory. Neither comes out of createBuiltinAgents.
        const extraAgents: Array<{ id: string; config: unknown }> = []
        try {
          if (rootConfig.sisyphus_agent?.planner_enabled ?? true) {
            const { buildPrometheusAgentConfig } = await import(
              "../plugin-handlers/prometheus-agent-config-builder"
            )
            extraAgents.push({
              id: "prometheus",
              config: await buildPrometheusAgentConfig({
                configAgentPlan: undefined,
                pluginPrometheusOverride: (rootConfig.agents?.["prometheus"] ?? undefined) as never,
                userCategories: rootConfig.categories as never,
                currentModel: undefined,
                disabledTools: rootConfig.disabled_tools,
              }),
            })
          }
        } catch (error: unknown) {
          spikeLog("v2_agent_prometheus_failed", { message: error instanceof Error ? error.message : String(error) })
        }
        try {
          const { createSisyphusJuniorAgentWithOverrides } = await import("../agents/sisyphus-junior")
          const atlasModel = (builtin["atlas"] !== null && typeof builtin["atlas"] === "object"
            ? (builtin["atlas"] as Record<string, unknown>)["model"]
            : undefined) as string | undefined
          extraAgents.push({
            id: "sisyphus-junior",
            config: createSisyphusJuniorAgentWithOverrides(
              (rootConfig.agents?.["sisyphus-junior"] ?? undefined) as never,
              atlasModel,
              rootConfig.new_task_system_enabled ?? false,
            ),
          })
        } catch (error: unknown) {
          spikeLog("v2_agent_junior_failed", { message: error instanceof Error ? error.message : String(error) })
        }
        if (extraAgents.length > 0) {
          try {
            await ctx.agent.transform((editor) => {
              for (const { id, config: agentConfig } of extraAgents) {
                const draft = translateAgentConfigToV2Draft(id, agentConfig as never)
                if (draft === null) {
                  spikeLog("v2_agent_skipped", { id, reason: "disabled" })
                  continue
                }
                try {
                  applyDraft(editor as never, draft.id, draft as never)
                } catch (error: unknown) {
                  spikeLog("v2_agent_failed", {
                    id,
                    message: error instanceof Error ? error.message : String(error),
                  })
                }
              }
            })
            spikeLog("v2_agents_extra_upserted", { names: extraAgents.map(({ id }) => id) })
          } catch (error: unknown) {
            spikeLog("v2_agents_extra_failed", { message: error instanceof Error ? error.message : String(error) })
          }
        }
      } catch (error: unknown) {
        spikeLog("v2_agents_factory_failed", { message: error instanceof Error ? error.message : String(error) })
      }

      // Fallback: sisyphus-only override translation (Phase 1 path).
      if (!fullAgentsDone) {
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
      }

      const registrations: V2Registration[] = []
      let v1dispose: (() => Promise<void>) | undefined
      let eventAbort: AbortController | undefined
      let eventLoop: Promise<void> | undefined
      try {
        const client = createV1ClientAdapter(ctx)
        const v1input = buildV1Input(ctx, client)
        const v1hooks = await createPluginModule().server(v1input, {})
        spikeLog("v2_factory_booted", { keys: Object.keys(v1hooks) })
        await bridgeToolHooks(ctx, v1hooks, registrations)
        await bridgeChatParams(ctx, v1hooks, registrations)
        await bridgeTransforms(ctx, v1hooks, registrations)
        try {
          await ctx.mcp.transform((editor) => {
            registerBuiltinMcps(
              { set: (name, mcpConfig) => editor.set(name, mcpConfig as never) },
              { disabledMcps: rootConfig.disabled_mcps, websearch: rootConfig.websearch },
            )
          })
        } catch (error: unknown) {
          spikeLog("v2_mcp_transform_failed", { message: error instanceof Error ? error.message : String(error) })
        }
        if (rootConfig.disabled_skills !== undefined && rootConfig.disabled_skills.length > 0) {
          try {
            await ctx.skill.transform((editor) => {
              const removed: string[] = []
              for (const name of rootConfig.disabled_skills ?? []) {
                try {
                  editor.remove(name)
                  removed.push(name)
                } catch (error: unknown) {
                  spikeLog("v2_skill_remove_failed", {
                    name,
                    message: error instanceof Error ? error.message : String(error),
                  })
                }
              }
              spikeLog("v2_skills_pruned", { removed })
            })
          } catch (error: unknown) {
            spikeLog("v2_skill_transform_failed", { message: error instanceof Error ? error.message : String(error) })
          }
        }
        const v1tools = (v1hooks as unknown as { tool?: unknown }).tool
        if (v1tools !== null && typeof v1tools === "object") {
          try {
            await ctx.tool.transform((editor) => {
              const result = registerV1Tools(
                { add: (tool) => editor.add(tool as never) },
                v1tools as never,
                { directory },
              )
              spikeLog("v2_toolmap_registered", {
                count: result.registered.length,
                failed: result.failed.map((entry) => entry.name),
                names: result.registered,
              })
            })
          } catch (error: unknown) {
            spikeLog("v2_toolmap_failed", { message: error instanceof Error ? error.message : String(error) })
          }
        } else {
          spikeLog("v2_toolmap_absent")
        }
        await bridgeChatHeaders(ctx, v1hooks, registrations)
        await bridgeChatMessage(ctx, v1hooks, registrations)
        eventAbort = new AbortController()
        eventLoop = bridgeServerEvents(ctx, v1hooks, eventAbort)
        eventLoop.catch(() => undefined)
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
        if (eventAbort !== undefined && eventLoop !== undefined) {
          eventAbort.abort()
          try {
            await eventLoop
          } catch {
            // Abort on cleanup lands here — expected.
          }
        }
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
