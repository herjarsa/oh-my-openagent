import { describe, expect, test } from "bun:test"

import {
  buildChildResumeNudge,
  buildGoalSupervisedPrompt,
  CHILD_DONE_KEYWORD,
  hasGoalKeywordInLatest,
  isStallPollError,
  MAX_CHILD_GOAL_RESUMES,
  shouldAutoResumeChild,
  STALL_ERROR_PREFIX,
  stripGoalKeyword,
} from "./child-goal"

describe("child-goal", () => {
  test("keyword is a bracketed marker unlikely in normal prose", () => {
    // given/when/then
    expect(CHILD_DONE_KEYWORD).toBe("[TASK_DONE]")
    expect(STALL_ERROR_PREFIX).toBe("Task stalled:")
    expect(MAX_CHILD_GOAL_RESUMES).toBe(2)
  })

  test("supervised prompt keeps the task text and appends the goal contract", () => {
    // given
    const prompt = "do the thing"

    // when
    const supervised = buildGoalSupervisedPrompt(prompt, "explore")

    // then
    expect(supervised.startsWith(prompt)).toBe(true)
    expect(supervised).toContain(CHILD_DONE_KEYWORD)
  })

  test("detects the keyword in the newest assistant turn", () => {
    // given
    const messages = [
      { info: { id: "m1", role: "user" }, parts: [] },
      { info: { id: "m2", role: "assistant" }, parts: [{ type: "text", text: `answer\n${CHILD_DONE_KEYWORD}` }] },
    ]

    // when/then
    expect(hasGoalKeywordInLatest(messages as never)).toBe(true)
  })

  test("ignores a keyword that predates the anchor", () => {
    // given: keyword turn, then a fresh user turn that becomes the anchor
    const messages = [
      { info: { id: "m1", role: "user" }, parts: [] },
      { info: { id: "m2", role: "assistant" }, parts: [{ type: "text", text: CHILD_DONE_KEYWORD }] },
      { info: { id: "m3", role: "user" }, parts: [{ type: "text", text: "keep going" }] },
    ]

    // when/then: scoped after the anchor, no keyword present
    expect(hasGoalKeywordInLatest(messages as never, "m3")).toBe(false)
    expect(hasGoalKeywordInLatest(messages as never, undefined, 3)).toBe(false)
  })

  test("returns false with no assistant text", () => {
    // given
    const messages = [{ info: { id: "m1", role: "user" }, parts: [] }]

    // when/then
    expect(hasGoalKeywordInLatest(messages as never)).toBe(false)
  })

  test("strips keyword lines from delivered text", () => {
    // given
    const text = `the answer\n${CHILD_DONE_KEYWORD}\n`

    // when
    const stripped = stripGoalKeyword(text)

    // then
    expect(stripped).toBe("the answer")
    expect(stripGoalKeyword("plain text")).toBe("plain text")
  })

  test("recognizes stall errors by prefix", () => {
    // given/when/then
    expect(isStallPollError("Task stalled: subagent session ses_x was idle")).toBe(true)
    expect(isStallPollError("Poll inactivity timeout reached")).toBe(false)
    expect(isStallPollError("")).toBe(false)
  })

  test("resumes stalled children within budget only", () => {
    // given/when/then
    expect(shouldAutoResumeChild("Task stalled: idle", 0)).toBe(true)
    expect(shouldAutoResumeChild("Task stalled: idle", 1)).toBe(true)
    expect(shouldAutoResumeChild("Task stalled: idle", 2)).toBe(false)
    expect(shouldAutoResumeChild("Poll inactivity timeout reached", 0)).toBe(false)
  })

  test("resume nudge names the task and restates the keyword", () => {
    // given/when
    const nudge = buildChildResumeNudge({ description: "review the API" })

    // then
    expect(nudge).toContain("review the API")
    expect(nudge).toContain(CHILD_DONE_KEYWORD)
  })
})
