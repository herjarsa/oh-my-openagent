import * as fs from "node:fs"
import type { Plugin as V2Plugin } from "@opencode/plugin"
import { log } from "../shared"

// SPIKE-ONLY log. Never console.* (leaks into the TUI).
import { portLogPath } from "./log"

const SPIKE_LOG = portLogPath()

function spikeLog(event: string, data: Record<string, unknown> = {}): void {
  try {
    fs.appendFileSync(SPIKE_LOG, `${JSON.stringify({ event, ...data })}\n`)
  } catch {
    // Spike observability must never break the adapter.
  }
}

const degradedCounts = new Map<string, number>()

function degradedLog(method: string): void {
  const count = (degradedCounts.get(method) ?? 0) + 1
  degradedCounts.set(method, count)
  // Hot paths (status polling) would flood the log — first + every 50th.
  if (count === 1 || count % 50 === 0) {
    spikeLog("v1_client_degraded", { method, count })
  }
}

type V2Session = {
  get?: (input: unknown) => Promise<unknown>
  context?: (input: unknown) => Promise<unknown>
  prompt?: (input: unknown) => Promise<unknown>
  create?: (input: unknown) => Promise<unknown>
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : null
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const candidate = record[key]
  return typeof candidate === "string" && candidate.length > 0 ? candidate : undefined
}

/**
 * Unwrap a V2 session.create result into {id, directory}.
 * V2 resolves SessionInfo directly ({id, location: {directory}}), but
 * tolerate envelope wrappers ({data, session, info}) defensively.
 */
function unwrapSessionInfo(value: unknown): { id: string; directory: string; raw: Record<string, unknown> } | null {
  const candidates: unknown[] = [value]
  const top = asRecord(value)
  if (top !== null) {
    for (const key of ["data", "session", "info"]) candidates.push(top[key])
  }
  for (const candidate of candidates) {
    const record = asRecord(candidate)
    if (record === null) continue
    const id = stringField(record, "id")
    if (id === undefined) continue
    const location = asRecord(record["location"])
    const directory = (location !== null ? stringField(location, "directory") : undefined) ?? stringField(record, "directory") ?? ""
    return { id, directory, raw: record }
  }
  return null
}

function shapeFingerprint(value: unknown): { keys: Array<string>; preview: string } {
  const top = asRecord(value)
  let preview: string
  try {
    preview = JSON.stringify(value)?.slice(0, 200) ?? String(value).slice(0, 200)
  } catch {
    preview = String(value).slice(0, 200)
  }
  return { keys: top ? Object.keys(top) : [], preview }
}

function v2Session(ctx: V2Plugin.Context): V2Session {
  const session = (ctx as unknown as { session?: unknown }).session
  return (session !== null && typeof session === "object" ? session : {}) as V2Session
}

function sessionIDOf(input: unknown, fallback = ""): string {
  if (input !== null && typeof input === "object") {
    const rec = input as Record<string, unknown>
    if (typeof rec["sessionID"] === "string") return rec["sessionID"]
    const path = rec["path"]
    if (path !== null && typeof path === "object" && typeof (path as Record<string, unknown>)["id"] === "string") {
      return (path as Record<string, unknown>)["id"] as string
    }
    if (typeof path === "string") return path
  }
  return fallback
}

function textOf(input: unknown): string {
  if (input === null || typeof input !== "object") return typeof input === "string" ? input : ""
  const rec = input as Record<string, unknown>
  if (typeof rec["text"] === "string") return rec["text"]
  const body = rec["body"]
  if (typeof body === "string") return body
  if (body !== null && typeof body === "object") {
    const parts = (body as Record<string, unknown>)["parts"]
    if (Array.isArray(parts)) {
      return parts
        .map((p) => {
          if (p !== null && typeof p === "object" && typeof (p as Record<string, unknown>)["text"] === "string") {
            return (p as Record<string, unknown>)["text"] as string
          }
          return ""
        })
        .filter((t) => t.length > 0)
        .join("\n\n")
    }
    if (typeof (body as Record<string, unknown>)["text"] === "string") {
      return (body as Record<string, unknown>)["text"] as string
    }
  }
  return ""
}

function extractMessageId(value: unknown): string | null {
  if (value === null || typeof value !== "object") return null
  const rec = value as Record<string, unknown>
  if (typeof rec["id"] === "string") return rec["id"]
  const data = rec["data"]
  if (data !== null && typeof data === "object") {
    const info = (data as Record<string, unknown>)["info"]
    if (info !== null && typeof info === "object" && typeof (info as Record<string, unknown>)["id"] === "string") {
      return (info as Record<string, unknown>)["id"] as string
    }
  }
  return null
}

function textPartOf(part: unknown): { type: string; text: string } | null {
  if (part === null || typeof part !== "object") return null
  const rec = part as { type?: unknown; text?: unknown }
  if (typeof rec.text !== "string") return null
  return { type: typeof rec.type === "string" ? rec.type : "text", text: rec.text }
}

