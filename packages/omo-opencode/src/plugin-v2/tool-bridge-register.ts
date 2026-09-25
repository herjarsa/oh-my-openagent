import * as fs from "node:fs"
import { tool as v1ToolFactory, type ToolDefinition as V1ToolDefinition } from "@opencode-ai/plugin/tool"

// SPIKE-ONLY log. Never console.* (leaks into the TUI).
const SPIKE_LOG = "C:\\Users\\herna\\AppData\\Local\\Temp\\opencode\\omo-v2-spike-log.jsonl"

function spikeLog(event: string, data: Record<string, unknown> = {}): void {
  try {
    fs.appendFileSync(SPIKE_LOG, `${JSON.stringify({ event, ...data })}\n`)
  } catch {
    // Spike observability must never break setup.
  }
}

// Same zod instance the V1 builders use (tool.schema re-exports zod v4).
const z = v1ToolFactory.schema

export type V2JsonSchema = Record<string, unknown>

export type V2ToolDefinition = {
  name: string
  description: string
  input: V2JsonSchema
  execute: (input: Record<string, unknown>, context: unknown) => Promise<unknown>
}

export type V2ToolEditorLike = {
  add: (tool: V2ToolDefinition) => void
}

export type RegisterToolsResult = {
  registered: string[]
  failed: { name: string; reason: string }[]
}

/**
 * Convert a V1 zod raw shape to JSON Schema. Primary path is zod v4's
 * `toJSONSchema` (`$schema` stripped); total fallback is `{type:"object"}`.
 * Pure — unit-tested.
 */
export function convertArgsToJsonSchema(args: unknown): V2JsonSchema {
  try {
    const schema = z.object(args as Record<string, never>)
    const converted = z.toJSONSchema(schema) as Record<string, unknown>
    delete converted["$schema"]
    return converted
  } catch {
    return { type: "object" }
  }
}

function toV2Result(v1result: unknown, toolName: string): unknown {
  if (typeof v1result === "string") {
    return { content: v1result, metadata: { tool: toolName } }
  }
  if (v1result !== null && typeof v1result === "object") {
    const rec = v1result as Record<string, unknown>
    return {
      content: typeof rec["output"] === "string" ? rec["output"] : "",
      metadata: {
        ...(rec["metadata"] !== null && typeof rec["metadata"] === "object"
          ? (rec["metadata"] as Record<string, unknown>)
          : {}),
        ...(typeof rec["title"] === "string" ? { title: rec["title"] } : {}),
        tool: toolName,
      },
    }
  }
  return { content: "", metadata: { tool: toolName } }
}

function sessionIDOf(context: unknown): string {
  if (context !== null && typeof context === "object") {
    const rec = context as Record<string, unknown>
    if (typeof rec["sessionID"] === "string") return rec["sessionID"]
    if (typeof rec["sessionId"] === "string") return rec["sessionId"]
  }
  return ""
}

/**
 * Register every V1 tool definition on the V2 tool editor.
 * Each tool is converted, adapted and added inside its own try/catch —
 * one bad tool never blocks the others. V1 execute() receives a minimal
 * context (sessionID from V2, directory/worktree from setup, abort from
 * V2 signal); `ask()` (interactive permission escalation) has no V2
 * equivalent and throws a descriptive error if a tool reaches it.
 */
export function registerV1Tools(
  editor: V2ToolEditorLike,
  tools: Record<string, V1ToolDefinition>,
  opts: { directory: string },
): RegisterToolsResult {
  const registered: string[] = []
  const failed: { name: string; reason: string }[] = []
  for (const [name, definition] of Object.entries(tools)) {
    try {
      if (definition === null || typeof definition !== "object") {
        throw new Error("not an object")
      }
      const input = convertArgsToJsonSchema((definition as { args?: unknown }).args ?? {})
      const execute = (definition as { execute?: unknown }).execute
      if (typeof execute !== "function") throw new Error("missing execute")
      const run = execute as (args: unknown, context: unknown) => Promise<unknown>
      editor.add({
        name,
        description: typeof (definition as { description?: unknown }).description === "string"
          ? ((definition as { description?: string }).description as string)
          : name,
        input,
        execute: async (input: Record<string, unknown>, context: unknown) => {
          const rec = (context !== null && typeof context === "object" ? context : {}) as Record<string, unknown>
          const v1context = {
            sessionID: sessionIDOf(context),
            messageID: typeof rec["messageID"] === "string" ? rec["messageID"] : "",
            agent: typeof rec["agent"] === "string" ? rec["agent"] : "",
            directory: opts.directory,
            worktree: opts.directory,
            abort: rec["signal"] instanceof AbortSignal ? rec["signal"] : undefined,
            metadata: () => undefined,
            ask: async () => {
              throw new Error(`tool ${name}: interactive ask() has no V2 equivalent`)
            },
          }
          try {
            const result = await run(input, v1context)
            return toV2Result(result, name)
          } catch (error: unknown) {
            // V2 execute must never throw: surface failures as error content.
            return { content: `tool ${name} failed: ${error instanceof Error ? error.message : String(error)}`, metadata: { tool: name, error: true } }
          }
        },
      })
      registered.push(name)
    } catch (error: unknown) {
      const reason = error instanceof Error ? error.message : String(error)
      failed.push({ name, reason })
      spikeLog("v2_tool_register_failed", { name, reason })
    }
  }
  spikeLog("v2_tools_registered", { count: registered.length, failed: failed.length })
  return { registered, failed }
}
