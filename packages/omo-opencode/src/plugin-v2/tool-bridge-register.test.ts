import { describe, expect, it } from "bun:test"
import { tool as v1ToolFactory } from "@opencode-ai/plugin/tool"
import { convertArgsToJsonSchema, registerV1Tools, type V2ToolDefinition } from "./tool-bridge-register"

describe("convertArgsToJsonSchema", () => {
  it("#given a zod raw shape #when converted #then properties and required map over", () => {
    // when
    const schema = convertArgsToJsonSchema({
      pattern: v1ToolFactory.schema.string().describe("regex"),
      include: v1ToolFactory.schema.string().optional(),
    })

    // then
    expect(schema["type"]).toBe("object")
    expect(schema["$schema"]).toBeUndefined()
    const properties = schema["properties"] as Record<string, unknown>
    expect(Object.keys(properties).sort()).toEqual(["include", "pattern"])
    expect(schema["required"]).toEqual(["pattern"])
  })

  it("#given a broken shape #when converted #then it falls back without throwing", () => {
    // when
    const schema = convertArgsToJsonSchema(null)

    // then
    expect(schema["type"]).toBe("object")
  })
})

describe("registerV1Tools", () => {
  it("#given V1 definitions #when registered #then they land on the editor with adapted execute", async () => {
    // given
    const added: V2ToolDefinition[] = []
    const tools = {
      echo: v1ToolFactory({
        description: "echo",
        args: { text: v1ToolFactory.schema.string() },
        execute: async (args) => `got:${args.text}`,
      }),
    }

    // when
    const result = registerV1Tools({ add: (tool) => void added.push(tool) }, tools, { directory: "C:\\x" })

    // then
    expect(result).toEqual({ registered: ["echo"], failed: [] })
    expect(added[0]?.input).toMatchObject({ type: "object" })
    const out = (await added[0]?.execute({ text: "hi" }, { sessionID: "ses-1" })) as { content: string }
    expect(out.content).toBe("got:hi")
  })

  it("#given a throwing execute #when run #then it surfaces as error content", async () => {
    // given
    const added: V2ToolDefinition[] = []
    const tools = {
      boom: v1ToolFactory({
        description: "boom",
        args: {},
        execute: async () => {
          throw new Error("kaput")
        },
      }),
    }
    registerV1Tools({ add: (tool) => void added.push(tool) }, tools, { directory: "C:\\x" })

    // when
    const out = (await added[0]?.execute({}, {})) as { content: string; metadata: { error: boolean } }

    // then
    expect(out.content).toContain("kaput")
    expect(out.metadata.error).toBe(true)
  })
})
