import { Database } from "bun:sqlite"
import { describe, expect, test } from "bun:test"
import { join } from "node:path"
import { createAgent } from "../src/agent.js"
import { createRetriever, usageFactor } from "../src/memory/retriever.js"
import { createFakeModel } from "../src/model/fake.js"
import type { Model } from "../src/model/model.js"
import { SqliteSelfStore } from "../src/store/self.js"
import { tmpDir } from "./helpers.js"

function memory(kind: "memory" | "skill", content: unknown) {
  return {
    kind,
    content,
    provenance: { source: "human" as const, refs: [], created: Date.now() },
    evidence: [],
    verification: { status: "unverified" as const, check: null, lastVerifiedAt: null },
    ttl: null,
    state: "active" as const,
    metrics: { uses: 0, successes: 0, lastUsedAt: null },
  }
}

describe("usage feedback loop", () => {
  test("injected entries get their outcome recorded after a successful run", async () => {
    const dir = tmpDir()
    const agent = createAgent({
      dbPath: join(dir, "t.db"),
      workspace: dir,
      model: createFakeModel([{ type: "done", answer: "ok" }]),
    })
    agent.self.add("port", memory("memory", { rule: "use port 9090" }))
    await agent.session().run("what port should the server use")
    const mem = agent.self.get("memory", "port")!
    expect(mem.metrics.uses).toBe(1)
    expect(mem.metrics.successes).toBe(1)
    agent.dispose()
  })

  test("a failed run records a failure for injected entries", async () => {
    const dir = tmpDir()
    const failing: Model = {
      async decide() {
        throw new Error("boom")
      },
    }
    const agent = createAgent({ dbPath: join(dir, "t.db"), workspace: dir, model: failing })
    agent.self.add("port", memory("memory", { rule: "use port 9090" }))
    await agent.session().run("what port should the server use")
    const mem = agent.self.get("memory", "port")!
    expect(mem.metrics.uses).toBe(1)
    expect(mem.metrics.successes).toBe(0)
    agent.dispose()
  })

  test("retrieval ranking prefers entries with a track record of use", async () => {
    const self = new SqliteSelfStore(new Database(":memory:"))
    self.add("a", memory("memory", { note: "prefer sqlite for storage" }))
    self.add("b", memory("memory", { note: "prefer sqlite for storage" }))
    // Identical relevance; b has been used successfully ten times.
    for (let i = 0; i < 9; i++) self.recordOutcome("memory", "b", true)
    self.recordOutcome("memory", "b", false)

    const retriever = createRetriever(self)
    const results = await retriever.retrieve("sqlite storage", 2)
    expect(results.map((r) => r.name)).toEqual(["b", "a"])
  })

  test("usageFactor rewards frequent success and punishes frequent failure", () => {
    const base = memory("memory", {}) as ReturnType<typeof memory> & {
      metrics: { uses: number; successes: number; lastUsedAt: number | null }
    }
    const fresh = usageFactor({ ...base, metrics: { ...base.metrics, uses: 0, successes: 0 } } as never)
    const healthy = usageFactor({ ...base, metrics: { ...base.metrics, uses: 10, successes: 9 } } as never)
    const sick = usageFactor({ ...base, metrics: { ...base.metrics, uses: 10, successes: 1 } } as never)
    expect(healthy).toBeGreaterThan(fresh)
    expect(sick).toBeLessThan(fresh)
  })

  test("autoHarvest and autoMeta default ON; autoVerifySkills stays OFF", async () => {
    const dir = tmpDir()
    const agent = createAgent({
      dbPath: join(dir, "t.db"),
      workspace: dir,
      model: createFakeModel(
        [
          { type: "tool", tool: "fs_write", args: { path: "a.txt", content: "x" } },
          { type: "done", answer: "done" },
        ],
        {
          memories: [{ key: "learned", content: { rule: "snake_case" } }],
          skills: [{ name: "checked", description: "d", steps: "s", verification: "echo bad" }],
        },
      ),
    })
    await agent.session().run("do a task")
    // Harvest ran by default.
    expect(agent.self.get("memory", "learned")).not.toBeNull()
    // The distilled skill is still draft: verification is opt-in.
    expect(agent.self.get("skill", "checked")!.state).toBe("draft")
    agent.dispose()
  })

  test("guidance aggregates across sessions", async () => {
    const dir = tmpDir()
    const dbPath = join(dir, "t.db")
    const failing: Model = {
      async decide(input) {
        const toolSteps = input.history.filter((h) => h.role === "assistant-tool").length
        return toolSteps < 3
          ? [{ type: "tool", tool: "memory", args: { op: "read", key: "missing" } }]
          : [{ type: "done", answer: "gave up" }]
      },
    }
    const agent1 = createAgent({ dbPath, workspace: dir, model: failing, autoMeta: false })
    await agent1.session("a").run("read something")
    agent1.dispose()

    const contexts: string[] = []
    const probe: Model = {
      async decide(input) {
        contexts.push(input.context)
        return [{ type: "done", answer: "ok" }]
      },
    }
    const agent2 = createAgent({ dbPath, workspace: dir, model: probe })
    await agent2.session("b").run("hello")
    agent2.dispose()

    expect(contexts).toHaveLength(1)
    expect(contexts[0]).toContain("[guidance]")
    expect(contexts[0]).toContain("memory failed 3x")
  })
})
