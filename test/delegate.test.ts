import { describe, expect, test } from "bun:test"
import { join } from "node:path"
import { createAgent } from "../src/agent.js"
import { createFakeModel } from "../src/model/fake.js"
import type { Model, Step } from "../src/model/model.js"
import { tmpDir } from "./helpers.js"

function tmp(): string {
  return tmpDir()
}

describe("delegation", () => {
  test("subagent runs in its own session and its answer flows back", async () => {
    const dir = tmp()
    const agent = createAgent({
      dbPath: join(dir, "t.db"),
      workspace: dir,
      model: createFakeModel([
        { type: "tool", tool: "delegate", args: { op: "one", goal: "do the sub part" } },
        { type: "done", answer: "sub done" },
        { type: "done", answer: "parent done" },
      ]),
    })
    const { answer } = await agent.session().run("do a complex task")
    expect(answer).toBe("parent done")

    // parent + child = two turns, each with a distinct session id
    const turns = agent.log.replay().filter((e) => e.type === "turn")
    expect(turns).toHaveLength(2)
    expect(new Set(turns.map((t) => t.sessionId)).size).toBe(2)
  })

  test("delegation respects the depth limit", async () => {
    const dir = tmp()
    const steps: Step[] = [
      { type: "tool", tool: "delegate", args: { goal: "sub" } },
      { type: "done", answer: "gave up after depth limit" },
    ]
    const model: Model = {
      async decide() {
        const s = steps.shift()
        return [s ?? { type: "done", answer: "done" }]
      },
    }
    const agent = createAgent({
      dbPath: join(dir, "t.db"),
      workspace: dir,
      maxDelegateDepth: 0, // any delegation is rejected immediately
      model,
    })
    const { answer } = await agent.session().run("delegate this")
    expect(answer).toBe("gave up after depth limit")

    // the delegate call failed, so there was no child session
    const turns = agent.log.replay().filter((e) => e.type === "turn")
    expect(turns).toHaveLength(1)
    const results = agent.log.replay().filter((e) => e.type === "result")
    expect((results[0] as { result: { ok: boolean } }).result.ok).toBe(false)
  })

  test("op=many runs parallel subagents", async () => {
    const dir = tmp()
    const calls: string[] = []
    const delegatingModel: Model = {
      async decide() {
        calls.push("decide")
        if (calls.length === 1) {
          return [{ type: "tool", tool: "delegate", args: { op: "many", goals: ["a", "b"] } }]
        }
        return [{ type: "done", answer: "child done" }]
      },
    }
    const agent = createAgent({
      dbPath: join(dir, "t.db"),
      workspace: dir,
      model: delegatingModel,
    })
    const { answer } = await agent.session().run("do many things")
    expect(answer).toBe("child done")

    // parent (1) + 2 children = 3 turns
    const turns = agent.log.replay().filter((e) => e.type === "turn")
    expect(turns).toHaveLength(3)
    const delegateResult = agent.log
      .replay()
      .filter((e) => e.type === "result")
      .find((e) => (e as { result?: { value?: { results?: unknown[] } } }).result?.value?.results !== undefined)
    expect(delegateResult).toBeDefined()
  })

  test("parallel subagents run in distinct isolated worktrees", async () => {
    const dir = tmp()
    const calls: string[] = []
    const model: Model = {
      async decide() {
        calls.push("x")
        if (calls.length === 1) {
          return [{ type: "tool", tool: "delegate", args: { op: "many", goals: ["a", "b"] } }]
        }
        return [{ type: "done", answer: "done" }]
      },
    }
    const agent = createAgent({ dbPath: join(dir, "t.db"), workspace: dir, model })
    await agent.session().run("parallelize")

    const result = agent.log
      .replay()
      .filter((e) => e.type === "result")
      .find(
        (e) =>
          (e as { result?: { value?: { results?: Array<{ worktree?: string }> } } }).result?.value?.results !==
          undefined,
      )

    const results = (result as { result: { value: { results: Array<{ answer: string; worktree?: string }> } } }).result
      .value.results
    expect(results).toHaveLength(2)
    const worktrees = results.map((r) => r.worktree)
    expect(worktrees[0]).toBeDefined()
    expect(worktrees[1]).toBeDefined()
    expect(worktrees[0]).not.toBe(worktrees[1])
    // the parent workspace itself is not one of the worktrees
    expect(worktrees).not.toContain(dir)
  })
})
