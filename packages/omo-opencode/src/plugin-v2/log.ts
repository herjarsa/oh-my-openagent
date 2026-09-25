import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

/**
 * Port diagnostics log. Lives in the OS temp dir (portable — never a
 * hardcoded user path) and never touches console.* (that leaks into the TUI).
 */
export function portLogPath(): string {
  return path.join(os.tmpdir(), "omo-v2-port.log")
}

export function portLog(event: string, data: Record<string, unknown> = {}): void {
  try {
    fs.appendFileSync(portLogPath(), `${JSON.stringify({ event, ...data })}\n`)
  } catch {
    // Diagnostics must never break setup.
  }
}
