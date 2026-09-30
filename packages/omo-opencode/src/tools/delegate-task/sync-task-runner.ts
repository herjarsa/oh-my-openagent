import type { TaskToastManager } from "../../features/task-toast-manager/manager"
import type { ModelFallbackInfo } from "../../features/task-toast-manager/types"
import type { ModelFallbackState } from "../../hooks/model-fallback/hook"
import type { FallbackEntry } from "../../shared/model-requirements"
import { shouldRetryError } from "../../shared/model-error-classifier"
import { releasePromptAsyncReservation } from "../../shared/prompt-async-gate"
import { log } from "../../shared/logger"
import { buildChildResumeNudge, isCleanSendMiss, sendRetryDelayMs, shouldAutoResumeChild, shouldRetrySendAfterDelay, sleep } from "./child-goal"
import { getDeliverableTag } from "./constants"
import type { ExecutorContext, ParentContext } from "./executor-types"
import { buildRecoveredSyncTaskCompletion, buildSyncTaskCompletion } from "./sync-completion-message"
import { shouldAttemptPollErrorRecovery } from "./sync-poll-error-recovery"
import type { SyncTaskDeps } from "./sync-task-deps"
import { getNextSyncFallbackModel, retrySyncPromptWithFallbacks } from "./sync-task-fallback"
import type { DelegatedModelConfig, DelegateTaskArgs, ToolContextWithMetadata } from "./types"

type SyncTaskRunnerInput = {
  readonly args: DelegateTaskArgs
  readonly ctx: ToolContextWithMetadata
  readonly executorCtx: ExecutorContext
  readonly parentContext: ParentContext
  readonly agentToUse: string
  readonly categoryModel: DelegatedModelConfig | undefined
  readonly fallbackChain: FallbackEntry[] | undefined
  readonly deps: SyncTaskDeps
  readonly sessionID: string
  readonly spawnDepth: number
  readonly taskId: string
  readonly startTime: Date
  readonly syncPollTimeoutMs: number | undefined
  readonly systemContent: string | undefined
  readonly toastManager: TaskToastManager | undefined
  readonly modelInfo: ModelFallbackInfo | undefined
  readonly registerSyncSession: (newSessionID: string) => Promise<void>
  readonly publishSyncMetadata: (
    currentSessionID: string,
    currentModel: DelegatedModelConfig | undefined,
    spawnDepth: number,
  ) => Promise<void>
  readonly cleanupRetrySession: (currentSessionID: string) => void
  readonly setSyncSessionID: (currentSessionID: string) => void
}

function addRetryTaskToast(input: {
  readonly args: DelegateTaskArgs
  readonly agentToUse: string
  readonly sessionID: string
  readonly taskId: string
  readonly toastManager: TaskToastManager | undefined
  readonly modelInfo: ModelFallbackInfo | undefined
}): void {
  if (!input.toastManager) return
  input.toastManager.addTask({
    id: input.taskId,
    sessionID: input.sessionID,
    description: input.args.description,
    agent: input.agentToUse,
    isBackground: false,
    category: input.args.category,
    skills: input.args.load_skills,
    modelInfo: input.modelInfo,
  })
}

function shouldRetryPollErrorWithFallback(pollError: string, deps: SyncTaskDeps): boolean {
  const errorInfo = { message: pollError }
  return shouldRetryError(errorInfo) || (deps.isProviderExhaustionFallbackEligible?.(errorInfo) ?? false)
}

