import { Database } from "bun:sqlite"
import { describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { createAgent } from "../src/agent.js"
import { createFakeModel } from "../src/model/fake.js"
import type { Event } from "../src/schema/event.js"
import { SqliteLog } from "../src/store/log.js"
import { tmpDir } from "./helpers.js"

function event(id: string, ts: number): Event {
  return { type: "turn", id, ts, sessionId: "s", goal: `g-${id}` }
}

describe("bounded replay and retention primitives", () => {
  test("replayRecent returns the most recent events in ascending order", () => {
    const log = new SqliteLog(new Database(":memory:"))
    for (let i = 1; i <= 5; i++) log.append(event(`e${i}`, i * 10))
    const recent = log.replayRecent(3)
    expect(recent.map((e) => e.id)).toEqual(["e3", "e4", "e5"])
    expect(log.replayRecent(100)).toHaveLength(5)
  })

  test("eventsBefore and pruneBefore archive and delete in order", () => {
    const log = new SqliteLog(new Database(":memory:"))
    for (let i = 1; i <= 5; i++) log.append(event(`e${i}`, i * 10))
    const old = log.eventsBefore(31)
    expect(old.map((e) => e.id)).toEqual(["e1", "e2", "e3"])
    expect(log.pruneBefore(31)).toBe(3)
    expect(log.replay().map((e) => e.id)).toEqual(["e4", "e5"])
    // Pruning again finds nothing left.
    expect(log.eventsBefore(31)).toEqual([])
  })
})

describe("agent log retention", () => {
  test("retention archives old events to a JSONL sidecar and records a prune event", async () => {
    const dir = tmpDir()
    const dbPath = join(dir, "t.db")
    const agent = createAgent({
      dbPath,
      workspace: dir,
      model: createFakeModel([{ type: "done", answer: "ok" }]),
      logRetentionDays: 1,
    })
    const cutoff = Date.now() - 2 * 24 * 3600_000
    agent.log.append({ type: "turn", id: "old-1", ts: cutoff - 1000, sessionId: "s", goal: "old goal" })
    agent.log.append({ type: "done", id: "old-2", ts: cutoff - 500, sessionId: "s", answer: "old done" })

    await agent.session("s").run("fresh goal")

    // The old rows are gone from the log and live in the sidecar archive.
    expect(agent.log.replay().some((e) => e.id === "old-1")).toBe(false)
    const archive = readFileSync(`${dbPath}.archive.jsonl`, "utf8")
    expect(archive).toContain("old goal")
    const prunes = agent.log.replay().filter((e) => e.type === "prune")
    expect(prunes).toHaveLength(1)
    expect((prunes[0] as { archived: number }).archived).toBe(2)
    agent.dispose()
  })

  test("retention is off by default", async () => {
    const dir = tmpDir()
    const dbPath = join(dir, "t.db")
    const agent = createAgent({
      dbPath,
      workspace: dir,
      model: createFakeModel([{ type: "done", answer: "ok" }]),
    })
    agent.log.append({ type: "turn", id: "old-1", ts: Date.now() - 3 * 24 * 3600_000, sessionId: "s", goal: "old" })
    await agent.session("s").run("fresh goal")
    expect(agent.log.replay().some((e) => e.id === "old-1")).toBe(true)
    expect(existsSync(`${dbPath}.archive.jsonl`)).toBe(false)
    agent.dispose()
  })
})