function messageToView(message: unknown, sessionID: string): { info: unknown; parts: unknown[] } {
  if (message === null || typeof message !== "object") return { info: { sessionID }, parts: [] }
  const rec = message as Record<string, unknown>
  const content = rec["content"]
  const parts = Array.isArray(content)
    ? content.map(textPartOf).filter((p) => p !== null)
    : []
  return {
    info: { sessionID, id: rec["id"], role: rec["role"] ?? "user", ...(typeof rec["info"] === "object" ? rec["info"] as Record<string, unknown> : {}) },
    parts,
  }
}

/**
 * V1 SDK client adapter over the V2 setup context.
 * Delegated (real V2 calls): session.get/messages/prompt/promptAsync/create.
 * Degraded (no V2 equivalent, empty envelope + warn): session.todo/status/
 * children. TUI toasts are no-ops (V2 promise ctx has no TUI surface).
 * Never throws out of delegated methods — failures resolve to empty
 * envelopes so V1 hooks degrade instead of crashing the host call.
 */
export function createV1ClientAdapter(ctx: V2Plugin.Context): unknown {
  const session = v2Session(ctx)

  const promptLike = (v1input: unknown) => {
    const sessionID = sessionIDOf(v1input)
    const text = textOf(v1input)
    if (typeof session.prompt !== "function" || sessionID.length === 0) {
      spikeLog("v1_client_prompt_skipped", { sessionID: sessionID.length > 0 })
      return Promise.resolve(null)
    }
    return session.prompt({ sessionID, text }).then(
      (res) => {
        const id = extractMessageId(res)
        return id ? { data: { info: { id } } } : null
      },
      (error: unknown) => {
        spikeLog("v1_client_prompt_failed", { message: error instanceof Error ? error.message : String(error) })
        return null
      },
    )
  }

  const degradedList = (name: string) => {
    return async () => {
      degradedLog(name)
      return { data: [] }
    }
  }

  return {
    session: {
      get: async (v1input: unknown) => {
        if (typeof session.get !== "function") return { data: null }
        const res = await session.get({ sessionID: sessionIDOf(v1input) })
        return { data: res }
      },
      messages: async (v1input: unknown) => {
        if (typeof session.context !== "function") return { data: [] }
        const sessionID = sessionIDOf(v1input)
        const res = await session.context({ sessionID })
        const list = Array.isArray(res) ? res : []
        return { data: list.map((m) => messageToView(m, sessionID)) }
      },
      prompt: promptLike,
      promptAsync: promptLike,
      todo: degradedList("todo"),
      status: degradedList("status"),
      children: degradedList("children"),
      create: async (v1input: unknown) => {
        if (typeof session.create !== "function") {
          spikeLog("v1_client_create_unavailable")
          return { data: undefined, error: "session.create unavailable on V2 host" }
        }
        const outer = asRecord(v1input) ?? {}
        const body = asRecord(outer["body"]) ?? {}
        const query = asRecord(outer["query"]) ?? {}
        // V1 SDK shape: {body: {parentID?, title?, permission?, model?}, query: {directory?}}.
        // V2 SessionCreateInput is flat: {title?, agent?, model?, location?, metadata?, permissions?}.
        // V1 permission ({permission, action, pattern}) is NOT V2 PermissionRule
        // ({action, resource, effect}) — never forward it, a schema mismatch
        // would fail the create. parentID has no V2 field; keep it in metadata.
        const v2input: Record<string, unknown> = {}
        const title = stringField(body, "title")
        if (title !== undefined) v2input["title"] = title
        if (asRecord(body["model"]) !== null) v2input["model"] = body["model"]
        const directory = stringField(query, "directory")
        if (directory !== undefined) v2input["location"] = { directory }
        const parentID = stringField(body, "parentID")
        if (parentID !== undefined) v2input["metadata"] = { parentID }
        try {
          const res = await session.create(v2input)
          const info = unwrapSessionInfo(res)
          if (info === null) {
            log("[v1-client] session.create delegated", { ok: false, ...shapeFingerprint(res) })
            spikeLog("v1_client_create_shape", shapeFingerprint(res))
            return { data: undefined, error: "session.create returned unsupported shape" }
          }
          log("[v1-client] session.create delegated", { ok: true, id: info.id })
          return { data: { ...info.raw, id: info.id, directory: info.directory.length > 0 ? info.directory : (directory ?? "") } }
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : String(error)
          log("[v1-client] session.create delegated", { ok: false, error: message })
          spikeLog("v1_client_create_failed", { message })
          return { data: undefined, error: message }
        }
      },
    },
    tui: {
      showToast: async () => {
        degradedLog("toast")
        return undefined
      },
    },
  }
}
