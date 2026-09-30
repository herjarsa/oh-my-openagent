import { afterEach, beforeEach, describe, expect, test } from "bun:test"
declare const require: (name: string) => any
import { __setTimingConfig, __resetTimingConfig } from "./timing"

function createMockCtx(aborted = false) {
  const controller = new AbortController()
  if (aborted) controller.abort()
  return {
    sessionID: "parent-session",
    messageID: "parent-message",
    agent: "test-agent",
    abort: controller.signal,
  }
}

describe("pollSyncSession", () => {
  beforeEach(() => {
    __setTimingConfig({
      POLL_INTERVAL_MS: 10,
      MIN_STABILITY_TIME_MS: 0,
      STABILITY_POLLS_REQUIRED: 1,
      MAX_POLL_TIME_MS: 5000,
    })
  })

  afterEach(() => {
    __resetTimingConfig()
  })

  describe("native finish-based completion", () => {
    test("returns terminal session error when assistant message contains info.error", async () => {
      // given: error in assistant message
      const { pollSyncSession } = require("./sync-session-poller")

      const mockClient = {
        session: {
          messages: async () => ({
            data: [
              { info: { id: "msg_001", role: "user", time: { created: 1000 } } },
              {
                info: {
                  id: "msg_002",
                  role: "assistant",
                  time: { created: 2000 },
                  error: { data: { message: "Forbidden: Selected provider is forbidden" } },
                },
                parts: [],
              },
            ],
          }),
          status: async () => ({ data: { "ses_test": { type: "idle" } } }),
        },
      }

      // when: calling pollSyncSession
      const result = await pollSyncSession(createMockCtx(), mockClient, {
        sessionID: "ses_test",
        agentToUse: "test-agent",
        toastManager: null,
        taskId: undefined,
      })

      // then: returns error message
      expect(result).toBe("Forbidden: Selected provider is forbidden")
    })

    test("surfaces terminal errors even when status remains busy", async () => {
      const { pollSyncSession } = require("./sync-session-poller")
      const controller = new AbortController()
      let statusCallCount = 0
      let messageCallCount = 0
      const terminalError = "Provider quota exceeded"
      const mockClient = {
        session: {
          messages: async () => {
            messageCallCount++
            return {
              data: [
                { info: { id: "msg_001", role: "user", time: { created: 1000 } } },
                {
                  info: {
                    id: "msg_002",
                    role: "assistant",
                    time: { created: 2000 },
                    error: { data: { message: terminalError } },
                  },
                  parts: [],
                },
              ],
            }
          },
          status: async () => {
            statusCallCount++
            if (statusCallCount >= 3) controller.abort()
            return { data: { ses_busy_error: { type: "busy" } } }
          },
          abort: async () => ({}),
        },
      }

      const result = await pollSyncSession({ ...createMockCtx(), abort: controller.signal }, mockClient, {
        sessionID: "ses_busy_error",
        agentToUse: "test-agent",
        toastManager: null,
        taskId: undefined,
      }, 50)

      expect(result).toBe(terminalError)
      expect(messageCallCount).toBe(1)
      expect(statusCallCount).toBe(1)
    })

    test("ignores stale prior-turn assistant errors after a new user turn starts", async () => {
      // given: prior error exists but user sent new message
      const { pollSyncSession } = require("./sync-session-poller")

      const mockClient = {
        session: {
          messages: async () => ({
            data: [
              { info: { id: "msg_001", role: "user", time: { created: 1000 } } },
              {
                info: {
                  id: "msg_002",
                  role: "assistant",
                  time: { created: 2000 },
                  error: { data: { message: "Forbidden: Selected provider is forbidden" } },
                },
                parts: [],
              },
              { info: { id: "msg_003", role: "user", time: { created: 3000 } } },
            ],
          }),
          status: async () => ({ data: { "ses_test": { type: "idle" } } }),
          abort: async () => ({}),
        },
      }

      // when: calling with stale error
      const result = await pollSyncSession(createMockCtx(), mockClient, {
        sessionID: "ses_test",
        agentToUse: "test-agent",
        toastManager: null,
        taskId: undefined,
        anchorMessageCount: 2,
      }, 50)

      // then: times out (ignores stale error)
      expect(result).toContain("Poll inactivity timeout reached")
    })

    test("detects completion when assistant message has terminal finish reason", async () => {
      // given: terminal assistant finish with assistant id > user id
      const { pollSyncSession } = require("./sync-session-poller")

      const mockClient = {
        session: {
          messages: async () => ({
            data: [
              { info: { id: "msg_001", role: "user", time: { created: 1000 } } },
              {
                info: { id: "msg_002", role: "assistant", time: { created: 2000 }, finish: "stop" },
                parts: [{ type: "text", text: "Done" }],
              },
            ],
          }),
          status: async () => ({ data: { "ses_test": { type: "idle" } } }),
        },
      }

      // when: calling pollSyncSession
      const result = await pollSyncSession(createMockCtx(), mockClient, {
        sessionID: "ses_test",
        agentToUse: "test-agent",
        toastManager: null,
        taskId: undefined,
      })

      // then: returns null (success)
      expect(result).toBeNull()
    })

    test("keeps polling when assistant finish is tool-calls (non-terminal)", async () => {
      // given: first poll returns tool-calls, second returns end_turn
      const { pollSyncSession } = require("./sync-session-poller")

      let callCount = 0
      const mockClient = {
        session: {
          messages: async () => {
            callCount++
            if (callCount <= 2) {
              return {
                data: [
                  { info: { id: "msg_001", role: "user", time: { created: 1000 } } },
                  {
                    info: { id: "msg_002", role: "assistant", time: { created: 2000 }, finish: "tool-calls" },
                    parts: [{ type: "tool-call", text: "calling tool" }],
                  },
                ],
              }
            }
            return {
              data: [
                { info: { id: "msg_001", role: "user", time: { created: 1000 } } },
                {
                  info: { id: "msg_002", role: "assistant", time: { created: 2000 }, finish: "tool-calls" },
                  parts: [{ type: "tool-call", text: "calling tool" }],
                },
                { info: { id: "msg_003", role: "user", time: { created: 3000 } } },
                {
                  info: { id: "msg_004", role: "assistant", time: { created: 4000 }, finish: "end_turn" },
                  parts: [{ type: "text", text: "Final answer" }],
                },
              ],
            }
          },
          status: async () => ({ data: { "ses_test": { type: "idle" } } }),
        },
      }

      // when: calling pollSyncSession
      const result = await pollSyncSession(createMockCtx(), mockClient, {
        sessionID: "ses_test",
        agentToUse: "test-agent",
        toastManager: null,
        taskId: undefined,
      })

      // then: returns null after polling continues
      expect(result).toBeNull()
      expect(callCount).toBeGreaterThan(2)
    })

    test("keeps polling when finish is 'unknown' (non-terminal)", async () => {
      // given: first poll returns unknown finish
      const { pollSyncSession } = require("./sync-session-poller")

      let callCount = 0
      const mockClient = {
        session: {
          messages: async () => {
            callCount++
            if (callCount <= 1) {
              return {
                data: [
                  { info: { id: "msg_001", role: "user", time: { created: 1000 } } },
                  {
                    info: { id: "msg_002", role: "assistant", time: { created: 2000 }, finish: "unknown" },
                    parts: [],
                  },
                ],
              }
            }
            return {
              data: [
                { info: { id: "msg_001", role: "user", time: { created: 1000 } } },
                {
                  info: { id: "msg_002", role: "assistant", time: { created: 2000 }, finish: "unknown" },
                  parts: [],
                },
                { info: { id: "msg_003", role: "user", time: { created: 3000 } } },
                {
                  info: { id: "msg_004", role: "assistant", time: { created: 4000 }, finish: "stop" },
                  parts: [{ type: "text", text: "Done" }],
                },
              ],
            }
          },
          status: async () => ({ data: { "ses_test": { type: "idle" } } }),
        },
      }

      // when: calling pollSyncSession
      const result = await pollSyncSession(createMockCtx(), mockClient, {
        sessionID: "ses_test",
        agentToUse: "test-agent",
        toastManager: null,
        taskId: undefined,
      })

      // then: returns null after polling continues
      expect(result).toBeNull()
      expect(callCount).toBeGreaterThan(1)
    })

    test("keeps polling when finish is 'stop' but assistant still has tool-call parts", async () => {
      // given: finish is stop but tool-call parts exist
      const { pollSyncSession } = require("./sync-session-poller")

      let callCount = 0
      const mockClient = {
        session: {
          messages: async () => {
            callCount++
            if (callCount <= 1) {
              return {
                data: [
                  { info: { id: "msg_001", role: "user", time: { created: 1000 } } },
                  {
                    info: { id: "msg_002", role: "assistant", time: { created: 2000 }, finish: "stop" },
                    parts: [{ type: "tool-call", text: "calling tool" }],
                  },
                ],
              }
            }
            return {
              data: [
                { info: { id: "msg_001", role: "user", time: { created: 1000 } } },
                {
                  info: { id: "msg_002", role: "assistant", time: { created: 2000 }, finish: "stop" },
                  parts: [{ type: "tool-call", text: "calling tool" }],
                },
                { info: { id: "msg_003", role: "user", time: { created: 3000 } } },
                {
                  info: { id: "msg_004", role: "assistant", time: { created: 4000 }, finish: "stop" },
                  parts: [{ type: "text", text: "Done" }],
                },
              ],
            }
          },
          status: async () => ({ data: { "ses_test": { type: "idle" } } }),
        },
      }

      // when: calling pollSyncSession
      const result = await pollSyncSession(createMockCtx(), mockClient, {
        sessionID: "ses_test",
        agentToUse: "test-agent",
        toastManager: null,
        taskId: undefined,
      })

      // then: returns null after polling continues
      expect(result).toBeNull()
      expect(callCount).toBeGreaterThan(1)
    })

    test("does not complete when assistant id < user id (user sent after assistant)", async () => {
      // given: assistant finished but user message came after it
      const { pollSyncSession } = require("./sync-session-poller")

      let callCount = 0
      const mockClient = {
        session: {
          messages: async () => {
            callCount++
            if (callCount <= 1) {
              return {
                data: [
                  { info: { id: "msg_001", role: "user", time: { created: 1000 } } },
                  {
                    info: { id: "msg_002", role: "assistant", time: { created: 2000 }, finish: "end_turn" },
                    parts: [{ type: "text", text: "Partial" }],
                  },
                  { info: { id: "msg_003", role: "user", time: { created: 3000 } } },
                ],
              }
            }
            return {
              data: [
                { info: { id: "msg_001", role: "user", time: { created: 1000 } } },
                {
                  info: { id: "msg_002", role: "assistant", time: { created: 2000 }, finish: "end_turn" },
                  parts: [{ type: "text", text: "Partial" }],
                },
                { info: { id: "msg_003", role: "user", time: { created: 3000 } } },
                {
                  info: { id: "msg_004", role: "assistant", time: { created: 4000 }, finish: "end_turn" },
                  parts: [{ type: "text", text: "Final" }],
                },
              ],
            }
          },
          status: async () => ({ data: { "ses_test": { type: "idle" } } }),
        },
      }

      // when: calling pollSyncSession
      const result = await pollSyncSession(createMockCtx(), mockClient, {
        sessionID: "ses_test",
        agentToUse: "test-agent",
        toastManager: null,
        taskId: undefined,
      })

      // then: returns null after polling continues
      expect(result).toBeNull()
      expect(callCount).toBeGreaterThan(1)
    })
  })

  describe("abort handling", () => {
    test("#given session completed AND abort fires #then returns completion result not abort", async () => {
      // given: session completes and abort fires
      const { pollSyncSession } = require("./sync-session-poller")
      const controller = new AbortController()
      controller.abort()

      let abortCount = 0
      let messageCallCount = 0
      const mockClient = {
        session: {
          abort: async () => {
            abortCount++
          },
          messages: async () => {
            messageCallCount++
            return {
              data: [
                { info: { id: "msg_001", role: "user", time: { created: 1000 } } },
                {
                  info: { id: "msg_002", role: "assistant", time: { created: 2000 }, finish: "stop" },
                  parts: [{ type: "text", text: "Done" }],
                },
              ],
            }
          },
          status: async () => ({ data: {} }),
        },
      }

      // when: calling pollSyncSession
      const result = await pollSyncSession({
        sessionID: "parent-session",
        messageID: "parent-message",
        agent: "test-agent",
        abort: controller.signal,
      }, mockClient, {
        sessionID: "ses_abort_complete",
        agentToUse: "test-agent",
        toastManager: { removeTask: () => {} },
        taskId: "task_123",
        anchorMessageCount: 1,
      })

      // then: returns null with no abort
      expect(result).toBeNull()
      expect(messageCallCount).toBe(1)
      expect(abortCount).toBe(0)
    })

    test("returns abort message when signal is aborted", async () => {
      // given: abort signal already aborted
      const { pollSyncSession } = require("./sync-session-poller")
      let abortCount = 0
      const mockClient = {
        session: {
          abort: async () => {
            abortCount++
          },
          messages: async () => ({ data: [] }),
          status: async () => ({ data: {} }),
        },
      }

      // when: calling pollSyncSession with aborted signal
      const result = await pollSyncSession(createMockCtx(true), mockClient, {
        sessionID: "ses_abort",
        agentToUse: "test-agent",
        toastManager: { removeTask: () => {} },
        taskId: "task_123",
      })

      // then: returns abort message
      expect(result).toContain("Task aborted")
      expect(result).toContain("ses_abort")
      expect(abortCount).toBe(1)
    })

    test("retries final message fetch on abort before returning aborted", async () => {
      // given: abort signal set and message fetch keeps failing
      const { pollSyncSession } = require("./sync-session-poller")
      let abortCount = 0
      let messageCallCount = 0
      const mockClient = {
        session: {
          abort: async () => {
            abortCount++
          },
          messages: async () => {
            messageCallCount++
            throw new Error("temporary fetch failure")
          },
          status: async () => ({ data: {} }),
        },
      }

      const result = await pollSyncSession(createMockCtx(true), mockClient, {
        sessionID: "ses_abort_retry",
        agentToUse: "test-agent",
        toastManager: { removeTask: () => {} },
        taskId: "task_123",
      })

      // then
      expect(result).toContain("Task aborted")
      expect(messageCallCount).toBe(3)
      expect(abortCount).toBe(1)
    })
  })

  describe("timeout handling", () => {
    test("returns error string on timeout", async () => {
      // given: no terminal finish and short timeout
      const { pollSyncSession } = require("./sync-session-poller")

      __setTimingConfig({
        POLL_INTERVAL_MS: 10,
        MIN_STABILITY_TIME_MS: 0,
        STABILITY_POLLS_REQUIRED: 1,
        MAX_POLL_TIME_MS: 0,
      })

      let abortCount = 0
      const mockClient = {
        session: {
          abort: async () => {
            abortCount++
          },
          messages: async () => ({
            data: [
              { info: { id: "msg_001", role: "user", time: { created: 1000 } } },
            ],
          }),
          status: async () => ({ data: { "ses_timeout": { type: "idle" } } }),
        },
      }

      // when: calling pollSyncSession
      const result = await pollSyncSession(createMockCtx(), mockClient, {
        sessionID: "ses_timeout",
        agentToUse: "test-agent",
        toastManager: null,
        taskId: undefined,
      }, 0)

      // then: returns timeout error
      expect(result).toBe("Poll inactivity timeout reached after 50ms without active OpenCode status for session ses_timeout")
      expect(abortCount).toBe(1)
    })
  })

  describe("non-idle session status", () => {
    test("inspects messages while active but only completes once the session is idle", async () => {
      // given: session is running (not idle)
      const { pollSyncSession } = require("./sync-session-poller")

      let statusCallCount = 0
      let messageCallCount = 0
      let messageCallsWhileActive = 0
       const mockClient = {
         session: {
           messages: async () => {
             messageCallCount++
             if (statusCallCount <= 2) messageCallsWhileActive++
             return {
               data:
                 statusCallCount >= 3
                   ? [
                       { info: { id: "msg_001", role: "user", time: { created: 1000 } } },
                       {
                         info: { id: "msg_002", role: "assistant", time: { created: 2000 }, finish: "end_turn" },
                         parts: [{ type: "text", text: "Done" }],
                       },
                     ]
                   : [{ info: { id: "msg_001", role: "user", time: { created: 1000 } } }],
             }
           },
           status: async () => {
             statusCallCount++
             if (statusCallCount <= 2) {
               return { data: { "ses_busy": { type: "running" } } }
             }
             return { data: { "ses_busy": { type: "idle" } } }
           },
         },
       }

      // when: calling pollSyncSession
      const result = await pollSyncSession(createMockCtx(), mockClient, {
        sessionID: "ses_busy",
        agentToUse: "test-agent",
        toastManager: null,
        taskId: undefined,
      })

      // then: messages were inspected while the status was still active (terminal errors
      // must surface there), and completion was only declared once the session went idle
      expect(result).toBeNull()
      expect(statusCallCount).toBeGreaterThanOrEqual(3)
      expect(messageCallsWhileActive).toBeGreaterThanOrEqual(1)
      expect(messageCallCount).toBeGreaterThanOrEqual(2)
    })
  })

  describe("isSessionComplete edge cases", () => {
    test("returns false when messages array is empty", () => {
      const { isSessionComplete } = require("./sync-session-poller")

      // given: empty messages array
      const messages: unknown[] = []

      // when: calling isSessionComplete
      const result = isSessionComplete(messages)

      // then: returns false
      expect(result).toBe(false)
    })

    test("returns false when no assistant message exists", () => {
      const { isSessionComplete } = require("./sync-session-poller")

      // given: only user messages, no assistant
      const messages = [
        { info: { id: "msg_001", role: "user", time: { created: 1000 } } },
        { info: { id: "msg_002", role: "user", time: { created: 2000 } } },
      ]

      // when: calling isSessionComplete
      const result = isSessionComplete(messages)

      // then: returns false
      expect(result).toBe(false)
    })

    test("returns false when only assistant message exists (no user)", () => {
      const { isSessionComplete } = require("./sync-session-poller")

      // given: only assistant message, no user message
      const messages = [
        {
          info: { id: "msg_001", role: "assistant", time: { created: 1000 }, finish: "end_turn" },
          parts: [{ type: "text", text: "Response" }],
        },
      ]

      // when: calling isSessionComplete
      const result = isSessionComplete(messages)

      // then: returns false (no user message to compare IDs)
      expect(result).toBe(false)
    })

    test("returns false when assistant message has missing finish field", () => {
      const { isSessionComplete } = require("./sync-session-poller")

      // given: assistant message without finish field
      const messages = [
        { info: { id: "msg_001", role: "user", time: { created: 1000 } } },
        {
          info: { id: "msg_002", role: "assistant", time: { created: 2000 } },
          parts: [{ type: "text", text: "Response" }],
        },
      ]

      // when: calling isSessionComplete
      const result = isSessionComplete(messages)

      // then: returns false (missing finish)
      expect(result).toBe(false)
    })

    test("returns false when assistant message has missing info.id field", () => {
      const { isSessionComplete } = require("./sync-session-poller")

      // given: assistant message without id in info
      const messages = [
        { info: { id: "msg_001", role: "user", time: { created: 1000 } } },
        {
          info: { role: "assistant", time: { created: 2000 }, finish: "end_turn" },
          parts: [{ type: "text", text: "Response" }],
        },
      ]

      // when: calling isSessionComplete
      const result = isSessionComplete(messages)

      // then: returns false (missing assistant id)
      expect(result).toBe(false)
    })

    test("returns false when finish is stop but assistant has tool-call parts", () => {
      const { isSessionComplete } = require("./sync-session-poller")

      // given: provider marks stop even though tool execution is pending
      const messages = [
        { info: { id: "msg_001", role: "user", time: { created: 1000 } } },
        {
          info: { id: "msg_002", role: "assistant", time: { created: 2000 }, finish: "stop" },
          parts: [{ type: "tool-call", text: "calling tool" }],
        },
      ]

      // when: calling isSessionComplete
      const result = isSessionComplete(messages)

      // then: returns false because tool execution is still pending
      expect(result).toBe(false)
    })

    test("returns false when finish is end_turn but assistant has tool-call parts", () => {
      const { isSessionComplete } = require("./sync-session-poller")

      // given: assistant emitted terminal finish but contains pending tool calls
      const messages = [
        { info: { id: "msg_001", role: "user", time: { created: 1000 } } },
        {
          info: { id: "msg_002", role: "assistant", time: { created: 2000 }, finish: "end_turn" },
          parts: [{ type: "tool-call", text: "calling tool" }],
        },
      ]

      // when: calling isSessionComplete
      const result = isSessionComplete(messages)

      // then: returns false because tool execution is still pending
      expect(result).toBe(false)
    })

    test("returns false when user message has missing info.id field", () => {
      const { isSessionComplete } = require("./sync-session-poller")

      // given: user message without id in info
      const messages = [
        { info: { role: "user", time: { created: 1000 } } },
        {
          info: { id: "msg_002", role: "assistant", time: { created: 2000 }, finish: "end_turn" },
          parts: [{ type: "text", text: "Response" }],
        },
      ]

      // when: calling isSessionComplete
      const result = isSessionComplete(messages)

      // then: returns false (missing user id)
      expect(result).toBe(false)
    })
  })

  describe("direct child background task gating", () => {
    const completeMessages = {
      data: [
        { info: { id: "msg_001", role: "user", time: { created: 1000 } } },
        {
          info: { id: "msg_002", role: "assistant", time: { created: 2000 }, finish: "stop" },
          parts: [{ type: "text", text: "Done" }],
        },
      ],
    }

    test("waits for a fresh terminal turn after child background tasks clear", async () => {
      const { pollSyncSession } = require("./sync-session-poller")
      let childCheck = 0
      const synthesizedMessages = {
        data: [
          ...completeMessages.data,
          { info: { id: "msg_003", role: "user", time: { created: 3000 } } },
          {
            info: { id: "msg_004", role: "assistant", time: { created: 4000 }, finish: "stop" },
            parts: [{ type: "text", text: "Synthesized" }],
          },
        ],
      }
      const mockClient = {
        session: {
          messages: async () => (childCheck > 1 ? synthesizedMessages : completeMessages),
          status: async () => ({ data: { ses_test: { type: "idle" } } }),
        },
      }

      const result = await pollSyncSession(createMockCtx(), mockClient, {
        sessionID: "ses_test",
        agentToUse: "test-agent",
        toastManager: null,
        taskId: undefined,
        childWakeGraceMs: 10_000,
        hasActiveChildBackgroundTasks: () => ++childCheck === 1,
      })

      expect(result).toBeNull()
      expect(childCheck).toBeGreaterThanOrEqual(3)
    })

    test("keeps waiting while a parent wake is pending even after children clear", async () => {
      // Regression: children finish, but the parent-wake notification (debounce +
      // queue + promptAsync gate) has not yet produced the continuation turn. With a
      // tiny settle window, the loop must still wait on hasPendingParentWake rather
      // than returning the pre-results turn.
      const { pollSyncSession } = require("./sync-session-poller")
      let wakePolls = 0
      const synthesizedMessages = {
        data: [
          ...completeMessages.data,
          { info: { id: "msg_003", role: "user", time: { created: 3000 } } },
          {
            info: { id: "msg_004", role: "assistant", time: { created: 4000 }, finish: "stop" },
            parts: [{ type: "text", text: "Plan with results" }],
          },
        ],
      }
      const mockClient = {
        session: {
          // The continuation turn lands as the dispatched wake is consumed.
          messages: async () => (wakePolls >= 2 ? synthesizedMessages : completeMessages),
          status: async () => ({ data: { ses_test: { type: "idle" } } }),
        },
      }

      const result = await pollSyncSession(createMockCtx(), mockClient, {
        sessionID: "ses_test",
        agentToUse: "test-agent",
        toastManager: null,
        taskId: undefined,
        childWakeGraceMs: 1,
        hasActiveChildBackgroundTasks: () => false,
        hasPendingParentWake: () => {
          wakePolls++
          return wakePolls < 3
        },
      })

      expect(result).toBeNull()
      // Without the wake gate the loop would have broken on the very first poll.
      expect(wakePolls).toBeGreaterThanOrEqual(3)
    })

    test("times out when direct child background tasks never finish", async () => {
      const { pollSyncSession } = require("./sync-session-poller")
      const mockClient = {
        session: {
          messages: async () => completeMessages,
          status: async () => ({ data: { ses_test: { type: "idle" } } }),
          abort: async () => ({}),
        },
      }

      const result = await pollSyncSession(createMockCtx(), mockClient, {
        sessionID: "ses_test",
        agentToUse: "test-agent",
        toastManager: null,
        taskId: undefined,
        hasActiveChildBackgroundTasks: () => true,
      }, 30)

      expect(result).toContain("Poll inactivity timeout reached")
    })
  })
})
describe("no-progress fail-fast", () => {
  beforeEach(() => {
    __setTimingConfig({ POLL_INTERVAL_MS: 10, MAX_POLL_TIME_MS: 5000 })
  })

  afterEach(() => {
    __resetTimingConfig()
  })
  test("returns stall error when idle with static messages", async () => {
    // given: idle child, one user message, nothing ever changes
    const { pollSyncSession } = require("./sync-session-poller")
    let abortCalled = 0
    const mockClient = {
      session: {
        messages: async () => ({
          data: [{ info: { id: "msg_001", role: "user", time: { created: 1000 } }, parts: [] }],
        }),
        status: async () => ({ data: { "ses_stalled": { type: "idle" } } }),

        abort: async () => { abortCalled++ },
      },
    }

    // when: polling a dead child
    const result = await pollSyncSession(createMockCtx(), mockClient, {
      sessionID: "ses_stalled",
      agentToUse: "test-agent",
      toastManager: null,
      taskId: undefined,
    })

    // then: fail-fast stall error naming the session, abort called
    expect(result).toContain("Task stalled")
    expect(result).toContain("ses_stalled")
    expect(abortCalled).toBe(1)
  })

  test("resets the stall counter while status is active", async () => {
    // given: busy for a while, then idle with static messages
    const { pollSyncSession } = require("./sync-session-poller")
    let statusCalls = 0
    const mockClient = {
      session: {
        messages: async () => ({
          data: [{ info: { id: "msg_001", role: "user", time: { created: 1000 } }, parts: [] }],
        }),
        status: async () => {
          statusCalls++
          return { data: { "ses_flap": { type: statusCalls <= 70 ? "busy" : "idle" } } }
        },
        abort: async () => ({}),
      },
    }

    // when: polling past the stall threshold with an active window first
    const result = await pollSyncSession(createMockCtx(), mockClient, {
      sessionID: "ses_flap",
      agentToUse: "test-agent",
      toastManager: null,
      taskId: undefined,
    })

    // then: stall fires only after the idle stretch, not during busy
    expect(result).toContain("Task stalled")
    expect(statusCalls).toBeGreaterThan(70)
  })

  test("does not stall while a child continuation is owed", async () => {
    // given: incomplete messages while continuation owed, complete right after release
    const { pollSyncSession } = require("./sync-session-poller")
    let phaseChecks = 0
    const incompleteMessages = {
      data: [{ info: { id: "msg_001", role: "user", time: { created: 1000 } }, parts: [] }],
    }
    const completeMessages = {
      data: [
        { info: { id: "msg_001", role: "user", time: { created: 1000 } }, parts: [] },
        {
          info: { id: "msg_002", role: "assistant", time: { created: 2000 }, finish: "stop" },
          parts: [{ type: "text", text: "done" }],
        },
      ],
    }
    const mockClient = {
      session: {
        messages: async () => (phaseChecks <= 3 ? incompleteMessages : completeMessages),
        status: async () => ({ data: { "ses_wake": { type: "idle" } } }),
        abort: async () => ({}),
      },
    }
    const stillOwed = () => ++phaseChecks <= 3

    // when: continuation owed, then released with complete messages
    const result = await pollSyncSession(createMockCtx(), mockClient, {
      sessionID: "ses_wake",
      agentToUse: "test-agent",
      toastManager: null,
      taskId: undefined,
      hasActiveChildBackgroundTasks: stillOwed,
    })

    // then: completes normally once the wake lands, no stall
    expect(result).toBeNull()
  })
})
describe("goal keyword completion", () => {
  beforeEach(() => {
    __setTimingConfig({ POLL_INTERVAL_MS: 10, MAX_POLL_TIME_MS: 5000 })
  })

  afterEach(() => {
    __resetTimingConfig()
  })

  test("completes immediately when the newest assistant turn carries the keyword", async () => {
    // given: keyword answer, no finish flag, continuation still owed
    const { pollSyncSession } = require("./sync-session-poller")
    const { CHILD_DONE_KEYWORD } = require("./child-goal")
    const mockClient = {
      session: {
        messages: async () => ({
          data: [
            { info: { id: "msg_001", role: "user", time: { created: 1000 } }, parts: [] },
            {
              info: { id: "msg_002", role: "assistant", time: { created: 2000 } },
              parts: [{ type: "text", text: `the verdict\n${CHILD_DONE_KEYWORD}` }],
            },
          ],
        }),
        status: async () => ({ data: { "ses_goal": { type: "idle" } } }),
        abort: async () => ({}),
      },
    }

    // when: polling with a pending continuation that would otherwise wait
    const result = await pollSyncSession(createMockCtx(), mockClient, {
      sessionID: "ses_goal",
      agentToUse: "test-agent",
      toastManager: null,
      taskId: undefined,
      hasActiveChildBackgroundTasks: () => true,
    })

    // then: keyword overrides the wait, no stall, no timeout
    expect(result).toBeNull()
  })

  test("ignores a keyword that predates the anchor", async () => {
    // given: keyword turn followed by a fresh user turn used as anchor
    const { pollSyncSession } = require("./sync-session-poller")
    const { CHILD_DONE_KEYWORD } = require("./child-goal")
    const staticMessages = {
      data: [
        { info: { id: "m1", role: "user" }, parts: [] },
        { info: { id: "m2", role: "assistant" }, parts: [{ type: "text", text: CHILD_DONE_KEYWORD }] },
        { info: { id: "m3", role: "user" }, parts: [{ type: "text", text: "keep going" }] },
      ],
    }
    const mockClient = {
      session: {
        messages: async () => staticMessages,
        status: async () => ({ data: { "ses_oldkey": { type: "idle" } } }),
        abort: async () => ({}),
      },
    }

    // when: anchored after the keyword turn with nothing new after it
    const result = await pollSyncSession(createMockCtx(), mockClient, {
      sessionID: "ses_oldkey",
      agentToUse: "test-agent",
      toastManager: null,
      taskId: undefined,
      anchorMessageID: "m3",
    })

    // then: old keyword does not complete; dead child stalls fast
    expect(result).toContain("Task stalled")
  })
})
describe("text growth resets stall", () => {
  beforeEach(() => {
    const { __setTimingConfig } = require("./timing")
    __setTimingConfig({ POLL_INTERVAL_MS: 10 })
  })

  afterEach(() => {
    const { __resetTimingConfig } = require("./timing")
    __resetTimingConfig()
  })

  test("does not stall a working tool-call loop with growing text", async () => {
    // given: tool-call turns never heuristically complete, but text keeps growing
    const { pollSyncSession } = require("./sync-session-poller")
    let fetchCount = 0
    const mockClient = {
      session: {
        messages: async () => {
          fetchCount++
          return {
            data: [
              { info: { id: "m1", role: "user" }, parts: [] },
              {
                info: { id: "m2", role: "assistant", finish: "tool-calls" },
                parts: [{ type: "text", text: "progress-" + "x".repeat(fetchCount) }],
              },
            ],
          }
        },
        status: async () => ({ data: { ses_stream: { type: "idle" } } }),
        abort: async () => ({}),
      },
    }

    // when: the bound is deliberately short so the run stays fast
    const result = await pollSyncSession(createMockCtx(), mockClient, {
      sessionID: "ses_stream",
      agentToUse: "test-agent",
      toastManager: null,
      taskId: undefined,
    }, 400)

    // then: growth suppressed the 60-poll stall, so only the bound stopped it
    expect(result).toContain("Poll inactivity timeout reached")
    expect(fetchCount).toBeGreaterThanOrEqual(2)
  })
})
