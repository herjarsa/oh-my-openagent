import { buildTaskPrompt } from "./prompt-builder"
import type { DelegateTaskArgs } from "./types"
import type { SessionMessage } from "./executor-types"

/**
 * Completion keyword a goal-supervised child ends its final message with.
 * Explicit contract beats turn-shape heuristics: when the child says it is
 * done, the parent takes the result immediately instead of polling on.
 */
export const CHILD_DONE_KEYWORD = "[TASK_DONE]"

/**
 * Prefix of the fail-fast stall error. Single source shared with the sync
 * poller so the runner can recognize a dead child without string drift.
 */
export const STALL_ERROR_PREFIX = "Task stalled:"

/**
 * Same-session resume budget after a stall. Two nudges are enough to shake a
 * wedged child loose; beyond that the parent gets the stall error. Together
 * with maxTurns and the poll inactivity bound this guarantees no loop runs
 * forever: every resume path is counted and capped.
 */
export const MAX_CHILD_GOAL_RESUMES = 2

const CHILD_GOAL_APPEND = `

When your task is fully complete, end your final message with ${CHILD_DONE_KEYWORD} on its own line and nothing after it.`

/**
 * Task prompt plus the goal contract. Keeps buildTaskPrompt untouched so its
 * identity contract for non-plan agents (pinned by tools.test.ts) holds.
 */
export function buildGoalSupervisedPrompt(
  prompt: string,
  agentName: string | undefined,
  tddEnabled?: boolean,
): string {
  return `${buildTaskPrompt(prompt, agentName, tddEnabled)}${CHILD_GOAL_APPEND}`
}

function assistantTextOf(msg: SessionMessage): string {
  return (msg.parts ?? [])
    .filter((p) => p.type === "text" || p.type === "reasoning")
    .map((p) => p.text ?? "")
    .filter((text) => text.length > 0)
    .join("\n")
}

/**
 * True when the newest assistant turn after the anchor carries the completion
 * keyword. Scoped to post-anchor messages so an old keyword from a previous
 * turn cannot complete a fresh wait.
 */
export function hasGoalKeywordInLatest(
  messages: readonly SessionMessage[],
  anchorMessageID?: string,
  anchorMessageCount?: number,
): boolean {
  let scoped: readonly SessionMessage[]
  if (anchorMessageID !== undefined) {
    const anchorIndex = messages.findIndex((message) => message.info?.id === anchorMessageID)
    scoped = anchorIndex === -1 ? messages : messages.slice(anchorIndex + 1)
  } else if (anchorMessageCount !== undefined) {
    scoped = messages.slice(anchorMessageCount)
  } else {
    scoped = messages
  }
  for (let i = scoped.length - 1; i >= 0; i--) {
    const msg = scoped[i]
    if (msg?.info?.role !== "assistant") continue
    const text = assistantTextOf(msg)
    if (!text) continue
    return text.includes(CHILD_DONE_KEYWORD)
  }
  return false
}

/**
 * Remove keyword marker lines from delivered text so the parent sees a clean
 * result instead of protocol noise.
 */
export function stripGoalKeyword(text: string): string {
  if (!text.includes(CHILD_DONE_KEYWORD)) return text
  return text
    .split("\n")
    .filter((line) => !line.includes(CHILD_DONE_KEYWORD))
    .join("\n")
    .trim()
}

export function isStallPollError(pollError: string): boolean {
  return pollError.startsWith(STALL_ERROR_PREFIX)
}

/**
 * A stalled child (idle, no message progress) is worth one same-session nudge:
 * re-prompting often shakes loose a wedged turn without losing context. Other
 * errors keep their existing paths (abort recovery, model fallback); only the
 * stall case with remaining budget resumes here.
 */
export function shouldAutoResumeChild(pollError: string, resumesUsed: number): boolean {
  return resumesUsed < MAX_CHILD_GOAL_RESUMES && isStallPollError(pollError)
}

/**
 * Short continuation nudge for a stalled child. Re-sends the goal, not the
 * full original prompt: the session already holds the task context.
 */
export function buildChildResumeNudge(args: Pick<DelegateTaskArgs, "description">): string {
  return `Continue working on the task described as "${args.description}". If you already finished, reply now with your final answer. When fully done, end your final message with ${CHILD_DONE_KEYWORD} on its own line and nothing after it.`
}
