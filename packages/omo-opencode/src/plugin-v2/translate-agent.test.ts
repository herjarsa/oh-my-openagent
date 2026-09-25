import { describe, expect, it } from "bun:test"
import { translateAgentConfigToV2Draft, translateAgentToV2Draft } from "./translate-agent"

describe("translateAgentToV2Draft", () => {
  it("#given a string models chain #when translated #then the first entry splits provider and model", () => {
    // given
    const override = { models: ["opencode-go/muse-spark-1.3-contributor", "opencode/muse-spark-1.2-contributor-free"] }

    // when
    const draft = translateAgentToV2Draft("sisyphus", override)

    // then
    expect(draft).toMatchObject({
      id: "sisyphus",
      mode: "all",
      model: { providerID: "opencode-go", id: "muse-spark-1.3-contributor" },
    })
  })

  it("#given a singular model #when translated #then it wins over the chain", () => {
    // given
    const override = { model: "opencode-go/kimi-k3", models: ["opencode-go/muse-spark-1.3-contributor"] }

    // when
    const draft = translateAgentToV2Draft("sisyphus", override)

    // then
    expect(draft?.model).toEqual({ providerID: "opencode-go", id: "kimi-k3" })
  })

  it("#given an object model entry #when translated #then the entry model resolves", () => {
    // given
    const override = { models: [{ model: "opencode-go/glm-5.2", reasoning: "high" }] }

    // when
    const draft = translateAgentToV2Draft("oracle", override)

    // then
    expect(draft?.model).toEqual({ providerID: "opencode-go", id: "glm-5.2" })
  })

  it("#given a disabled agent #when translated #then registration is skipped", () => {
    // when
    const draft = translateAgentToV2Draft("momus", { disable: true })

    // then
    expect(draft).toBeNull()
  })
})

describe("translateAgentConfigToV2Draft", () => {
  it("#given a full AgentConfig #when translated #then system permissions and steps map over", () => {
    // when
    const draft = translateAgentConfigToV2Draft("librarian", {
      description: "Docs",
      mode: "subagent",
      model: "opencode-go/kimi-k3",
      color: "#ff6b6b",
      maxSteps: 8,
      prompt: "Write docs.",
      tools: { write: false, edit: false, task: false },
      permission: { bash: { rm: "deny", git: "allow" } },
    })

    // then
    expect(draft).toMatchObject({
      id: "librarian",
      mode: "subagent",
      model: { providerID: "opencode-go", id: "kimi-k3" },
      system: "Write docs.",
      steps: 8,
    })
    expect(draft?.permissions).toContainEqual({ action: "edit", resource: "*", effect: "deny" })
    expect(draft?.permissions).toContainEqual({ action: "task", resource: "*", effect: "deny" })
    expect(draft?.permissions).toContainEqual({ action: "bash", resource: "rm", effect: "deny" })
    expect(draft?.permissions).not.toContainEqual({ action: "bash", resource: "git", effect: "allow" })
  })

  it("#given an invalid mode #when translated #then it defaults to all", () => {
    // when
    const draft = translateAgentConfigToV2Draft("x", { mode: "sometimes" })

    // then
    expect(draft?.mode).toBe("all")
  })
})
