import { describe, expect, test } from "bun:test"

import { createSyncSession } from "./sync-session-creator"

async function runWithCreateResult(createResult: unknown) {
  const client = {
    session: {
      get: async () => ({ data: { directory: "/parent" } }),
      create: async () => createResult,
    },
  }
  return createSyncSession(client as never, {
    parentSessionID: "ses_parent",
    agentToUse: "explore",
    description: "test task",
    defaultDirectory: "/fallback",
  })
}

describe("createSyncSession", () => {
  test("creates child session with question permission denied", async () => {
    // given
    const createCalls: Array<Record<string, unknown>> = []
    const client = {
      session: {
        get: async () => ({ data: { directory: "/parent" } }),
        create: async (input: Record<string, unknown>) => {
          createCalls.push(input)
          return { data: { id: "ses_child" } }
        },
      },
    }

    // when
    const result = await createSyncSession(client as never, {
      parentSessionID: "ses_parent",
      agentToUse: "explore",
      description: "test task",
      defaultDirectory: "/fallback",
    })

    // then
    expect(result).toEqual({ ok: true, sessionID: "ses_child", parentDirectory: "/parent" })
    expect(createCalls).toHaveLength(1)
    expect(createCalls[0]?.body).toEqual({
      parentID: "ses_parent",
      title: "test task (@explore subagent)",
      permission: [
        { permission: "question", action: "deny", pattern: "*" },
      ],
    })
  })

  test("extracts id from direct Session object", async () => {
    // given
    const createResult = { id: "ses_direct" }

    // when
    const result = await runWithCreateResult(createResult)

    // then
    expect(result).toEqual({ ok: true, sessionID: "ses_direct", parentDirectory: "/parent" })
  })

  test("extracts id from data.info wrapper", async () => {
    // given
    const createResult = { data: { info: { id: "ses_info" } } }

    // when
    const result = await runWithCreateResult(createResult)

    // then
    expect(result).toEqual({ ok: true, sessionID: "ses_info", parentDirectory: "/parent" })
  })

  test("extracts id from data.session wrapper", async () => {
    // given
    const createResult = { data: { session: { id: "ses_nested" } } }

    // when
    const result = await runWithCreateResult(createResult)

    // then
    expect(result).toEqual({ ok: true, sessionID: "ses_nested", parentDirectory: "/parent" })
  })

  test("extracts id from top-level response wrapper", async () => {
    // given
    const createResult = { response: { id: "ses_response" } }

    // when
    const result = await runWithCreateResult(createResult)

    // then
    expect(result).toEqual({ ok: true, sessionID: "ses_response", parentDirectory: "/parent" })
  })

  test("extracts id from top-level result wrapper", async () => {
    // given
    const createResult = { result: { id: "ses_result" } }

    // when
    const result = await runWithCreateResult(createResult)

    // then
    expect(result).toEqual({ ok: true, sessionID: "ses_result", parentDirectory: "/parent" })
  })

  test("extracts id from string data envelope", async () => {
    // given
    const createResult = { data: "ses_string" }

    // when
    const result = await runWithCreateResult(createResult)

    // then
    expect(result).toEqual({ ok: true, sessionID: "ses_string", parentDirectory: "/parent" })
  })

  test("extracts id from top-level session wrapper", async () => {
    // given
    const createResult = { session: { id: "ses_top" } }

    // when
    const result = await runWithCreateResult(createResult)

    // then
    expect(result).toEqual({ ok: true, sessionID: "ses_top", parentDirectory: "/parent" })
  })

  test("returns fingerprinted error on unsupported shape", async () => {
    // given
    const createResult = { data: { unexpected: 42 } }

    // when
    const result = await runWithCreateResult(createResult)

    // then
    expect(result.ok).toBe(false)
    if (result.ok) {
      return
    }
    expect(result.error).toContain("missing session ID")
    expect(result.error).toContain("keys=[data]")
    expect(result.error).toContain("dataKeys=[unexpected]")
  })
})
