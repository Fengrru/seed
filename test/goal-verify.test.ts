import { describe, expect, test } from "bun:test"
import { join } from "node:path"
import { createAgent } from "../src/agent.js"
import { createFakeModel } from "../src/model/fake.js"
import type { Model } from "../src/model/model.js"
import { createOpenAIModel } from "../src/model/openai.js"
import { tmpDir } from "./helpers.js"

function judgeServer(verdict: string) {
  return Bun.serve({
    port: 0,
    async fetch() {
      return Response.json({ choices: [{ message: { content: verdict } }] })
    },
  })
}

describe("goal verifier", () => {
  test("openai judge parses yes and no verdicts", async () => {
    const yesServer = judgeServer("Yes.")
    const noServer = judgeServer("No.")
    try {
      const yesModel = createOpenAIModel({ baseUrl: `http://127.0.0.1:${yesServer.port}/v1`, apiKey: "k", model: "m" })
      expect(await yesModel.judge?.("g", "a", "t")).toBe(true)
      const noModel = createOpenAIModel({ baseUrl: `http://127.0.0.1:${noServer.port}/v1`, apiKey: "k", model: "m" })
      expect(await noModel.judge?.("g", "a", "t")).toBe(false)
    } finally {
      yesServer.stop(true)
      noServer.stop(true)
    }
  })

  test("openai judge throws on unparseable verdicts", async () => {
    const server = judgeServer("perhaps, in some sense")
    try {
      const model = createOpenAIModel({ baseUrl: `http://127.0.0.1:${server.port}/v1`, apiKey: "k", model: "m" })
      await expect(model.judge?.("g", "a", "t")).rejects.toThrow("unparseable judge verdict")
    } finally {
      server.stop(true)
    }
  })

  test("the goal verdict is persisted as an auditable run-level event", async () => {
    const dir = tmpDir()
    let decided = false
    const judging: Model = {
      async decide() {
        if (!decided) {
          decided = true
          return [{ type: "tool", tool: "fs_write", args: { path: "a.txt", content: "x" } }]
        }
        return [{ type: "done", answer: "claimed success" }]
      },
      async judge() {
        return false
      },
    }
    const agent = createAgent({ dbPath: join(dir, "t.db"), workspace: dir, model: judging })
    await agent.session().run("do the thing")
    // Run-level verdicts have no stepId; per-step verdicts do.
    const runVerdicts = agent.log.replay().filter((e) => e.type === "verdict" && e.stepId === undefined)
    expect(runVerdicts).toHaveLength(1)
    expect((runVerdicts[0] as { ok: boolean; detail: string }).ok).toBe(false)
    expect((runVerdicts[0] as { detail: string }).detail).toContain("not achieved")
    agent.dispose()
  })

  test("a failing judge verdict records failure for injected entries and gates harvest quality", async () => {
    const dir = tmpDir()
    let decided = false
    const judging: Model = {
      async decide() {
        if (!decided) {
          decided = true
          return [{ type: "tool", tool: "fs_write", args: { path: "a.txt", content: "x" } }]
        }
        return [{ type: "done", answer: "claimed success" }]
      },
      async harvest() {
        return { memories: [{ key: "learned", content: { rule: "x" } }], skills: [] }
      },
      async judge() {
        return false
      },
    }
    const agent = createAgent({ dbPath: join(dir, "t.db"), workspace: dir, model: judging })
    agent.self.add("port", {
      kind: "memory",
      content: { rule: "use port 9090" },
      provenance: { source: "human", refs: [], created: Date.now() },
      evidence: [],
      verification: { status: "unverified", check: null, lastVerifiedAt: null },
      ttl: null,
      state: "active",
      metrics: { uses: 0, successes: 0, lastUsedAt: null },
    })
    const outcome = await agent.session().run("what port should the server use")
    expect(outcome.goalAchieved).toBe(false)
    expect(agent.self.get("memory", "port")!.metrics.successes).toBe(0)
    // Harvest from an unachieved run distills memories as drafts.
    expect(agent.self.get("memory", "learned")!.state).toBe("draft")
    agent.dispose()
  })

  test("a passing judge verdict records success", async () => {
    const dir = tmpDir()
    let decided = false
    const judging: Model = {
      async decide() {
        if (!decided) {
          decided = true
          return [{ type: "tool", tool: "fs_write", args: { path: "a.txt", content: "x" } }]
        }
        return [{ type: "done", answer: "claimed success" }]
      },
      async harvest() {
        return { memories: [{ key: "learned", content: { rule: "x" } }], skills: [] }
      },
      async judge() {
        return true
      },
    }
    const agent = createAgent({ dbPath: join(dir, "t.db"), workspace: dir, model: judging })
    const outcome = await agent.session().run("do the thing")
    expect(outcome.goalAchieved).toBe(true)
    expect(agent.self.get("memory", "learned")!.state).toBe("active")
    agent.dispose()
  })

  test("a judge failure falls back to the run outcome", async () => {
    const dir = tmpDir()
    const flaky: Model = {
      async decide() {
        return [{ type: "done", answer: "done" }]
      },
      async judge() {
        throw new Error("judge network error")
      },
    }
    const agent = createAgent({ dbPath: join(dir, "t.db"), workspace: dir, model: flaky })
    const outcome = await agent.session().run("goal")
    expect(outcome.stopped).toBe("done")
    expect(outcome.goalAchieved).toBe(true)
    agent.dispose()
  })

  test("goalVerify false skips the judge entirely", async () => {
    const dir = tmpDir()
    let judgeCalls = 0
    const model: Model = {
      async decide() {
        return [{ type: "done", answer: "done" }]
      },
      async judge() {
        judgeCalls += 1
        return false
      },
    }
    const agent = createAgent({ dbPath: join(dir, "t.db"), workspace: dir, model, goalVerify: false })
    const outcome = await agent.session().run("goal")
    expect(outcome.goalAchieved).toBe(true)
    expect(judgeCalls).toBe(0)
    agent.dispose()
  })

  test("the fake model does not implement judge, so nothing changes for scripted runs", async () => {
    const dir = tmpDir()
    const agent = createAgent({
      dbPath: join(dir, "t.db"),
      workspace: dir,
      model: createFakeModel([{ type: "done", answer: "ok" }]),
    })
    const outcome = await agent.session().run("goal")
    expect(outcome.goalAchieved).toBe(true)
    agent.dispose()
  })

  test("non-done outcomes are never judged", async () => {
    const dir = tmpDir()
    let judgeCalls = 0
    const model: Model = {
      async decide() {
        throw new Error("persistent")
      },
      async judge() {
        judgeCalls += 1
        return true
      },
    }
    const agent = createAgent({ dbPath: join(dir, "t.db"), workspace: dir, model })
    const outcome = await agent.session().run("goal")
    expect(outcome.stopped).toBe("error")
    expect(outcome.goalAchieved).toBe(false)
    expect(judgeCalls).toBe(0)
    agent.dispose()
  })
})
