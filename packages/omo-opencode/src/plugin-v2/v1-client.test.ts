import { describe, expect, it } from "bun:test"
import { createV1ClientAdapter } from "./v1-client"

type SessionAdapter = {
  get: (input: unknown) => Promise<unknown>
  messages: (input: unknown) => Promise<unknown>
  prompt: (input: unknown) => Promise<unknown>
  promptAsync: (input: unknown) => Promise<unknown>
  todo: (input: unknown) => Promise<unknown>
  create: (input: unknown) => Promise<unknown>
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

  it("#given a V2 SessionInfo #when create succeeds #then it maps to the V1 envelope with id and directory", async () => {
    // given
    const session = adapterWith({
      create: async () => ({ id: "ses-new", title: "sub", location: { directory: "/repo" } }),
    })

    // when
    const res = (await session.create({
      body: { parentID: "ses-parent", title: "sub" },
      query: { directory: "/repo" },
    })) as { data: { id: string; directory: string } }

    // then
    expect(res.data.id).toBe("ses-new")
    expect(res.data.directory).toBe("/repo")
  })

  it("#given a wrapped V2 create result #when create succeeds #then it unwraps to the session id", async () => {
    // given
    const session = adapterWith({
      create: async () => ({ data: { id: "ses-wrapped", location: { directory: "/w" } } }),
    })

    // when
    const res = (await session.create({ body: { title: "t" }, query: { directory: "/w" } })) as {
      data: { id: string; directory: string }
    }

    // then
    expect(res.data.id).toBe("ses-wrapped")
    expect(res.data.directory).toBe("/w")
  })

  it("#given V1 create input #when adapted #then parentID title model and directory are forwarded to V2", async () => {
    // given
    const calls: unknown[] = []
    const session = adapterWith({
      create: async (input: unknown) => {
        calls.push(input)
        return { id: "ses-1", location: { directory: "/repo" } }
      },
    })
    const model = { id: "m", providerID: "p" }

    // when
    await session.create({
      body: { parentID: "ses-parent", title: "task (@explore subagent)", permission: [{ permission: "q" }], model },
      query: { directory: "/repo" },
    })

    // then
    expect(calls).toEqual([
      { title: "task (@explore subagent)", model, location: { directory: "/repo" }, metadata: { parentID: "ses-parent" } },
    ])
  })

  it("#given a V2 create throw #when create runs #then it resolves to an error envelope", async () => {
    // given
    const session = adapterWith({
      create: async () => {
        throw new Error("boom-create")
      },
    })

    // when
    const res = await session.create({ body: { title: "t" }, query: { directory: "/repo" } })

    // then
    expect(res).toEqual({ data: undefined, error: "boom-create" })
  })

  it("#given no V2 create #when create runs #then it resolves to an unavailable error envelope", async () => {
    // given
    const session = adapterWith({})

    // when
    const res = await session.create({ body: { title: "t" }, query: {} })

    // then
    expect(res).toEqual({ data: undefined, error: "session.create unavailable on V2 host" })
  })
})
