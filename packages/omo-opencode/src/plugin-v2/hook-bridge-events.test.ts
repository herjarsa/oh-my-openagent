import { describe, expect, it } from "bun:test"
import { buildV1EventView } from "./hook-bridge-events"

describe("buildV1EventView", () => {
  it("#given session.idle #when translated #then sessionID lands in properties", () => {
    // when
    const view = buildV1EventView({ type: "session.idle", data: { sessionID: "ses-1" } })

    // then
    expect(view).toEqual({ type: "session.idle", properties: { sessionID: "ses-1" } })
  })

  it("#given execution.failed #when translated #then it becomes session.error with the error passed through", () => {
    // when
    const view = buildV1EventView({
      type: "session.execution.failed",
      data: { sessionID: "ses-2", error: { message: "boom", status: 500 } },
    })

    // then
    expect(view?.type).toBe("session.error")
    expect(view?.properties).toMatchObject({ sessionID: "ses-2", error: { message: "boom" } })
  })

  it("#given message content updated #when translated #then info and parts are V1-shaped", () => {
    // when
    const view = buildV1EventView({
      type: "session.message.content.updated",
      data: { sessionID: "ses-3", messageID: "msg-7", content: [{ type: "text", text: "hi" }] },
    })

    // then
    expect(view?.type).toBe("message.updated")
    expect(view?.properties).toMatchObject({
      sessionID: "ses-3",
      info: { sessionID: "ses-3", id: "msg-7" },
      parts: [{ type: "text", text: "hi" }],
    })
  })

  it("#given an unmapped type #when translated #then it returns null", () => {
    // when
    const view = buildV1EventView({ type: "session.step.streamed", data: { sessionID: "ses-4" } })

    // then
    expect(view).toBeNull()
  })
})
