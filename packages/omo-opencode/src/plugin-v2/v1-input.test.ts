import { describe, expect, it } from "bun:test"
import { buildV1Input } from "./v1-input"

describe("buildV1Input", () => {
  it("#given a V2 context #when built #then directory and worktree come from location", () => {
    // given
    const ctx = { location: { directory: "C:\\proj", project: { id: "p1" } } }

    // when
    const input = buildV1Input(ctx as never, { session: {} })

    // then
    expect(input.directory).toBe("C:\\proj")
    expect((input as unknown as { worktree: string }).worktree).toBe("C:\\proj")
    expect((input as unknown as { serverUrl: unknown }).serverUrl).toBeUndefined()
  })

  it("#given no location #when built #then it falls back to cwd without throwing", () => {
    // when
    const input = buildV1Input({} as never, { session: {} })

    // then
    expect(input.directory).toBe(process.cwd())
  })
})
