/**
 * V2 → V1 event translation (pure, unit-tested).
 *
 * V2 envelope (from `@opencode/client` generated types):
 * `{ type: string, data: { sessionID: string, ... }, ... }`.
 * V1 envelope (`@opencode-ai/sdk` Event): `{ type: string, properties: {...} }`
 * with session identity resolved from `properties.sessionID`,
 * `properties.info.sessionID` or `properties.info.id`
 * (see `shared/event-session-id.ts`).
 */

export type V2EventLike = {
  readonly type: string
  readonly data?: unknown
}

export type V1EventView = {
  readonly type: string
  readonly properties: Record<string, unknown>
}

const V2_TYPE_TO_V1: Readonly<Record<string, string>> = {
  "session.created": "session.created",
  "session.deleted": "session.deleted",
  "session.idle": "session.idle",
  "session.status": "session.status",
  "session.execution.failed": "session.error",
  "session.message.content.updated": "message.updated",
}

function textPartOf(part: unknown): { type: string; text: string } | null {
  if (part === null || typeof part !== "object") return null
  const rec = part as { type?: unknown; text?: unknown; content?: unknown }
  if (typeof rec.text === "string") {
    return { type: typeof rec.type === "string" ? rec.type : "text", text: rec.text }
  }
  return null
}

/**
 * Translate one V2 server event to the V1 view the OMO event handler
 * consumes. Returns null for unmapped types (caller drops + counts).
 * Pure (no host calls) — unit-tested.
 */
export function buildV1EventView(event: V2EventLike): V1EventView | null {
  const v1type = V2_TYPE_TO_V1[event.type]
  if (v1type === undefined) return null
  const data = (event.data !== null && typeof event.data === "object"
    ? event.data
    : {}) as Record<string, unknown>
  const sessionID = typeof data["sessionID"] === "string" ? (data["sessionID"] as string) : ""
  const properties: Record<string, unknown> = { ...data, sessionID }

  if (v1type === "message.updated") {
    const content = data["content"]
    const parts = Array.isArray(content)
      ? content.map(textPartOf).filter((p) => p !== null)
      : []
    properties["info"] = { sessionID, id: data["messageID"] }
    properties["parts"] = parts
  }

  if (v1type === "session.error") {
    // V2 carries `error: SessionStructuredError`; V1 extractors
    // (`plugin/event-error-utils.ts`) probe data/error/cause/message/name
    // across nested records — pass through untouched.
    properties["error"] = data["error"]
  }

  return { type: v1type, properties }
}
