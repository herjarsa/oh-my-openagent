import * as fs from "node:fs"
import type { Hooks } from "@opencode-ai/plugin"
import type { Plugin as V2Plugin } from "@opencode/plugin"

// SPIKE-ONLY log. Never console.* (leaks into the TUI).
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

function systemTextOf(part: unknown): string | null {
  if (part === null || typeof part !== "object") return null
  const rec = part as { type?: unknown; text?: unknown }
  if (rec.type !== "text" || typeof rec.text !== "string") return null
  return rec.text
}

function v2ContentToV1Parts(content: unknown): unknown[] {
  if (!Array.isArray(content)) return []
  const parts: unknown[] = []
  for (const entry of content) {
    if (entry === null || typeof entry !== "object") continue
    const rec = entry as { type?: unknown; text?: unknown }
    if (rec.type === "text" && typeof rec.text === "string") {
      parts.push({ type: "text", text: rec.text })
    }
  }
  return parts
}

function v1PartsToText(parts: unknown): string {
  if (!Array.isArray(parts)) return ""
  return parts
    .map((part) => {
      if (part === null || typeof part !== "object") return ""
      const rec = part as { type?: unknown; text?: unknown }
      return rec.type === "text" && typeof rec.text === "string" ? rec.text : ""
    })
    .filter((text) => text.length > 0)
    .join("\n\n")
}

function hookFn(hooks: Hooks, key: string): ((input: unknown, output: unknown) => Promise<unknown>) | undefined {
  const value = (hooks as unknown as Record<string, unknown>)[key]
  return typeof value === "function" ? (value as (input: unknown, output: unknown) => Promise<unknown>) : undefined
}

/**
 * Bridge the V1 chat transforms + compacting + tool.definition onto V2.
 * System and messages transforms share ONE session `context` hook (the host
 * runs it once per model call); compacting gets its own `compaction` hook;
 * tool.definition rides `tool.transform`. Never throws out of host callbacks.
 */
export async function bridgeTransforms(
  ctx: V2Context,
  hooks: Hooks,
  registrations: V2Registration[],
): Promise<void> {
  const v1Sys = hookFn(hooks, "experimental.chat.system.transform")
  const v1Msg = hookFn(hooks, "experimental.chat.messages.transform")

  if (v1Sys !== undefined || v1Msg !== undefined) {
    registrations.push(
      await ctx.session.hook("context", async (e) => {
        if (v1Sys !== undefined) {
          try {
            const textIndices: number[] = []
            const view: string[] = []
            e.system.forEach((part, index) => {
              if (systemTextOf(part) !== null) {
                textIndices.push(index)
                view.push(systemTextOf(part) as string)
              }
            })
            await v1Sys({ sessionID: e.sessionID, model: e.model } as never, { system: view } as never)
            view.forEach((text, viewIndex) => {
              if (viewIndex < textIndices.length) {
                const at = textIndices[viewIndex] as number
                if (systemTextOf(e.system[at]) !== text) {
                  e.system[at] = { type: "text", text } as never
                }
              } else {
                e.system.push({ type: "text", text } as never)
              }
            })
          } catch (error: unknown) {
            spikeLog("v2_bridge_system_failed", { message: error instanceof Error ? error.message : String(error) })
          }
        }
        if (v1Msg !== undefined) {
          try {
            const view = e.messages.map((message) => ({
              info: {
                sessionID: e.sessionID,
                role: (message as { role?: unknown }).role ?? "user",
              },
              parts: v2ContentToV1Parts((message as { content?: unknown }).content),
            }))
            const baseLen = view.length
            await v1Msg({} as never, { messages: view } as never)
            for (let index = baseLen; index < view.length; index++) {
              const text = v1PartsToText((view[index] as { parts?: unknown }).parts)
              if (text.length > 0) {
                e.messages.push({ role: "assistant", content: [{ type: "text", text }] } as never)
              }
            }
          } catch (error: unknown) {
            spikeLog("v2_bridge_messages_failed", { message: error instanceof Error ? error.message : String(error) })
          }
        }
      }),
    )
    spikeLog("v2_bridge_context_registered")
  } else {
    spikeLog("v2_bridge_context_absent")
  }

  const v1Compact = hookFn(hooks, "experimental.session.compacting")
  if (v1Compact !== undefined) {
    registrations.push(
      await ctx.session.hook("compaction", async (e) => {
        try {
          const outputView: { context: string[]; prompt?: string } = { context: [] }
          await v1Compact({ sessionID: e.sessionID } as never, outputView as never)
          for (const line of outputView.context) {
            if (typeof line === "string" && line.length > 0) {
              e.system.push({ type: "text", text: line } as never)
            }
          }
          if (typeof outputView.prompt === "string" && outputView.prompt.length > 0) {
            e.system.push({ type: "text", text: outputView.prompt } as never)
            spikeLog("v2_bridge_compaction_prompt_folded")
          }
        } catch (error: unknown) {
          spikeLog("v2_bridge_compaction_failed", { message: error instanceof Error ? error.message : String(error) })
        }
      }),
    )
    spikeLog("v2_bridge_compaction_registered")
  } else {
    spikeLog("v2_bridge_compaction_absent")
  }

  const v1ToolDef = hookFn(hooks, "tool.definition")
  if (v1ToolDef !== undefined) {
    await ctx.tool.transform((editor) => {
      for (const tool of editor.list()) {
        try {
          const schema = (tool as unknown as { input?: unknown }).input
          const parameters = schema !== null && typeof schema === "object" ? schema : { properties: {} }
          const outputView = { description: tool.description, parameters }
          void Promise.resolve(v1ToolDef({ toolID: tool.id } as never, outputView as never)).catch(
            (error: unknown) => {
              spikeLog("v2_bridge_tooldef_failed", {
                toolID: tool.id,
                message: error instanceof Error ? error.message : String(error),
              })
            },
          )
          if (outputView.description !== tool.description) {
            const next = outputView.description
            editor.update(tool.id, (entry) => {
              ;(entry as unknown as { description?: unknown }).description = next
            })
          }
        } catch (error: unknown) {
          spikeLog("v2_bridge_tooldef_failed", {
            toolID: tool.id,
            message: error instanceof Error ? error.message : String(error),
          })
        }
      }
    })
    spikeLog("v2_bridge_tooldef_registered")
  } else {
    spikeLog("v2_bridge_tooldef_absent")
  }
}
