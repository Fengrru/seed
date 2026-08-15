import { describe, expect, test } from "bun:test"
import { join } from "node:path"
import { createAgent } from "../src/agent.js"
import { createFakeSearchProvider } from "../src/connection/search.js"
import { createFakeModel } from "../src/model/fake.js"
import type { Model, Step } from "../src/model/model.js"
import { tmpDir } from "./helpers.js"

function tmp(): string {
  return tmpDir()
}

describe("agent wiring", () => {
  test("autoHarvest distills memory and skill after a successful turn", async () => {
    const dir = tmp()
    const agent = createAgent({
      dbPath: join(dir, "t.db"),
      workspace: dir,
      autoHarvest: true,
      model: createFakeModel(
        [
          { type: "tool", tool: "fs_write", args: { path: "a.txt", content: "x" } },
          { type: "done", answer: "done" },
        ],
        {
          memories: [{ key: "learned", content: { rule: "snake_case" } }],
          skills: [{ name: "fmt", description: "format", steps: "run formatter" }],
        },
      ),
    })
    await agent.session().run("do a task")
    expect(agent.self.get("memory", "learned")?.content).toEqual({ rule: "snake_case" })
    expect(agent.self.get("skill", "fmt")?.kind).toBe("skill")
  })

  test("autoMeta writes a self-reflection when a tool fails repeatedly", async () => {
    const dir = tmp()
    const steps: Step[] = [
      { type: "tool", tool: "memory", args: { op: "read", key: "missing" } },
      { type: "tool", tool: "memory", args: { op: "read", key: "missing" } },
      { type: "tool", tool: "memory", args: { op: "read", key: "missing" } },
      { type: "done", answer: "gave up" },
    ]
    const failing: Model = {
      async decide() {
        const s = steps.shift()
        return [s ?? { type: "done", answer: "done" }]
      },
    }
    const agent = createAgent({
      dbPath: join(dir, "t.db"),
      workspace: dir,
      autoMeta: true,
      model: failing,
    })
    await agent.session().run("fix it")

    const reflections = agent.self.latest().filter((o) => o.kind === "memory" && o.name.startsWith("self-reflection:"))
    expect(reflections.length).toBeGreaterThanOrEqual(1)
    expect(JSON.stringify(reflections[0]?.content)).toContain("failed")
  })

  test("search connection is registered when a provider is given", async () => {
    const dir = tmp()
    const agent = createAgent({
      dbPath: join(dir, "t.db"),
      workspace: dir,
      searchProvider: createFakeSearchProvider([{ title: "A", url: "https://a", snippet: "result" }]),
      model: createFakeModel([
        { type: "tool", tool: "search", args: { op: "search", query: "x" } },
        { type: "done", answer: "searched" },
      ]),
    })
    const { answer } = await agent.session().run("search for x")
    expect(answer).toBe("searched")

    const results = agent.log.replay().filter((e) => e.type === "result")
    const searchResult = results.find((r) => (r as { stepId: string }).stepId !== undefined) as
      | { result: { value: { results: Array<{ title: string }> } } }
      | undefined
    expect(searchResult?.result.value.results[0]?.title).toBe("A")
  })
})
