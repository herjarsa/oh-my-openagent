import type { AgentOverrideConfig } from "../config/schema/agent-overrides"

/**
 * Minimal V2 agent draft (promise flavour). Field names follow the official
 * V2 agents reference. Deliberately narrow for the Phase 1 spike — prompt
 * builders, skills, tools→permissions and reasoning→variant mapping land in
 * Phase 4.
 */
export type V2AgentDraft = {
  description?: string
  mode?: "primary" | "subagent" | "all"
  // NOTE: the agents reference page shows an expanded `{providerID, model}`
  // form, but the live 2.0.16 server rejects it — `debug agents` fails with
  // `Missing key at ["data"][N]["model"]["id"]`. The editor path requires
  // `Model.Ref` shape: `{providerID, id, variant?}`. Proven by spike 2026-09-25.
  model?: { providerID: string; id: string; variant?: string }
  color?: string
}

type ModelEntry = string | { model?: unknown; reasoning?: unknown; variant?: unknown }

function splitModelRef(ref: string): { providerID: string; id: string } | undefined {
  const slash = ref.indexOf("/")
  if (slash <= 0 || slash === ref.length - 1) return undefined
  return { providerID: ref.slice(0, slash), id: ref.slice(slash + 1) }
}

function firstModelRef(override: AgentOverrideConfig): string | undefined {
  if (typeof override.model === "string" && override.model.length > 0) return override.model
  const models = override.models as ModelEntry[] | undefined
  if (Array.isArray(models)) {
    for (const entry of models) {
      if (typeof entry === "string" && entry.length > 0) return entry
      if (entry !== null && typeof entry === "object" && typeof entry.model === "string" && entry.model.length > 0) {
        return entry.model
      }
    }
  }
  return undefined
}

/**
 * Translate one V1 agent override to a V2 agent draft.
 * Returns null when the agent is disabled (caller skips registration).
 */
export function translateAgentToV2Draft(id: string, override: AgentOverrideConfig): (V2AgentDraft & { id: string }) | null {
  void id
  if (override.disable === true) return null
  const draft: V2AgentDraft & { id: string } = { id }
  if (typeof override.description === "string") draft.description = override.description
  draft.mode = override.mode ?? "all"
  const ref = firstModelRef(override)
  if (ref !== undefined) {
    const split = splitModelRef(ref)
    if (split !== undefined) draft.model = split
  }
  if (typeof override.color === "string") draft.color = override.color
  return draft
}
