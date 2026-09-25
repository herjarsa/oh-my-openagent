import * as fs from "node:fs"
import { createBuiltinMcps } from "../mcp"

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

export type V2McpEditorLike = {
  set: (name: string, config: Record<string, unknown>) => void
}

export type RegisterMcpsResult = {
  registered: string[]
  skipped: { name: string; reason: string }[]
}

/**
 * Register the V1 builtin MCPs (remote websearch/context7/grep_app + local
 * lsp stdio) on the V2 MCP editor. Shapes translate 1:1 except the enable
 * flag (`enabled:false` → `disabled:true`); anything unrecognized is
 * skipped with a reason instead of crashing setup. Never throws.
 */
export function registerBuiltinMcps(
  editor: V2McpEditorLike,
  opts: { disabledMcps?: string[]; websearch?: { provider?: string } },
): RegisterMcpsResult {
  const registered: string[] = []
  const skipped: { name: string; reason: string }[] = []
  let built: Record<string, unknown>
  try {
    built = createBuiltinMcps(opts.disabledMcps ?? [], opts.websearch !== undefined ? { websearch: opts.websearch } as never : undefined) as Record<string, unknown>
  } catch (error: unknown) {
    spikeLog("v2_mcp_build_failed", { message: error instanceof Error ? error.message : String(error) })
    return { registered, skipped }
  }
  for (const [name, raw] of Object.entries(built)) {
    try {
      if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
        throw new Error("not a config object")
      }
      const rec = raw as Record<string, unknown>
      if (rec["type"] === "remote" && typeof rec["url"] === "string") {
        const config: Record<string, unknown> = { type: "remote", url: rec["url"] }
        if (rec["headers"] !== null && typeof rec["headers"] === "object") config["headers"] = rec["headers"]
        if (rec["enabled"] === false) config["disabled"] = true
        editor.set(name, config)
        registered.push(name)
        continue
      }
      if (rec["type"] === "local" && Array.isArray(rec["command"])) {
        const config: Record<string, unknown> = { type: "local", command: rec["command"] }
        if (rec["environment"] !== null && typeof rec["environment"] === "object") {
          config["environment"] = rec["environment"]
        }
        if (rec["enabled"] === false) config["disabled"] = true
        editor.set(name, config)
        registered.push(name)
        continue
      }
      throw new Error(`unrecognized shape type=${String(rec["type"])}`)
    } catch (error: unknown) {
      const reason = error instanceof Error ? error.message : String(error)
      skipped.push({ name, reason })
      spikeLog("v2_mcp_skipped", { name, reason })
    }
  }
  spikeLog("v2_mcp_registered", { count: registered.length, names: registered, skipped })
  return { registered, skipped }
}
