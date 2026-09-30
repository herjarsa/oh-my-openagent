import type { ToolContextWithMetadata, OpencodeClient } from "./types"
import type { SessionMessage } from "./executor-types"
import { getDefaultSyncPollTimeoutMs, getTimingConfig } from "./timing"
import { getTerminalSessionError, isSessionComplete } from "./sync-session-turns"
import { log } from "../../shared/logger"
import { normalizeSDKResponse } from "../../shared"
import { hasGoalKeywordInLatest, STALL_ERROR_PREFIX } from "./child-goal"

export { isSessionComplete } from "./sync-session-turns"

const ACTIVE_SESSION_STATUSES = new Set(["busy", "retry", "running"])
const CHILD_WAKE_GRACE_MS = 5_000
const MAX_NON_ACTIVE_STATUS_STALENESS_POLLS = 10
const MAX_IDLE_NO_PROGRESS_POLLS = 60

function wait(milliseconds: number): Promise<void> {
  // Atomics.waitAsync never settles on Bun 1.3.x for Windows (returns async:true
  // with a promise that never resolves), which hung the poll loop forever and
  // defeated every poll bound. setTimeout always fires, so the bounds hold.
  return new Promise((resolve) => {
    setTimeout(resolve, Math.max(milliseconds, 0))
  })
}

function abortSyncSession(client: OpencodeClient, sessionID: string, reason: string): void {
  log("[task] Aborting sync session", { sessionID, reason })
  void client.session.abort({
    path: { id: sessionID },
  }).catch((error: unknown) => {
    log("[task] Failed to abort sync session", { sessionID, reason, error: String(error) })
  })
}

function isActiveSessionStatus(status: { type: string } | undefined): boolean {
  return status !== undefined && ACTIVE_SESSION_STATUSES.has(status.type)
}

function totalMessageTextLength(messages: SessionMessage[]): number {
  return messages.reduce(
    (sum, m) => sum + (m.parts ?? []).reduce((partSum, p) => partSum + (p.text?.length ?? 0), 0),
    0,
  )
}
function hasMessagesAfterAnchor(
  messages: SessionMessage[],
  anchorMessageID: string | undefined,
  anchorMessageCount: number | undefined,
): boolean {
  if (anchorMessageID !== undefined) {
    const anchorIndex = messages.findIndex((message) => message.info?.id === anchorMessageID)
    return anchorIndex === -1 || anchorIndex < messages.length - 1
  }
  return anchorMessageCount === undefined || messages.length > anchorMessageCount
}

async function fetchSessionMessages(
  client: OpencodeClient,
  sessionID: string
): Promise<SessionMessage[]> {
  const messagesResult = await client.session.messages({ path: { id: sessionID }, query: { limit: 100 } })
  const rawData = (messagesResult as { data?: unknown })?.data ?? messagesResult
  return Array.isArray(rawData) ? (rawData as SessionMessage[]) : []
}

const DEFAULT_MAX_ASSISTANT_TURNS = 300

