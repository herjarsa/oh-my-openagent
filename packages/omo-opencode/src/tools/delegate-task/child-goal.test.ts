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
describe("transient send retry", () => {
  test("matches transport-level not-right-now failures", async () => {
    const { isTransientSendError } = require("./child-goal")
    const transient = [
      "promptAsync skipped by gate: reserved",
      "prompt skipped by gate: active",
      "promptAsync timed out after 30000ms",
      "prompt timed out after 15000ms",
      "The running turn was stopped before OpenCode could send the next message.",
      "cannot send your message at this moment",
      "no puede enviar tu mensaje en este momento",
      "Session is busy",
      "Network error: ECONNRESET",
      "socket hang up",
    ]
    for (const message of transient) {
      expect(isTransientSendError(message)).toBe(true)
    }
  })

  test("never matches caller, config, model, abort or stall errors", async () => {
    const { isTransientSendError } = require("./child-goal")
    const permanent = [
      'Agent "Sisyphus-Junior" not found. Make sure the agent is registered',
      "MessageAbortedError: aborted by user",
      "The operation was aborted.",
      "ProviderModelNotFoundError: openai/gpt-5",
      "Task stalled: idle child",
      "Failed to create session: missing session ID",
      "Something else broke",
    ]
    for (const message of permanent) {
      expect(isTransientSendError(message)).toBe(false)
    }
  })

  test("caps the resend budget with progressive backoff", async () => {
    const { shouldRetrySendAfterDelay, sendRetryDelayMs } = require("./child-goal")
    const transient = "promptAsync skipped by gate: reserved"
    expect(shouldRetrySendAfterDelay(transient, 0)).toBe(true)
    expect(shouldRetrySendAfterDelay(transient, 2)).toBe(true)
    expect(shouldRetrySendAfterDelay(transient, 3)).toBe(false)
    expect(shouldRetrySendAfterDelay('Agent "x" not found', 0)).toBe(false)
    expect(sendRetryDelayMs(0)).toBe(5000)
    expect(sendRetryDelayMs(1)).toBe(10000)
    expect(sendRetryDelayMs(2)).toBe(15000)
  })
})

describe("clean send miss", () => {
  test("gate skips and host rejections release the hold, timeouts and network keep it", async () => {
    const { isCleanSendMiss } = require("./child-goal")
    expect(isCleanSendMiss("promptAsync skipped by gate: reserved")).toBe(true)
    expect(isCleanSendMiss("cannot send your message at this moment")).toBe(true)
    expect(isCleanSendMiss("The running turn was stopped before OpenCode could send the next message.")).toBe(true)
    expect(isCleanSendMiss("promptAsync timed out after 30000ms")).toBe(false)
    expect(isCleanSendMiss("socket hang up")).toBe(false)
    expect(isCleanSendMiss('Agent "x" not found')).toBe(false)
  })
})
