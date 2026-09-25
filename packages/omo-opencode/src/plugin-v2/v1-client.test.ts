import { describe, expect, it } from "bun:test"
import { createV1ClientAdapter } from "./v1-client"

type SessionAdapter = {
  get: (input: unknown) => Promise<unknown>
  messages: (input: unknown) => Promise<unknown>
  prompt: (input: unknown) => Promise<unknown>
  promptAsync: (input: unknown) => Promise<unknown>
  todo: (input: unknown) => Promise<unknown>
}

function adapterWith(session: Record<string, unknown>): SessionAdapter {
  const client = createV1ClientAdapter({ session } as never) as { session: SessionAdapter }
  return client.session
}

describe("createV1ClientAdapter", () => {
  it("#given a V1 promptAsync call #when adapted #then it dispatches flat sessionID and text", async () => {
    // given
    const calls: unknown[] = []
    const session = adapterWith({
      prompt: async (input: unknown) => {
        calls.push(input)
        return { id: "msg-1", sessionID: "ses-1" }
      },
    })

    // when
    const res = await session.promptAsync({ path: { id: "ses-1" }, body: { parts: [{ type: "text", text: "hi" }] } })

    // then
    expect(calls).toEqual([{ sessionID: "ses-1", text: "hi" }])
    expect(res).toEqual({ data: { info: { id: "msg-1" } } })
  })

  it("#given V1 messages #when adapted #then context wraps into info and parts", async () => {
    // given
    const session = adapterWith({
      context: async () => [{ id: "m1", role: "user", content: [{ type: "text", text: "hello" }] }],
    })

    // when
    const res = (await session.messages({ path: { id: "ses-9" } })) as { data: { info: { sessionID: string }; parts: unknown[] }[] }

    // then
    expect(res.data[0]?.info).toMatchObject({ sessionID: "ses-9", role: "user" })
    expect(res.data[0]?.parts).toEqual([{ type: "text", text: "hello" }])
  })

  it("#given todo without V2 equivalent #when called #then it degrades to empty without throwing", async () => {
    // given
    const session = adapterWith({})

    // when
    const res = await session.todo({ path: { id: "ses-1" } })

    // then
    expect(res).toEqual({ data: [] })
  })
})
