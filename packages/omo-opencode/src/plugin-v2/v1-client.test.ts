import { describe, expect, it } from "bun:test"
import { createV1ClientAdapter } from "./v1-client"

type SessionAdapter = {
  get: (input: unknown) => Promise<unknown>
  messages: (input: unknown) => Promise<unknown>
  prompt: (input: unknown) => Promise<unknown>
  promptAsync: (input: unknown) => Promise<unknown>
  todo: (input: unknown) => Promise<unknown>
  status: (input?: unknown) => Promise<unknown>
  abort: (input: unknown) => Promise<unknown>
  create: (input: unknown) => Promise<unknown>
}

function adapterWith(session: Record<string, unknown>, event?: Record<string, unknown>): SessionAdapter {
  const client = createV1ClientAdapter({ session, ...(event === undefined ? {} : { event }) } as never) as {
    session: SessionAdapter
  }
  return client.session
}

async function waitForStatus(
  session: SessionAdapter,
  sessionID: string,
  timeoutMs = 2000,
): Promise<Record<string, { type: string }>> {
  const started = Date.now()
  for (;;) {
    const res = (await session.status()) as { data: Record<string, { type: string }> }
    if (res.data[sessionID] !== undefined) return res.data
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for status of ${sessionID}`)
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
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

  it("#given a V1 prompt with agent #when adapted #then it switches agent before prompting", async () => {
    // given
    const calls: unknown[] = []
    const session = adapterWith({
      switchAgent: async (input: unknown) => {
        calls.push(["switchAgent", input])
      },
      prompt: async (input: unknown) => {
        calls.push(["prompt", input])
        return { id: "msg-2", sessionID: "ses-1" }
      },
    })

    // when
    const res = await session.promptAsync({
      path: { id: "ses-1" },
      body: { agent: "oracle", parts: [{ type: "text", text: "hi" }] },
    })

    // then
    expect(calls).toEqual([
      ["switchAgent", { sessionID: "ses-1", agent: "oracle" }],
      ["prompt", { sessionID: "ses-1", text: "hi" }],
    ])
    expect(res).toEqual({ data: { info: { id: "msg-2" } } })
  })

  it("#given a V1 prompt with model #when adapted #then it switches model with V2 ref shape", async () => {
    // given
    const calls: unknown[] = []
    const session = adapterWith({
      switchModel: async (input: unknown) => {
        calls.push(input)
      },
      prompt: async (input: unknown) => {
        calls.push(input)
        return { id: "msg-3", sessionID: "ses-1" }
      },
    })

    // when
    await session.promptAsync({
      path: { id: "ses-1" },
      body: { model: { providerID: "p", modelID: "m" }, parts: [{ type: "text", text: "hi" }] },
    })

    // then
    expect(calls).toEqual([
      { sessionID: "ses-1", model: { id: "m", providerID: "p" } },
      { sessionID: "ses-1", text: "hi" },
    ])
  })

  it("#given a V2 prompt throw #when prompt runs #then it resolves null without throwing", async () => {
    // given
    const session = adapterWith({
      prompt: async () => {
        throw new Error("boom-prompt")
      },
    })

    // when
    const res = await session.promptAsync({ path: { id: "ses-1" }, body: { parts: [{ type: "text", text: "hi" }] } })

    // then
    expect(res).toBeNull()
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

  it("#given V1 create input with agent #when adapted #then agent is forwarded to V2", async () => {
    // given
    const calls: unknown[] = []
    const session = adapterWith({
      create: async (input: unknown) => {
        calls.push(input)
        return { id: "ses-1", location: { directory: "/repo" } }
      },
    })

    // when
    await session.create({
      body: { parentID: "ses-parent", title: "task (@oracle subagent)", agent: "oracle" },
      query: { directory: "/repo" },
    })

    // then
    expect(calls).toEqual([
      { title: "task (@oracle subagent)", agent: "oracle", location: { directory: "/repo" }, metadata: { parentID: "ses-parent" } },
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

  it("#given V2 active sessions #when status runs #then it maps to the V1 status table", async () => {
    // given
    const session = adapterWith({
      active: async () => ({ "ses-busy": { type: "running" } }),
    })

    // when
    const res = await session.status()

    // then
    expect(res).toEqual({ data: { "ses-busy": { type: "running" } } })
  })

  it("#given no V2 active #when status runs #then it resolves to an empty table without throwing", async () => {
    // given
    const session = adapterWith({})

    // when
    const res = await session.status()

    // then
    expect(res).toEqual({ data: {} })
  })

  it("#given a V2 active throw #when status runs #then it resolves to an empty table", async () => {
    // given
    const session = adapterWith({
      active: async () => {
        throw new Error("boom-active")
      },
    })

    // when
    const res = await session.status()

    // then
    expect(res).toEqual({ data: {} })
  })

  it("#given V2 session status events #when status runs #then it maps busy retry and idle", async () => {
    // given
    async function* events(): AsyncIterable<unknown> {
      yield { type: "session.status", data: { sessionID: "ses-busy", status: { type: "busy" } } }
      yield { type: "session.status", data: { sessionID: "ses-retry", status: { type: "retry", attempt: 2 } } }
      yield { type: "session.idle", data: { sessionID: "ses-idle" } }
    }
    const session = adapterWith({}, { subscribe: () => events() })

    // when
    const busy = await waitForStatus(session, "ses-busy")
    const retry = await waitForStatus(session, "ses-retry")
    const idle = await waitForStatus(session, "ses-idle")

    // then
    expect(busy["ses-busy"]).toMatchObject({ type: "busy" })
    expect(retry["ses-retry"]).toMatchObject({ type: "retry" })
    expect(idle["ses-idle"]).toEqual({ type: "idle" })
  })

  it("#given V2 execution lifecycle events #when status runs #then started is busy and terminal is idle", async () => {
    // given
    async function* events(): AsyncIterable<unknown> {
      yield { type: "session.execution.started", data: { sessionID: "ses-run" } }
      yield { type: "session.execution.succeeded", data: { sessionID: "ses-done" } }
    }
    const session = adapterWith({}, { subscribe: () => events() })

    // when
    const run = await waitForStatus(session, "ses-run")
    const done = await waitForStatus(session, "ses-done")

    // then
    expect(run["ses-run"]).toEqual({ type: "busy" })
    expect(done["ses-done"]).toEqual({ type: "idle" })
  })

  it("#given events and active disagree #when status runs #then the event transition wins", async () => {
    // given
    async function* events(): AsyncIterable<unknown> {
      yield { type: "session.idle", data: { sessionID: "ses-1" } }
    }
    const session = adapterWith(
      { active: async () => ({ "ses-1": { type: "running" } }) },
      { subscribe: () => events() },
    )

    // when
    const started = Date.now()
    let data: Record<string, { type: string }> = {}
    for (;;) {
      data = await waitForStatus(session, "ses-1")
      if (data["ses-1"]?.type === "idle" || Date.now() - started > 2000) break
      await new Promise((resolve) => setTimeout(resolve, 5))
    }

    // then
    expect(data["ses-1"]).toEqual({ type: "idle" })
  })

  it("#given sessions without confirmed state #when status runs #then they stay absent", async () => {
    // given
    async function* events(): AsyncIterable<unknown> {
      yield { type: "session.idle", data: { sessionID: "ses-known" } }
    }
    const session = adapterWith({}, { subscribe: () => events() })
    await waitForStatus(session, "ses-known")

    // when
    const res = (await session.status()) as { data: Record<string, unknown> }

    // then
    expect(res.data["ses-unknown"]).toBeUndefined()
  })

  it("#given V2 user and assistant messages #when adapted #then role finish and parts map to V1", async () => {
    // given
    const session = adapterWith({
      context: async () => [
        { id: "m1", type: "user", text: "do the thing" },
        { id: "m2", type: "assistant", agent: "oracle", content: [{ type: "text", text: "done" }], finish: "stop" },
      ],
    })

    // when
    const res = (await session.messages({ path: { id: "ses-9" } })) as {
      data: { info: { id: string; role: string; finish?: string }; parts: unknown[] }[]
    }

    // then
    expect(res.data[0]?.info).toMatchObject({ id: "m1", role: "user" })
    expect(res.data[0]?.parts).toEqual([{ type: "text", text: "do the thing" }])
    expect(res.data[1]?.info).toMatchObject({ id: "m2", role: "assistant", finish: "stop" })
    expect(res.data[1]?.parts).toEqual([{ type: "text", text: "done" }])
  })

  it("#given V1 abort #when adapted #then it interrupts the V2 session", async () => {
    // given
    const calls: unknown[] = []
    const session = adapterWith({
      interrupt: async (input: unknown) => {
        calls.push(input)
      },
    })

    // when
    const res = await session.abort({ path: { id: "ses-1" } })

    // then
    expect(calls).toEqual([{ sessionID: "ses-1" }])
    expect(res).toEqual({ data: true })
  })

  it("#given no V2 interrupt #when abort runs #then it resolves to an error envelope", async () => {
    // given
    const session = adapterWith({})

    // when
    const res = await session.abort({ path: { id: "ses-1" } })

    // then
    expect(res).toEqual({ data: undefined, error: "session.interrupt unavailable on V2 host" })
  })

  it("#given V2 SessionInfo #when get runs #then location directory surfaces as V1 directory", async () => {
    // given
    const session = adapterWith({
      get: async () => ({ id: "ses-1", location: { directory: "/repo" } }),
    })

    // when
    const res = (await session.get({ path: { id: "ses-1" } })) as { data: { directory: string } }

    // then
    expect(res.data.directory).toBe("/repo")
  })
})
