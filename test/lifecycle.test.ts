import { describe, expect, test } from "bun:test"
import { readdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { createAgent } from "../src/agent.js"
import { createFakeModel } from "../src/model/fake.js"
import type { Model } from "../src/model/model.js"
import type { Event } from "../src/schema/event.js"
import { reconstructHistory } from "../src/session/history.js"
import { tmpDir } from "./helpers.js"

function tmp(): string {
  return tmpDir()
}

function fixtureCommand() {
  const fixture = fileURLToPath(new URL("./fixtures/fake-mcp-server.ts", import.meta.url))
  return { command: "bun", args: [fixture] }
}

describe("agent resource lifecycle", () => {
  test("dispose closes the database and MCP clients", async () => {
    const dir = tmp()
    const agent = createAgent({
      dbPath: join(dir, "t.db"),
      workspace: dir,
      model: createFakeModel([]),
    })
    await agent.connectMcp([fixtureCommand()])
    agent.dispose()
    expect(() => agent.log.append({ type: "turn", id: "x", ts: 1, sessionId: "s", goal: "g" })).toThrow()
  })

  test("delegate worktrees are removed after a parallel run", async () => {
    const dir = tmp()
    const agent = createAgent({
      dbPath: join(dir, "t.db"),
      workspace: dir,
      model: createFakeModel([
        { type: "tool", tool: "delegate", args: { op: "many", goals: ["g1", "g2"] } },
        { type: "done", answer: "delegated" },
      ]),
    })
    const before = readdirSync(tmpdir()).filter((d) => d.startsWith("seed-worktree-"))
    await agent.session().run("parallel task")
    const after = readdirSync(tmpdir()).filter((d) => d.startsWith("seed-worktree-"))
    expect(after).toEqual(before)
    agent.dispose()
  })
})

describe("session serialization", () => {
  test("concurrent runs on one session are serialized, not interleaved", async () => {
    const dir = tmp()
    const model: Model = {
      async decide(input) {
        const lastUserIdx = input.history.map((h) => h.role).lastIndexOf("user")
        const goal = (input.history[lastUserIdx] as { content: string }).content
        const toolSteps = input.history.slice(lastUserIdx + 1).filter((h) => h.role === "assistant-tool").length
        if (toolSteps === 0) {
          return [{ type: "tool", tool: "fs_write", args: { path: goal === "A" ? "a.txt" : "b.txt", content: "x" } }]
        }
        return [{ type: "done", answer: `${goal} done` }]
      },
    }
    const agent = createAgent({ dbPath: join(dir, "t.db"), workspace: dir, model })
    const session = agent.session("s")
    const [ra, rb] = await Promise.all([session.run("A"), session.run("B")])
    expect(ra.answer).toBe("A done")
    expect(rb.answer).toBe("B done")
    const events = agent.log.replaySession("s")
    expect(events.map((e) => e.type)).toEqual([
      "turn",
      "step",
      "result",
      "verdict",
      "done",
      "verdict",
      "turn",
      "step",
      "result",
      "verdict",
      "done",
      "verdict",
    ])
    agent.dispose()
  })
})

describe("crash recovery", () => {
  test("a dangling step (crash before execution) is repaired with an interrupted result", () => {
    const events: Event[] = [
      { type: "turn", id: "t1", ts: 1, sessionId: "s", goal: "g" },
      { type: "step", id: "s1", ts: 2, sessionId: "s", tool: "echo", args: {} },
    ]
    const items = reconstructHistory(events)
    expect(items.map((i) => i.role)).toEqual(["user", "assistant-tool", "tool"])
    const last = items.at(-1) as { role: "tool"; result: { error: { code: string } } }
    expect(last.role).toBe("tool")
    expect(last.result.error.code).toBe("interrupted")
  })

  test("a completed transcript is left untouched", () => {
    const events: Event[] = [
      { type: "turn", id: "t1", ts: 1, sessionId: "s", goal: "g" },
      { type: "step", id: "s1", ts: 2, sessionId: "s", tool: "echo", args: {} },
      { type: "result", id: "r1", ts: 3, sessionId: "s", stepId: "s1", result: { ok: true } },
      { type: "done", id: "d1", ts: 4, sessionId: "s", answer: "x", stopped: "done" },
    ]
    const items = reconstructHistory(events)
    expect(items.map((i) => i.role)).toEqual(["user", "assistant-tool", "tool", "assistant-text"])
  })
})

describe("MCP registration", () => {
  test("a duplicate tool name is rejected and the batch is rolled back", async () => {
    const dir = tmp()
    const agent = createAgent({
      dbPath: join(dir, "t.db"),
      workspace: dir,
      model: createFakeModel([]),
    })
    // Same fixture twice in one batch: the second one's tools collide with
    // the first's and the whole batch must roll back.
    await expect(agent.connectMcp([fixtureCommand(), fixtureCommand()])).rejects.toThrow("tool conflict")
    // Rollback left nothing registered, so a fresh connect succeeds.
    const tools = await agent.connectMcp([fixtureCommand()])
    expect(tools.map((t) => t.name)).toEqual(["echo", "add"])
    agent.dispose()
  })
})
