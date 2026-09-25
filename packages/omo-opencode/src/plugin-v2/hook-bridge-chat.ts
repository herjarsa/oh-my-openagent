import type { ChatMessageInput, ChatMessageHandlerOutput, ChatMessagePart } from "../plugin/chat-message/types"

type V2PromptView = {
  readonly sessionID: string
  readonly text: string
  readonly agent?: unknown
  readonly model?: unknown
}

function promptTextOf(prompt: unknown): string {
  if (prompt === null || typeof prompt !== "object") return ""
  const text = (prompt as Record<string, unknown>)["text"]
  return typeof text === "string" ? text : ""
}

/**
 * Build the V1 `chat.message` input/output pair from a V2 prompt draft.
 * Pure (no host calls) — unit-tested.
 */
export function buildChatMessageView(event: {
  readonly sessionID: string
  readonly prompt: unknown
}): { input: ChatMessageInput; output: ChatMessageHandlerOutput } {
  const prompt = (event.prompt ?? {}) as Record<string, unknown>
  const agents = prompt["agents"]
  const agent = Array.isArray(agents) && typeof agents[0] === "string" ? agents[0] : undefined
  const input: ChatMessageInput = agent !== undefined
    ? { sessionID: event.sessionID, agent }
    : { sessionID: event.sessionID }
  const output: ChatMessageHandlerOutput = {
    message: {},
    parts: [{ type: "text", text: promptTextOf(event.prompt) }],
  }
  return { input, output }
}

function partsToText(parts: ChatMessagePart[]): string {
  return parts
    .map((part) => (part !== null && typeof part === "object" && typeof part.text === "string" ? part.text : ""))
    .filter((text) => text.length > 0)
    .join("\n\n")
}

/**
 * Write the (possibly mutated) V1 parts back into the V2 prompt draft.
 * Returns true when the text changed. Pure (no host calls) — unit-tested.
 */
export function applyChatMessageView(
  prompt: { text?: unknown },
  before: string,
  output: ChatMessageHandlerOutput,
): boolean {
  const after = partsToText(output.parts)
  if (after === before) return false
  prompt.text = after
  return true
}
