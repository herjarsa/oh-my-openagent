import { describe, expect, it } from "bun:test"
import { applyChatParamsView, buildChatHeadersView, buildChatParamsView } from "./hook-bridge-params"

describe("buildChatParamsView", () => {
  it("#given a full context #when built #then the V1 input resolves", () => {
    // when
    const view = buildChatParamsView({
      sessionID: "ses-1",
      agent: "sisyphus",
      model: { providerID: "opencode-go", id: "muse-spark-1.3-contributor" },
      options: {},
    })

    // then
    expect(view?.input).toMatchObject({
      sessionID: "ses-1",
      agent: { name: "sisyphus" },
      model: { providerID: "opencode-go", modelID: "muse-spark-1.3-contributor" },
      provider: { id: "opencode-go" },
    })
  })

  it("#given a missing agent #when built #then it returns null", () => {
    // when
    const view = buildChatParamsView({ sessionID: "ses-1", options: {} })

    // then
    expect(view).toBeNull()
  })
})

describe("applyChatParamsView", () => {
  it("#given mutated scalars #when applied #then host options update", () => {
    // given
    const options: Record<string, unknown> = {}

    // when
    const touched = applyChatParamsView(options, { temperature: 0.2, options })

    // then
    expect(options["temperature"]).toBe(0.2)
    expect(touched).toContain("temperature")
  })
})

describe("buildChatHeadersView", () => {
  it("#given a copilot model #when built #then the provider id carries over", () => {
    // when
    const view = buildChatHeadersView({ sessionID: "ses-2", model: { providerID: "github-copilot", id: "gpt-5" } })

    // then
    expect(view?.input.provider).toEqual({ id: "github-copilot" })
    expect(view?.output.headers).toEqual({})
  })
})
