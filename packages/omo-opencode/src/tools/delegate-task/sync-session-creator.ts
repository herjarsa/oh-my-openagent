import type { OpencodeClient } from "./types"
import type { DelegatedModelConfig } from "../../shared/model-resolution-types"
import { QUESTION_DENIED_SESSION_PERMISSION } from "../../shared/question-denied-session-permission"
import { log } from "../../shared/logger"

const ID_KEYS = ["id", "sessionID", "sessionId"] as const
const WRAPPER_KEYS = ["session", "info", "response", "result"] as const

function getStringId(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined
  }
  const record = value as Record<string, unknown>
  for (const key of ID_KEYS) {
    const candidate = record[key]
    if (typeof candidate === "string" && candidate.length > 0) {
      return candidate
    }
  }
  return undefined
}

function getNestedId(container: unknown): string | undefined {
  if (typeof container !== "object" || container === null) {
    return undefined
  }
  const record = container as Record<string, unknown>
  for (const key of WRAPPER_KEYS) {
    const nested = getStringId(record[key])
    if (nested !== undefined) {
      return nested
    }
  }
  return undefined
}

function extractSessionId(raw: unknown): string | undefined {
  if (typeof raw === "string") {
    return raw.length > 0 ? raw : undefined
  }
  if (typeof raw !== "object" || raw === null) {
    return undefined
  }
  const direct = getStringId(raw) ?? getNestedId(raw)
  if (direct !== undefined) {
    return direct
  }
  const data = (raw as Record<string, unknown>).data
  if (typeof data === "string") {
    return data.length > 0 ? data : undefined
  }
  const fromData = getStringId(data) ?? getNestedId(data)
  if (fromData !== undefined) {
    return fromData
  }
  if (typeof data === "object" && data !== null) {
    const dataRecord = data as Record<string, unknown>
    for (const key of WRAPPER_KEYS) {
      const deep = getNestedId(dataRecord[key])
      if (deep !== undefined) {
        return deep
      }
    }
  }
  return undefined
}

function fingerprintShape(raw: unknown): {
  keys: Array<string>
  dataType: string
  dataKeys: Array<string>
  preview: string
} {
  const top = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : undefined
  const keys = top ? Object.keys(top) : []
  const data = top?.data
  const dataType = data === null ? "null" : typeof data
  const dataKeys = typeof data === "object" && data !== null ? Object.keys(data as Record<string, unknown>) : []
  let preview: string
  try {
    preview = JSON.stringify(raw)?.slice(0, 500) ?? String(raw).slice(0, 500)
  } catch {
    preview = String(raw).slice(0, 500)
  }
  return { keys, dataType, dataKeys, preview }
}

export async function createSyncSession(
  client: OpencodeClient,
  input: {
    parentSessionID: string
    agentToUse: string
    description: string
    defaultDirectory: string
    categoryModel?: DelegatedModelConfig
  }
): Promise<{ ok: true; sessionID: string; parentDirectory: string } | { ok: false; error: string }> {
  const parentSession = await client.session.get({ path: { id: input.parentSessionID } }).catch(() => null)
  const parentDirectory = parentSession?.data?.directory ?? input.defaultDirectory

  const createResult = await client.session.create({
    body: {
      parentID: input.parentSessionID,
      title: `${input.description} (@${input.agentToUse} subagent)`,
      permission: QUESTION_DENIED_SESSION_PERMISSION,
      ...(input.categoryModel
        ? {
            model: {
              id: input.categoryModel.modelID,
              providerID: input.categoryModel.providerID,
              ...(input.categoryModel.variant ? { variant: input.categoryModel.variant } : {}),
            },
          }
        : {}),
    } as Record<string, unknown>,
    query: {
      directory: parentDirectory,
    },
  })

  if (createResult.error) {
    return { ok: false, error: `Failed to create session: ${createResult.error}` }
  }
  const extractedID = extractSessionId(createResult)
  if (typeof extractedID !== "string" || extractedID.length === 0) {
    const fingerprint = fingerprintShape(createResult)
    log("[delegate-task] session.create returned unsupported shape", fingerprint)
    return {
      ok: false,
      error: `Failed to create session: missing session ID (keys=[${fingerprint.keys.join(",")}] dataKeys=[${fingerprint.dataKeys.join(",")}] preview=${fingerprint.preview})`,
    }
  }

  return { ok: true, sessionID: extractedID, parentDirectory }
}
