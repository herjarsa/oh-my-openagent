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
  active?: (input?: unknown) => Promise<unknown>
  interrupt?: (input: unknown) => Promise<unknown>
  switchAgent?: (input: unknown) => Promise<unknown>
  switchModel?: (input: unknown) => Promise<unknown>
}

type V2EventDomain = {
  subscribe?: (input?: unknown) => AsyncIterable<unknown>
}

type StatusEntry = {
  type: string
  [key: string]: unknown
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

function v2Event(ctx: V2Plugin.Context): V2EventDomain {
  const event = (ctx as unknown as { event?: unknown }).event
  return (event !== null && typeof event === "object" ? event : {}) as V2EventDomain
}

function agentOf(input: unknown): string | undefined {
  const body = asRecord(asRecord(input)?.["body"])
  if (body === null) return undefined
  return stringField(body, "agent")
}

function modelOf(input: unknown): { id: string; providerID: string; variant?: string } | undefined {
  const body = asRecord(asRecord(input)?.["body"])
  if (body === null) return undefined
  const model = asRecord(body["model"])
  if (model === null) return undefined
  // V1 model shape is {providerID, modelID}; V2 Model.Ref is {id, providerID}.
  const providerID = stringField(model, "providerID")
  const id = stringField(model, "modelID") ?? stringField(model, "id")
  if (providerID === undefined || id === undefined) return undefined
  const variant = stringField(model, "variant")
  return variant === undefined ? { id, providerID } : { id, providerID, variant }
}

/**
 * Fold one V2 event into the status table. Only V2-confirmed states land here:
 * the authoritative `session.status` event ({sessionID, status: SessionStatus}),
 * `session.idle`, and the execution lifecycle edges. Unknown sessions stay absent
 * so V1 pollers fall back to message inspection instead of reading a fake idle.
 */
function applyStatusEvent(table: Map<string, StatusEntry>, event: unknown): void {
  const rec = asRecord(event)
  if (rec === null) return
  const type = stringField(rec, "type")
  const data = asRecord(rec["data"])
  if (type === undefined || data === null) return
  const sessionID = stringField(data, "sessionID")
  if (sessionID === undefined) return
  if (type === "session.status") {
    const status = asRecord(data["status"])
    const statusType = status !== null ? stringField(status, "type") : undefined
    if (statusType !== undefined) table.set(sessionID, { ...status as Record<string, unknown>, type: statusType })
    return
  }
  if (type === "session.idle") {
    table.set(sessionID, { type: "idle" })
    return
  }
  if (type === "session.execution.started") {
    table.set(sessionID, { type: "busy" })
    return
  }
  if (
    type === "session.execution.succeeded"
    || type === "session.execution.failed"
    || type === "session.execution.interrupted"
  ) {
    table.set(sessionID, { type: "idle" })
    return
  }
  if (type === "session.deleted") {
    table.delete(sessionID)
  }
}

function startStatusTracking(eventDomain: V2EventDomain, table: Map<string, StatusEntry>): void {
  if (typeof eventDomain.subscribe !== "function") {
    spikeLog("v1_client_status_events_unavailable")
    return
  }
  const subscribe = eventDomain.subscribe.bind(eventDomain)
  void (async () => {
    try {
      for await (const event of subscribe()) {
        applyStatusEvent(table, event)
      }
      spikeLog("v1_client_status_events_ended", { reason: "stream-closed" })
    } catch (error: unknown) {
      spikeLog("v1_client_status_events_ended", {
        reason: "error",
        message: error instanceof Error ? error.message : String(error),
      })
    }
  })()
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
  // V2 SessionMessageInfo carries the kind in `type` ("user" | "assistant" |
  // "synthetic" | ...), user text in `text`, assistant parts in `content[]`,
  // and terminal state in top-level `finish` / `error`. V1 callers need
  // {info: {role, finish, error}, parts}. An explicit V1 `role` (tests,
  // legacy callers) still wins over the V2 `type` mapping.
  const rawType = typeof rec["type"] === "string" ? (rec["type"] as string) : undefined
  const role = typeof rec["role"] === "string"
    ? (rec["role"] as string)
    : rawType === "assistant" ? "assistant" : "user"
  const content = rec["content"]
  const parts = Array.isArray(content)
    ? content.map(textPartOf).filter((p) => p !== null)
    : typeof rec["text"] === "string" && (rec["text"] as string).length > 0
      ? [{ type: "text", text: rec["text"] as string }]
      : []
  const info: Record<string, unknown> = {
    sessionID,
    id: rec["id"],
    role,
    ...(typeof rec["finish"] === "string" ? { finish: rec["finish"] } : {}),
    ...(rec["error"] !== undefined && rec["error"] !== null ? { error: rec["error"] } : {}),
    ...(typeof rec["info"] === "object" && rec["info"] !== null ? (rec["info"] as Record<string, unknown>) : {}),
  }
  return { info, parts }
}

/**
 * V1 SDK client adapter over the V2 setup context.
 * Delegated (real V2 calls): session.get/messages/prompt/promptAsync/create/
 * status (session.status/idle/execution events plus an active() merge when the
 * host exposes one)/abort (via interrupt). Prompt carries V2 SessionPromptInput
 * shape ({sessionID, text: {text}}) with agent/model applied via switch calls.
 * Degraded (no V2 equivalent, empty envelope + warn): session.todo/children.
 * TUI toasts are no-ops (V2 promise ctx has no TUI surface).
 * Never throws out of delegated methods — failures resolve to empty
 * envelopes so V1 hooks degrade instead of crashing the host call.
 */
export function createV1ClientAdapter(ctx: V2Plugin.Context): unknown {
  const session = v2Session(ctx)
  const statusTable = new Map<string, StatusEntry>()
  startStatusTracking(v2Event(ctx), statusTable)

  const promptLike = (v1input: unknown) => {
    const sessionID = sessionIDOf(v1input)
    const text = textOf(v1input)
    const promptFn = session.prompt
    if (typeof promptFn !== "function" || sessionID.length === 0) {
      log("[v1-client] session.prompt delegated", {
        sessionID: sessionID.length > 0 ? sessionID : "unknown",
        ok: false,
        error: "prompt unavailable or missing sessionID",
      })
      spikeLog("v1_client_prompt_skipped", { sessionID: sessionID.length > 0 })
      return Promise.resolve(null)
    }
    if (text.length === 0) {
      log("[v1-client] session.prompt delegated", { sessionID, ok: false, error: "empty prompt text" })
      spikeLog("v1_client_prompt_empty", { sessionID })
      return Promise.resolve(null)
    }
    return (async () => {
      try {
        // V1 carries agent/model per prompt (body.agent, body.model); V2 keeps
        // them on the session, so switch first. A failed switch returns null
        // loudly instead of running the prompt under the wrong agent/model.
        const agent = agentOf(v1input)
        if (agent !== undefined && typeof session.switchAgent === "function") {
          await session.switchAgent({ sessionID, agent })
        }
        const model = modelOf(v1input)
        if (model !== undefined && typeof session.switchModel === "function") {
          await session.switchModel({ sessionID, model })
        }
        // V2 SessionPromptInput.text is an object ({text, ...}), never a flat
        // string: sending the string form is rejected by the host and the
        // prompt silently never runs.
        const res = await promptFn({ sessionID, text: { text } })
        const id = extractMessageId(res)
        log("[v1-client] session.prompt delegated", { sessionID, ok: true, messageID: id ?? "unknown" })
        spikeLog("v1_client_prompt_ok", { sessionID })
        return id ? { data: { info: { id } } } : null
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error)
        log("[v1-client] session.prompt delegated", { sessionID, ok: false, error: message })
        spikeLog("v1_client_prompt_failed", { message })
        return null
      }
    })()
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
        // V1 Session carries a top-level `directory`; V2 SessionInfo carries
        // `location.directory`. Surface both so V1 callers keep working.
        const record = asRecord(res)
        if (record !== null) {
          const location = asRecord(record["location"])
          const directory = (location !== null ? stringField(location, "directory") : undefined)
          if (directory !== undefined && stringField(record, "directory") === undefined) {
            return { data: { ...record, directory } }
          }
        }
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
      status: async () => {
        // V1 status() resolves the full {[sessionID]: {type}} table. V2 has no
        // status endpoint on the plugin context: the table is rebuilt from two
        // honest sources. (1) The `session.status` / `session.idle` /
        // execution-lifecycle event stream, tracked since adapter creation.
        // (2) A live active() pull when the host exposes one. Event entries
        // overlay the pull (transitions are the freshest signal). Sessions with
        // no confirmed state stay absent so V1 pollers fall back to message
        // inspection instead of reading a fake idle.
        const out: Record<string, StatusEntry> = {}
        if (typeof session.active === "function") {
          try {
            const res = await session.active()
            const record = asRecord(res) ?? {}
            // Tolerate a {data: {...}} envelope defensively.
            const table = asRecord(record["data"]) ?? record
            for (const [id, value] of Object.entries(table)) {
              const entry = asRecord(value)
              const type = entry !== null ? stringField(entry, "type") : undefined
              if (type !== undefined) out[id] = { type }
            }
          } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error)
            spikeLog("v1_client_status_failed", { message })
          }
        }
        for (const [id, entry] of statusTable) out[id] = { ...entry }
        return { data: out }
      },
      abort: async (v1input: unknown) => {
        if (typeof session.interrupt !== "function") {
          spikeLog("v1_client_abort_unavailable")
          return { data: undefined, error: "session.interrupt unavailable on V2 host" }
        }
        try {
          await session.interrupt({ sessionID: sessionIDOf(v1input) })
          return { data: true }
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : String(error)
          spikeLog("v1_client_abort_failed", { message })
          return { data: undefined, error: message }
        }
      },
      children: degradedList("children"),
      create: async (v1input: unknown) => {
        if (typeof session.create !== "function") {
          spikeLog("v1_client_create_unavailable")
          return { data: undefined, error: "session.create unavailable on V2 host" }
        }
        const outer = asRecord(v1input) ?? {}
        const body = asRecord(outer["body"]) ?? {}
        const query = asRecord(outer["query"]) ?? {}
        // V1 SDK shape: {body: {parentID?, title?, agent?, permission?, model?}, query: {directory?}}.
        // V2 SessionCreateInput is flat: {title?, agent?, model?, location?, metadata?, permissions?}.
        // V1 permission ({permission, action, pattern}) is NOT V2 PermissionRule
        // ({action, resource, effect}) — never forward it, a schema mismatch
        // would fail the create. parentID has no V2 field; keep it in metadata.
        const v2input: Record<string, unknown> = {}
        const title = stringField(body, "title")
        if (title !== undefined) v2input["title"] = title
        const agent = stringField(body, "agent")
        if (agent !== undefined) v2input["agent"] = agent
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
