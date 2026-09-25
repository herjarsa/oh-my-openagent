import { describe, expect, it } from "bun:test"
import { registerBuiltinMcps } from "./mcp-bridge-register"

describe("registerBuiltinMcps", () => {
  it("#given all builtin disabled #when registered #then nothing lands on the editor", () => {
    // given
    const set: Array<{ name: string; config: Record<string, unknown> }> = []

    // when
    const result = registerBuiltinMcps(
      { set: (name, config) => void set.push({ name, config }) },
      { disabledMcps: ["websearch", "context7", "grep_app", "lsp"] },
    )

    // then
    expect(result.registered).toEqual([])
    expect(set).toEqual([])
  })

  it("#given remotes enabled #when registered #then shapes translate with disabled flags", () => {
    // given
    const set: Array<{ name: string; config: Record<string, unknown> }> = []

    // when
    const result = registerBuiltinMcps(
      { set: (name, config) => void set.push({ name, config }) },
      { disabledMcps: ["websearch", "lsp"] },
    )

    // then
    const names = result.registered.sort()
    expect(names).toEqual(["context7", "grep_app"])
    const context7 = set.find(({ name }) => name === "context7")?.config
    expect(context7).toMatchObject({ type: "remote", url: "https://mcp.context7.com/mcp" })
    expect(context7?.["disabled"]).toBeUndefined()
  })
})
