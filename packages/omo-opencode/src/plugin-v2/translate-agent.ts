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

export type V1AgentConfigLike = {
  model?: unknown
  description?: unknown
  mode?: unknown
  color?: unknown
  maxSteps?: unknown
  prompt?: unknown
  disable?: unknown
  tools?: unknown
  permission?: unknown
}

export type V2PermissionRule = {
  action: string
  resource: string
  effect: "allow" | "ask" | "deny"
}

export type V2AgentFullDraft = {
  description?: string
  mode?: "primary" | "subagent" | "all"
  model?: { providerID: string; id: string; variant?: string }
  color?: string
  steps?: number
  system?: string
  permissions?: V2PermissionRule[]
}

// V1 tool names → V2 permission actions (best-effort; unknown tools map to
// a same-named action and are left to the host to interpret).
const TOOL_TO_ACTION: Readonly<Record<string, string>> = {
  write: "edit",
  edit: "edit",
  apply_patch: "edit",
  read: "read",
  glob: "glob",
  grep: "grep",
  bash: "shell",
  task: "task",
  skill: "skill",
  call_omo_agent: "subagent",
  todowrite: "todowrite",
  todoread: "todoread",
}

function isValidMode(value: unknown): value is "primary" | "subagent" | "all" {
  return value === "primary" || value === "subagent" || value === "all"
}

function isValidEffect(value: unknown): value is "allow" | "ask" | "deny" {
  return value === "allow" || value === "ask" || value === "deny"
}

/**
 * Translate a fully-resolved V1 AgentConfig (as produced by
 * `createBuiltinAgents`) to a V2 agent draft. Only deny rules are emitted
 * (the host default is allow); temperature/top_p have no V2 agent-level
 * equivalent and are dropped. Returns null when disabled.
 */
export function translateAgentConfigToV2Draft(
  id: string,
  config: V1AgentConfigLike,
): (V2AgentFullDraft & { id: string }) | null {
  if (config.disable === true) return null
  const draft: V2AgentFullDraft & { id: string } = { id }
  if (typeof config.description === "string") draft.description = config.description
  draft.mode = isValidMode(config.mode) ? config.mode : "all"
  if (typeof config.model === "string") {
    const split = splitModelRef(config.model)
    if (split !== undefined) draft.model = split
  }
  if (typeof config.color === "string") draft.color = config.color
  if (typeof config.maxSteps === "number" && Number.isInteger(config.maxSteps) && config.maxSteps > 0) {
    draft.steps = config.maxSteps
  }
  if (typeof config.prompt === "string" && config.prompt.length > 0) draft.system = config.prompt

  const permissions: V2PermissionRule[] = []
  if (config.tools !== null && typeof config.tools === "object" && !Array.isArray(config.tools)) {
    for (const [toolName, enabled] of Object.entries(config.tools)) {
      if (enabled === false) {
        permissions.push({ action: TOOL_TO_ACTION[toolName] ?? toolName, resource: "*", effect: "deny" })
      }
    }
  }
  if (config.permission !== null && typeof config.permission === "object" && !Array.isArray(config.permission)) {
    for (const [action, effect] of Object.entries(config.permission)) {
      if (isValidEffect(effect)) {
        if (effect !== "allow") permissions.push({ action, resource: "*", effect })
        continue
      }
      // Per-command maps (V1 `bash: { git: "allow", rm: "deny" }`) expand to
      // V2 shell rules with raw command-text resources.
      if (effect !== null && typeof effect === "object" && !Array.isArray(effect)) {
        for (const [resource, resourceEffect] of Object.entries(effect)) {
          if (isValidEffect(resourceEffect) && resourceEffect !== "allow") {
            permissions.push({ action, resource, effect: resourceEffect })
          }
        }
      }
    }
  }
  if (permissions.length > 0) draft.permissions = permissions
  return draft
}