export async function runSyncTaskLoop(input: SyncTaskRunnerInput): Promise<string> {
  const {
    args,
    ctx,
    executorCtx,
    parentContext,
    agentToUse,
    fallbackChain,
    deps,
    spawnDepth,
    taskId,
    startTime,
    syncPollTimeoutMs,
    systemContent,
    toastManager,
    modelInfo,
    registerSyncSession,
    publishSyncMetadata,
    cleanupRetrySession,
    setSyncSessionID,
  } = input
  const { client, directory, sisyphusAgentConfig } = executorCtx
  const hasActiveChildBackgroundTasks = executorCtx.manager?.hasActiveChildTasks?.bind(executorCtx.manager)
  const hasPendingParentWake = executorCtx.manager?.hasPendingParentWake?.bind(executorCtx.manager)
  const deliverableTag = getDeliverableTag(agentToUse)
  let effectiveCategoryModel = input.categoryModel
  let fallbackState: ModelFallbackState | undefined = effectiveCategoryModel && fallbackChain?.length
    ? {
        providerID: effectiveCategoryModel.providerID,
        modelID: effectiveCategoryModel.modelID,
        fallbackChain,
        attemptCount: 0,
        pending: true,
      }
    : undefined
  let activeSessionID = input.sessionID
  let currentArgs = args
  let goalResumesUsed = 0
  let sendRetriesUsed = 0
  const sleepFn = deps.sleep ?? sleep

  while (true) {
    let promptError = await deps.sendSyncPrompt(client, {
      sessionID: activeSessionID,
      agentToUse,
      args: currentArgs,
      systemContent,
      directory,
      toastManager,
      taskId,
      sisyphusAgentConfig,
      categoryModel: effectiveCategoryModel,
    })
    if (promptError) {
      // Transient send failure (host busy, gate deferral, turn stopped): wait
      // and resend the same prompt in the same session instead of killing the
      // child. Same prompt, same model, context preserved. Budget is per task.
      while (shouldRetrySendAfterDelay(promptError, sendRetriesUsed)) {
        const delayMs = sendRetryDelayMs(sendRetriesUsed)
        sendRetriesUsed++
        log("[task] Transient send failure, retrying in same session", { sessionID: activeSessionID, agentToUse, delayMs, attempt: sendRetriesUsed })
        if (isCleanSendMiss(promptError)) {
          // The reservation is owned by "model-suggestion-retry" (the dispatch that just
          // failed cleanly), so a plain release would be rejected as a source
          // mismatch. supersedeTransientRetryOwners exists for exactly this recovery.
          releasePromptAsyncReservation(activeSessionID, "transient-send-retry", { supersedeTransientRetryOwners: true })
        }
        await sleepFn(delayMs)
        promptError = await deps.sendSyncPrompt(client, {
          sessionID: activeSessionID,
          agentToUse,
          args: currentArgs,
          systemContent,
          directory,
          toastManager,
          taskId,
          sisyphusAgentConfig,
          categoryModel: effectiveCategoryModel,
        })
        if (!promptError) break
      }
      // Resend landed: promptError is null, fall through to polling the revived turn.
      if (promptError) {
      const promptResult = await retrySyncPromptWithFallbacks({
        sessionID: activeSessionID,
        initialError: promptError,
        categoryModel: effectiveCategoryModel,
        fallbackChain,
        sendPrompt: async (fallbackModel) => {
          return deps.sendSyncPrompt(client, {
            sessionID: activeSessionID,
            agentToUse,
            args: currentArgs,
            systemContent,
            directory,
            toastManager,
            taskId,
            sisyphusAgentConfig,
            categoryModel: fallbackModel,
          })
        },
      })

      promptError = promptResult.promptError
      effectiveCategoryModel = promptResult.categoryModel
      fallbackState = promptResult.fallbackState ?? fallbackState

      if (promptError) {
        return promptError
      }
      }
    }

    const pollError = await deps.pollSyncSession(ctx, client, {
      sessionID: activeSessionID,
      agentToUse,
      toastManager,
      taskId,
      hasActiveChildBackgroundTasks,
      hasPendingParentWake,
    }, syncPollTimeoutMs)
    if (pollError) {
      // Goal supervision: a stalled child gets a same-session resume nudge (context
      // preserved) within budget instead of failing the parent immediately. The
      // nudge restates the goal keyword so the resumed turn can complete cleanly.
      if (shouldAutoResumeChild(pollError, goalResumesUsed)) {
        goalResumesUsed++
        log("[task] Auto-resuming stalled child session", { sessionID: activeSessionID, agentToUse, resume: goalResumesUsed })
        currentArgs = { ...args, prompt: buildChildResumeNudge(args) }
        continue
      }
      if (shouldAttemptPollErrorRecovery(pollError)) {
        const recoveredResult = await deps.fetchSyncResult(client, activeSessionID, undefined, {
          strictAbortRecovery: true,
          deliverableTag,
        })
        if (recoveredResult.ok) {
          return buildRecoveredSyncTaskCompletion({
            activeSessionID,
            agentToUse,
            args,
            effectiveCategoryModel,
            parentContext,
            startTime,
            textContent: recoveredResult.textContent,
          })
        }
      }

      const nextFallbackModel = shouldRetryPollErrorWithFallback(pollError, deps)
        ? getNextSyncFallbackModel(activeSessionID, fallbackState)
        : null
      if (!nextFallbackModel) {
        return pollError
      }

      cleanupRetrySession(activeSessionID)

      const retrySessionResult = await deps.createSyncSession(client, {
        parentSessionID: parentContext.sessionID,
        agentToUse,
        description: args.description,
        defaultDirectory: directory,
        categoryModel: nextFallbackModel,
      })
      if (!retrySessionResult.ok) {
        return retrySessionResult.error
      }

      activeSessionID = retrySessionResult.sessionID
      setSyncSessionID(activeSessionID)
      effectiveCategoryModel = nextFallbackModel
      await registerSyncSession(activeSessionID)
      addRetryTaskToast({
        args,
        agentToUse,
        sessionID: activeSessionID,
        taskId,
        toastManager,
        modelInfo,
      })
      await publishSyncMetadata(activeSessionID, effectiveCategoryModel, spawnDepth)
      continue
    }

    const result = await deps.fetchSyncResult(client, activeSessionID, undefined, { deliverableTag })
    if (!result.ok) {
      return result.error
    }

    await publishSyncMetadata(activeSessionID, effectiveCategoryModel, spawnDepth)

    return buildSyncTaskCompletion({
      activeSessionID,
      agentToUse,
      args,
      effectiveCategoryModel,
      parentContext,
      startTime,
      textContent: result.textContent,
    })
  }
}
