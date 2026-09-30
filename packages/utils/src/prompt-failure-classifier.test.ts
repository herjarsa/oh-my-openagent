import { describe, expect, test } from "bun:test"

import {
  isAmbiguousPostDispatchPromptFailure,
  isAmbiguousPromptDispatchFailure,
} from "./prompt-failure-classifier"

describe("gate skips are not ambiguous dispatch failures", () => {
  test("a gate skip surfaces instead of being swallowed as post-dispatch ambiguity", () => {
    // given: the gate refused the dispatch outright, so nothing was sent
    const gateSkip = new Error("promptAsync skipped by gate: reserved")

    // then
    expect(isAmbiguousPromptDispatchFailure(gateSkip)).toBe(false)
    expect(isAmbiguousPostDispatchPromptFailure({ status: "failed", error: gateSkip, dispatchAttempted: true })).toBe(false)
  })

  test("real post-dispatch ambiguities stay ambiguous", () => {
    for (const message of ["Unexpected EOF", "JSON parse error", "promptAsync timed out after 30000ms"]) {
      const error = new Error(message)
      expect(isAmbiguousPromptDispatchFailure(error)).toBe(true)
      expect(isAmbiguousPostDispatchPromptFailure({ status: "failed", error, dispatchAttempted: true })).toBe(true)
    }
  })

  test("a pre-dispatch failure is not post-dispatch ambiguous", () => {
    expect(isAmbiguousPostDispatchPromptFailure({ status: "failed", error: new Error("Unexpected EOF"), dispatchAttempted: false })).toBe(false)
  })
})
