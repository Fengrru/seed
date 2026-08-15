import { describe, expect, test } from "bun:test"
import { join } from "node:path"
import { createAgent } from "../src/agent.js"
import { createFakeModel } from "../src/model/fake.js"
import type { Model } from "../src/model/model.js"
import { tmpDir } from "./helpers.js"

describe("agent composition", () => {
  test("runs a goal end-to-end: model -> write -> answer", async () => {
    const dir = tmpDir()
    const agent = createAgent({
      dbPath: join(dir, "test.db"),
      workspace: dir,
      model: createFakeModel([
        { type: "tool", tool: "fs_write", args: { path: "out.txt", content: "hello" } },
        { type: "done", answer: "wrote out.txt" },
      ]),
    })

    const { answer } = await agent.session().run("write a file")
    expect(answer).toBe("wrote out.txt")

    const events = agent.log.replay()
    const types = events.map((e) => e.type)
    expect(types).toContain("turn")
    expect(types).toContain("step")
    expect(types).toContain("result")
    expect(types).toContain("done")
  })

  test("a session resumes: history from previous turn is fed back", async () => {
    const dir = tmpDir()
    const agent = createAgent({
      dbPath: join(dir, "test.db"),
      workspace: dir,
      model: createFakeModel([
        { type: "tool", tool: "fs_write", args: { path: "a.txt", content: "1" } },
        { type: "done", answer: "first done" },
        { type: "done", answer: "second done" },
      ]),
    })

    const session = agent.session("s1")
    await session.run("write a file")
    const { answer } = await session.run("now do another thing")
    expect(answer).toBe("second done")

    const events = agent.log.replaySession("s1")
    expect(events.filter((e) => e.type === "turn")).toHaveLength(2)
  })

  test("an embedding outage falls back to the local TF-IDF retriever", async () => {
    const seenContext: string[] = []
    const dir = tmpDir()
    const agent = createAgent({
      dbPath: join(dir, "test.db"),
      workspace: dir,
      model: {
        async decide(input) {
          seenContext.push(input.context)
          return [{ type: "done", answer: "done" }]
        },
      } satisfies Model,
      embeddingProvider: {
        async embed() {
          throw new Error("embedding service down")
        },
      },
    })
    agent.self.add("build system", {
      kind: "memory",
      content: { note: "the build uses zig cc" },
      provenance: { source: "human", refs: [], created: Date.now() },
      evidence: [],
      verification: { status: "unverified", check: null, lastVerifiedAt: null },
      ttl: null,
      state: "active",
      metrics: { uses: 0, successes: 0, lastUsedAt: null },
    })

    const { answer } = await agent.session().run("what build system do we use")
    expect(answer).toBe("done")
    // The fallback retriever still injected the knowledge into the context.
    expect(seenContext.some((c) => c.includes("zig cc"))).toBe(true)
  })

  test("harvested knowledge cites evidence that verifies against the log", async () => {
    const dir = tmpDir()
    const agent = createAgent({
      dbPath: join(dir, "test.db"),
      workspace: dir,
      model: createFakeModel(
        [
          { type: "tool", tool: "fs_write", args: { path: "out.txt", content: "hello" } },
          { type: "done", answer: "wrote it" },
        ],
        { memories: [{ key: "learned", content: { note: "prefer spaces" } }], skills: [] },
      ),
    })

    await agent.session().run("write a file")
    const mem = agent.self.get("memory", "learned")
    expect(mem).not.toBeNull()
    expect(mem?.evidence.length).toBeGreaterThan(0)
    expect(agent.log.verifyEvidence(mem?.evidence ?? [])).toEqual({ ok: true, invalid: [] })
  })
})
