/**
 * V2 → V1 views for the `chat.params` / `chat.headers` handlers.
 * Pure view builders (unit-tested); the caller owns host registration.
 */

export type V2ModelRef = {
  readonly providerID?: unknown
  readonly id?: unknown
  readonly modelID?: unknown
  readonly variant?: unknown
}

export type V2ContextView = {
  readonly sessionID: string
  readonly agent?: unknown
  readonly model?: V2ModelRef
  readonly options: Record<string, unknown>
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined
}

export type ChatParamsView = {
  input: {
    sessionID: string
    agent: { name?: string }
    model: { providerID: string; modelID: string }
    provider: { id: string }
    message: { variant?: string }
    rawMessage: { variant?: string }
  }
  output: {
    temperature?: number
    topP?: number
    topK?: number
    maxOutputTokens?: number
    options: Record<string, unknown>
  }
}

/**
 * Build the V1 `chat.params` input/output pair over the live V2 options
 * object. Scalar writes land on the view; `applyChatParamsView` copies them
 * back (V1 handlers both assign and `delete` these keys).
 */
export function buildChatParamsView(event: V2ContextView): ChatParamsView | null {
  const providerID = stringOrUndefined(event.model?.providerID)
  const modelID = stringOrUndefined(event.model?.modelID) ?? stringOrUndefined(event.model?.id)
  const agentName = typeof event.agent === "string" ? event.agent : undefined
  if (providerID === undefined || modelID === undefined || agentName === undefined) return null
  const rawMessage: { variant?: string } = {}
  return {
    input: {
      sessionID: event.sessionID,
      agent: { name: agentName },
      model: { providerID, modelID },
      provider: { id: providerID },
      message: rawMessage,
      rawMessage,
    },
    output: {
      temperature: typeof event.options["temperature"] === "number"
        ? (event.options["temperature"] as number)
        : undefined,
      topP: typeof event.options["topP"] === "number" ? (event.options["topP"] as number) : undefined,
      topK: typeof event.options["topK"] === "number" ? (event.options["topK"] as number) : undefined,
      maxOutputTokens: typeof event.options["maxTokens"] === "number"
        ? (event.options["maxTokens"] as number)
        : undefined,
      options: event.options,
    },
  }
}

const SCALAR_BACK: ReadonlyArray<readonly [viewKey: "temperature" | "topP" | "topK" | "maxOutputTokens", hostKey: string]> = [
  ["temperature", "temperature"],
  ["topP", "topP"],
  ["topK", "topK"],
  ["maxOutputTokens", "maxTokens"],
]

/**
 * Copy the (possibly mutated) V1 output back into V2 options.
 * Returns the list of host keys touched. Pure — unit-tested.
 */
export function applyChatParamsView(
  options: Record<string, unknown>,
  output: ChatParamsView["output"],
): string[] {
  const touched: string[] = []
  for (const [viewKey, hostKey] of SCALAR_BACK) {
    const value = output[viewKey]
    if (value !== undefined) {
      options[hostKey] = value
    } else {
      delete options[hostKey]
    }
    touched.push(hostKey)
  }
  return touched
}

export type ChatHeadersView = {
  input: { sessionID: string; provider: { id: string }; message: { id?: string; role?: string } }
  output: { headers: Record<string, string> }
}

/**
 * Build the V1 `chat.headers` pair. The V2 model.request stage has no
 * message identity, so message stays an empty record (the handler tolerates
 * missing id/role; the Copilot gate only needs the provider id).
 */
export function buildChatHeadersView(event: { sessionID: string; model?: V2ModelRef }): ChatHeadersView | null {
  const providerID = stringOrUndefined(event.model?.providerID)
  if (providerID === undefined) return null
  return {
    input: { sessionID: event.sessionID, provider: { id: providerID }, message: {} },
    output: { headers: {} },
  }
}
