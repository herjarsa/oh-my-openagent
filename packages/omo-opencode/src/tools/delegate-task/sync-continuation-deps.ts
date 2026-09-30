import { sleep } from "./child-goal"
import { pollSyncSession } from "./sync-session-poller"
import { fetchSyncResult } from "./sync-result-fetcher"

export const syncContinuationDeps = {
  pollSyncSession,
  fetchSyncResult,
  sleep,
}

export type SyncContinuationDeps = {
  readonly pollSyncSession: typeof pollSyncSession
  readonly fetchSyncResult: typeof fetchSyncResult
  readonly sleep?: (milliseconds: number) => Promise<void>
}
