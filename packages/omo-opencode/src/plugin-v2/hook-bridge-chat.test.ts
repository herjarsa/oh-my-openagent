import { describe, expect, it } from "bun:test"
import { applyChatMessageView, buildChatMessageView } from "./hook-bridge-chat"

describe("buildChatMessageView", () => {
  it("#given a V2 prompt draft #when built #then session and agent map over", () => {
    // when
    const { input, output } = buildChatMessageView({
      sessionID: "ses-1",
      prompt: { text: "hello", agents: ["sisyphus"] },
    })

    // then
    expect(input).toEqual({ sessionID: "ses-1", agent: "sisyphus" })
    expect(output.parts).toEqual([{ type: "text", text: "hello" }])
  })
})

describe("applyChatMessageView", () => {
  it("#given unchanged parts #when applied #then it reports no change", () => {
    // given
    const prompt: { text?: unknown } = { text: "hi" }

    // when
    const changed = applyChatMessageView(prompt, "hi", { message: {}, parts: [{ type: "text", text: "hi" }] })

    // then
    expect(changed).toBe(false)
    expect(prompt.text).toBe("hi")
  })

  it("#given mutated parts #when applied #then the draft text updates", () => {
    // given
    const prompt: { text?: unknown } = { text: "hi" }

    // when
    const changed = applyChatMessageView(prompt, "hi", {
      message: {},
      parts: [{ type: "text", text: "hi" }, { type: "text", text: "[ultrawork]" }],
    })

    // then
    expect(changed).toBe(true)
    expect(prompt.text).toBe("hi\n\n[ultrawork]")
  })
})