export async function pollSyncSession(
  ctx: ToolContextWithMetadata,
  client: OpencodeClient,
  input: {
    sessionID: string
    agentToUse: string
    toastManager: { removeTask: (id: string) => void } | null | undefined
    taskId: string | undefined
    anchorMessageCount?: number
    anchorMessageID?: string
    maxAssistantTurns?: number
    hasActiveChildBackgroundTasks?: (sessionID: string) => boolean
    hasPendingParentWake?: (sessionID: string) => boolean
    childWakeGraceMs?: number
  },
  timeoutMs?: number
): Promise<string | null> {
  const syncTiming = getTimingConfig()
  const maxPollTimeMs = Math.max(timeoutMs ?? getDefaultSyncPollTimeoutMs(), 50)
  const maxTurns = input.maxAssistantTurns ?? DEFAULT_MAX_ASSISTANT_TURNS
  const pollStart = Date.now()
  let inactiveStart = pollStart
  let pollCount = 0
  let idleNoProgressPolls = 0
  let nonActivePollsSinceMessageFetch = 0
  let lastStatusRevision: string | undefined
  let hasFetchedNonActiveMessages = false
  let timedOut = false
  let assistantTurnCount = 0
  let lastSeenAssistantId: string | undefined
  let lastObservedAssistantId: string | undefined
  let lastObservedMessageCount: number | undefined
  let lastTextLength: number | undefined
  const childSettleMs = input.childWakeGraceMs ?? CHILD_WAKE_GRACE_MS
  let childWaitAssistantId: string | undefined
  // Set when a continuation was owed earlier in the same poll iteration. The
  // live check below can flip back to false before the completion branch runs, so
  // without this the poller would hand back the pre-results turn instead of
  // honoring the child wake grace.
  let continuationOwedThisPoll = false
  let childSettleStartedAt = 0
  // A sync subagent can end its turn and then be re-woken by a parent-wake
  // notification once its background children finish. The task is only truly done
  // when no direct child work remains AND no wake is queued/in-flight for this
  // session. (Direct children only: a grandchild's completion wake is addressed to
  // its immediate parent, never to this session, so gating on grandchildren would
  // block on continuations this session can never receive.)
  // hasPendingParentWake bridges the notification dispatch window (debounce + queue +
  // promptAsync gate), which routinely exceeds a fixed grace; the settle window then
  // covers only the sub-second gap between a child reaching terminal status and the
  // wake being enqueued. Once a new turn appears the assistant id changes and we stop
  // waiting to evaluate it. The outer inactivity timeout remains the safety bound.
  const isAwaitingChildContinuation = (currentAssistantId: string | undefined): boolean => {
    const continuationOwed =
      (input.hasActiveChildBackgroundTasks?.(input.sessionID) ?? false) ||
      (input.hasPendingParentWake?.(input.sessionID) ?? false)
    if (continuationOwed) {
      childWaitAssistantId = currentAssistantId
      childSettleStartedAt = 0
      return true
    }
    if (continuationOwedThisPoll) {
      childWaitAssistantId = currentAssistantId
      childSettleStartedAt = 0
      return true
    }
    if (childWaitAssistantId === undefined || currentAssistantId !== childWaitAssistantId) {
      return false
    }
    childSettleStartedAt ||= Date.now()
    return Date.now() - childSettleStartedAt < childSettleMs
  }

  log("[task] Starting poll loop", { sessionID: input.sessionID, agentToUse: input.agentToUse, maxTurns })

  while (true) {
    const inactiveElapsedMs = Date.now() - inactiveStart
    if (inactiveElapsedMs >= maxPollTimeMs) {
      timedOut = true
      break
    }

    if (ctx.abort?.aborted) {
      let finalMessages: SessionMessage[] | null = null
      const abortFetchAttempts = 3
      for (let attempt = 1; attempt <= abortFetchAttempts; attempt++) {
        try {
          finalMessages = await fetchSessionMessages(client, input.sessionID)
          break
        } catch (error) {
          const errorMessage = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
          log("[task] Final messages fetch failed after abort, retrying", {
            sessionID: input.sessionID,
            attempt,
            maxAttempts: abortFetchAttempts,
            error: errorMessage,
          })
          if (attempt < abortFetchAttempts) {
            await wait(syncTiming.POLL_INTERVAL_MS)
          }
        }
      }

      if (finalMessages) {
        const hasNewMessages = hasMessagesAfterAnchor(
          finalMessages,
          input.anchorMessageID,
          input.anchorMessageCount,
        )
        if (hasNewMessages && isSessionComplete(finalMessages)) {
          log("[task] Abort detected after session already completed", { sessionID: input.sessionID })
          return null
        }
      }

      log("[task] Aborted by user", { sessionID: input.sessionID })
      abortSyncSession(client, input.sessionID, "parent_abort")
      if (input.toastManager && input.taskId) input.toastManager.removeTask(input.taskId)
      return `Task aborted.\n\nSession ID: ${input.sessionID}`
    }

    await wait(syncTiming.POLL_INTERVAL_MS)
    pollCount++

    let sessionStatus: ({ type: string; updatedAt?: string | number; revision?: string | number; messageCount?: number } & Record<string, unknown>) | undefined
    try {
      const statusResult = await client.session.status()
      const allStatuses = normalizeSDKResponse(statusResult, {} as Record<string, { type: string }>)
      sessionStatus = allStatuses[input.sessionID] as typeof sessionStatus

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      log("[task] Poll status fetch failed, checking messages", { sessionID: input.sessionID, error: errorMessage })
    }

    if (pollCount % 10 === 0) {
      log("[task] Poll status", {
        sessionID: input.sessionID,
        pollCount,
        elapsed: Math.floor((Date.now() - pollStart) / 1000) + "s",
        inactiveElapsed: Math.floor(inactiveElapsedMs / 1000) + "s",
        sessionStatus: sessionStatus?.type ?? "not_in_status",
      })
    }

    const isActive = isActiveSessionStatus(sessionStatus)
    const statusRevision = sessionStatus && (sessionStatus.updatedAt ?? sessionStatus.revision ?? sessionStatus.messageCount ?? sessionStatus.type)
    const statusChanged = statusRevision !== undefined && String(statusRevision) !== lastStatusRevision
    if (statusChanged) inactiveStart = Date.now()

    // Fail fast on a dead child: idle status with no new messages for a full
    // minute means the subagent errored without producing a response (provider
    // quota, unavailable model). Waiting out the 30-minute inactivity bound
    // just leaves the parent staring at a spinner. Owed child continuations
    // are exempt: a wake may still land and move the messages forward.
    const continuationOwed =
      (input.hasActiveChildBackgroundTasks?.(input.sessionID) ?? false) ||
      (input.hasPendingParentWake?.(input.sessionID) ?? false)
    continuationOwedThisPoll = continuationOwed
    if (isActive || statusChanged || continuationOwed) {
      idleNoProgressPolls = 0
    } else {
      idleNoProgressPolls++
      if (idleNoProgressPolls >= MAX_IDLE_NO_PROGRESS_POLLS) {
        log("[task] Poll no-progress timeout reached", { sessionID: input.sessionID, pollCount })
        abortSyncSession(client, input.sessionID, "no_progress")
        if (input.toastManager && input.taskId) input.toastManager.removeTask(input.taskId)
        return `${STALL_ERROR_PREFIX} subagent session ${input.sessionID} was idle for ${idleNoProgressPolls} polls with no new messages. The child likely failed (provider quota or unavailable model) without producing a response. Session ID: ${input.sessionID}`
      }
    }

    // An active status (busy/retry/running) is not progress by itself: a child that hit a
    // terminal provider error can sit in "busy" forever with an unchanged message set.
    // Keep inspecting messages on the same staleness cadence so the error surfaces and the
    // inactivity timer only resets on observable change.
    nonActivePollsSinceMessageFetch++
    if (hasFetchedNonActiveMessages && !statusChanged && nonActivePollsSinceMessageFetch < MAX_NON_ACTIVE_STATUS_STALENESS_POLLS) {
      continue
    }
    lastStatusRevision = statusRevision === undefined ? lastStatusRevision : String(statusRevision)
    nonActivePollsSinceMessageFetch = 0
    hasFetchedNonActiveMessages = true

    let messages: SessionMessage[]
    try {
      messages = await fetchSessionMessages(client, input.sessionID)
    } catch (error) {
      const errorMessage = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
      log("[task] Poll messages fetch failed, retrying", { sessionID: input.sessionID, error: errorMessage })
      continue
    }

    if (!hasMessagesAfterAnchor(messages, input.anchorMessageID, input.anchorMessageCount)) continue

    // Goal contract beats heuristics: an explicit done keyword from the child
    // completes the wait even when turn-shape checks would keep polling. The
    // keyword means the agent itself considers the objective met.
    if (hasGoalKeywordInLatest(messages, input.anchorMessageID, input.anchorMessageCount)) {
      log("[task] Poll complete - goal keyword detected", { sessionID: input.sessionID, pollCount })
      break
    }

    const currentAssistantId = [...messages].reverse().find((m) => m.info?.role === "assistant")?.info?.id
    const messageStateChanged =
      lastObservedMessageCount !== undefined &&
      (messages.length !== lastObservedMessageCount || currentAssistantId !== lastObservedAssistantId)
    lastObservedMessageCount = messages.length
    lastObservedAssistantId = currentAssistantId
    // Text growth counts as progress too: a slowly streaming answer keeps the
    // same message ids while its content grows. Without this, the no-progress
    // counter would fire on a live stream and abort a healthy turn.
    const currentTextLength = totalMessageTextLength(messages)
    const textLengthChanged = lastTextLength !== undefined && currentTextLength !== lastTextLength
    lastTextLength = currentTextLength
    if (messageStateChanged) {
      inactiveStart = Date.now()
      idleNoProgressPolls = 0
    } else if (textLengthChanged) {
      // Stream growth suppresses only the fail-fast counter, never the outer
      // inactivity bound: a stream that grows forever without completing must
      // still hit the poll timeout instead of spinning indefinitely.
      idleNoProgressPolls = 0
    }

    const sessionError = getTerminalSessionError(messages)
    if (sessionError) {
      log("[task] Poll detected terminal session error", { sessionID: input.sessionID, sessionError })
      return sessionError
    }

    // Completion is only judged once the session has left its active status; a busy child
    // whose last assistant turn merely looks finished is still working.
    if (!isActive && isSessionComplete(messages)) {
      if (isAwaitingChildContinuation(currentAssistantId)) {
        continue
      }
      log("[task] Poll complete - terminal finish detected", { sessionID: input.sessionID, pollCount })
      break
    }

    // Count new assistant turns to circuit-break infinite loops. This runs while the status
    // is still active too: a child looping through tool calls never leaves "busy", and every
    // new turn resets the inactivity timer above, so the turn budget is its only bound.
    const lastAssistant = [...messages].reverse().find((m) => m.info?.role === "assistant")
    if (lastAssistant?.info?.id && lastAssistant.info.id !== lastSeenAssistantId) {
      lastSeenAssistantId = lastAssistant.info.id
      assistantTurnCount++
      if (assistantTurnCount >= maxTurns) {
        log("[task] Max assistant turns reached, aborting to prevent infinite loop", {
          sessionID: input.sessionID,
          assistantTurnCount,
          maxTurns,
        })
        abortSyncSession(client, input.sessionID, "max_turns_exceeded")
        if (input.toastManager && input.taskId) input.toastManager.removeTask(input.taskId)
        return `Task aborted: subagent exceeded ${maxTurns} assistant turns without completing. This usually indicates an infinite tool-call loop. Session ID: ${input.sessionID}`
      }
    }

    if (isActive) continue

    const hasAssistantText = messages.some((m) => {
      if (m.info?.role !== "assistant") return false
      const parts = m.parts ?? []
      return parts.some((p) => {
        if (p.type !== "text" && p.type !== "reasoning") return false
        const text = (p.text ?? "").trim()
        return text.length > 0
      })
    })

    if (!lastAssistant?.info?.finish && hasAssistantText) {
      if (isAwaitingChildContinuation(lastAssistant?.info?.id)) {
        continue
      }
      log("[task] Poll complete - assistant text detected (fallback)", {
        sessionID: input.sessionID,
        pollCount,
      })
      break
    }
  }

  if (timedOut) {
    log("[task] Poll inactivity timeout reached", { sessionID: input.sessionID, pollCount })
    abortSyncSession(client, input.sessionID, "poll_timeout")
  }

  return timedOut
    ? `Poll inactivity timeout reached after ${maxPollTimeMs}ms without active OpenCode status for session ${input.sessionID}`
    : null
}
