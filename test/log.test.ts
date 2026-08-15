import { Database } from "bun:sqlite"
import { describe, expect, test } from "bun:test"
import type { Event } from "../src/schema/event.js"
import { SqliteLog } from "../src/store/log.js"

describe("SqliteLog", () => {
  test("append then replay returns events in order", () => {
    const log = new SqliteLog(new Database(":memory:"))
    const e1: Event = { type: "turn", id: "a", ts: 1, sessionId: "s", goal: "g" }
    const e2: Event = { type: "done", id: "b", ts: 2, sessionId: "s", answer: "x" }
    log.append(e1)
    log.append(e2)
    expect(log.replay()).toEqual([e1, e2])
  })

  test("replaySince filters by timestamp", () => {
    const log = new SqliteLog(new Database(":memory:"))
    log.append({ type: "turn", id: "a", ts: 1, sessionId: "s", goal: "g" })
    log.append({ type: "done", id: "b", ts: 2, sessionId: "s", answer: "x" })
    log.append({ type: "done", id: "c", ts: 3, sessionId: "s", answer: "y" })
    expect(log.replaySince(1).map((e) => e.id)).toEqual(["b", "c"])
  })

  test("replay is pure read, append is durable across instances", () => {
    const db = new Database(":memory:")
    new SqliteLog(db).append({ type: "turn", id: "a", ts: 1, sessionId: "s", goal: "g" })
    const log2 = new SqliteLog(db)
    expect(log2.replay()).toHaveLength(1)
  })
})
