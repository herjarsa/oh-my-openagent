import { describe, expect, test } from "bun:test"

import { unsafeTestValue } from "../../../../../test-support/unsafe-test-value"
import { runSyncTaskLoop } from "./sync-task-runner"
import type { SyncTaskDeps } from "./sync-task-deps"

function baseInput(deps: SyncTaskDeps, pollBehaviors: Array<string | null>) {
  const sendPrompts: Array<unknown> = []
  let pollIndex = 0
  let createCalls = 0
  const fullDeps: SyncTaskDeps = {
    createSyncSession: (async () => {
      createCalls++
      return { ok: false as const, error: "createSyncSession must not be called on resume path" }
    }) as SyncTaskDeps["createSyncSession"],
    sendSyncPrompt: (async (...a: Parameters<SyncTaskDeps["sendSyncPrompt"]>) => {
      sendPrompts.push(a[1].args.prompt)
      return null
    }) as SyncTaskDeps["sendSyncPrompt"],
    pollSyncSession: (async () => pollBehaviors[Math.min(pollIndex++, pollBehaviors.length - 1)] ?? null) as SyncTaskDeps["pollSyncSession"],
    fetchSyncResult: (async () => ({ ok: true as const, textContent: "final answer" })) as SyncTaskDeps["fetchSyncResult"],
    ...deps,
  }
  const controller = new AbortController()
  return {
    fullDeps,
    sendPrompts,
    createCalls: () => createCalls,
    input: {
      args: {
        description: "goal supervised task",
        prompt: "do the thing",
        run_in_background: false,
        load_skills: [],
      },
      ctx: {
        sessionID: "ses_parent",
        messageID: "m1",
        agent: "sisyphus",
        abort: controller.signal,
      },
      executorCtx: {
        manager: unsafeTestValue({}),
        client: unsafeTestValue({}),
        directory: "/tmp",
      },
      parentContext: { sessionID: "ses_parent", messageID: "m1" },
      agentToUse: "oracle",
      categoryModel: undefined,
      fallbackChain: undefined,
      deps: fullDeps,
      sessionID: "ses_child",
      spawnDepth: 1,
      taskId: "t1",
      startTime: new Date(),
      syncPollTimeoutMs: undefined,
      systemContent: undefined,
      toastManager: undefined,
      modelInfo: undefined,
      registerSyncSession: async () => {},
      publishSyncMetadata: async () => {},
      cleanupRetrySession: () => {},
      setSyncSessionID: () => {},
    },
  }
}

describe("runSyncTaskLoop goal supervision", () => {
  test("resumes a stalled child in the same session and delivers the result", async () => {
    // given: first poll stalls, second poll completes
    const built = baseInput({} as SyncTaskDeps, ["Task stalled: idle child", null])

    // when
    const result = await runSyncTaskLoop(built.input as never)

    // then: one resume nudge reusing the session, result delivered
    expect(result).toContain("final answer")
    expect(built.sendPrompts).toHaveLength(2)
    expect(built.sendPrompts[0]).toBe("do the thing")
    expect(String(built.sendPrompts[1])).toContain("Continue working")
    expect(String(built.sendPrompts[1])).toContain("goal supervised task")
    expect(built.createCalls()).toBe(0)
  })

  test("gives up after the resume budget with the stall error", async () => {
    // given: the child stalls forever
    const built = baseInput({} as SyncTaskDeps, ["Task stalled: idle child"])

    // when
    const result = await runSyncTaskLoop(built.input as never)

    // then: initial prompt plus exactly two resume nudges, then the stall error
    expect(result).toContain("Task stalled")
    expect(built.sendPrompts).toHaveLength(3)
    expect(built.createCalls()).toBe(0)
  })
})

describe("runSyncTaskLoop transient send retry", () => {
  test("resends the same prompt in the same session after a transient failure", async () => {
    // given: first send rejected as busy, second lands, poll completes
    const { runSyncTaskLoop } = require("./sync-task-runner")
    let sends = 0
    let sleeps = 0
    const sendSyncPrompt = async (...a: unknown[]) => {
      sends++
      if (sends === 1) return "promptAsync skipped by gate: reserved"
      return null
    }
    const built = baseInput(
      { sendSyncPrompt, sleep: async () => { sleeps++ } } as never,
      [null],
    )

    // when
    const result = await runSyncTaskLoop(built.input as never)

    // then: same session resent once after a delay, result delivered
    expect(result).toContain("final answer")
    expect(sends).toBe(2)
    expect(sleeps).toBe(1)
    expect(built.sendPrompts).toHaveLength(0)
  })

  test("gives up after the send budget and returns the send error", async () => {
    // given: the host keeps rejecting every send
    const { runSyncTaskLoop } = require("./sync-task-runner")
    let sends = 0
    const sendSyncPrompt = async () => {
      sends++
      return "cannot send your message at this moment"
    }
    const built = baseInput(
      { sendSyncPrompt, sleep: async () => {} } as never,
      [null],
    )

    // when
    const result = await runSyncTaskLoop(built.input as never)

    // then: initial send plus exactly three resends, then the send error
    expect(result).toContain("cannot send your message")
    expect(sends).toBe(4)
  })

  test("does not retry a permanent send error", async () => {
    // given: unknown agent key
    const { runSyncTaskLoop } = require("./sync-task-runner")
    let sends = 0
    const sendSyncPrompt = async () => {
      sends++
      return 'Agent "nope" not found. Make sure the agent is registered'
    }
    const built = baseInput(
      { sendSyncPrompt, sleep: async () => {} } as never,
      [null],
    )

    // when
    const result = await runSyncTaskLoop(built.input as never)

    // then: single send, error returned without delay or fallback loop
    expect(result).toContain("not found")
    expect(sends).toBe(1)
  })
})
