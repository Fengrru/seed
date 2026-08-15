import { describe, expect, test } from "bun:test"
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { createAgent } from "../src/agent.js"
import { runBenchmark } from "../src/eval/benchmark.js"
import { createFakeModel } from "../src/model/fake.js"
import { tmpDir } from "./helpers.js"

function makeAgent() {
  const root = tmpDir()
  let n = 0
  return () => {
    const dir = join(root, `run-${n++}`)
    mkdirSync(dir)
    return {
      workspace: dir,
      agent: createAgent({
        dbPath: join(root, `a-${n}.db`),
        workspace: dir,
        model: createFakeModel([
          { type: "tool", tool: "memory", args: { op: "write", key: "k", content: "x" } },
          { type: "done", answer: "no idea" },
          { type: "tool", tool: "memory", args: { op: "read", key: "k" } },
          { type: "done", answer: "got it" },
        ]),
      }),
    }
  }
}

describe("runBenchmark", () => {
  test("aggregates cold/warm pass rates and helped/hurt counts", async () => {
    const agentFactory = makeAgent()
    const result = await runBenchmark({
      createAgent: agentFactory,
      scenarios: [
        { name: "a", teach: "remember x", test: "do x", verify: ({ answer }) => answer === "got it" },
        { name: "b", teach: "remember y", test: "do y", verify: ({ answer }) => answer === "got it" },
      ],
    })
    expect(result.total).toBe(2)
    expect(result.coldPassRate).toBe(0)
    expect(result.warmPassRate).toBe(1)
    expect(result.helpedCount).toBe(2)
    expect(result.hurtCount).toBe(0)
    for (const s of result.scenarios) {
      expect(s.coldPassed).toBe(false)
      expect(s.warmPassed).toBe(true)
      expect(s.helped).toBe(true)
      expect(s.warmAnswer).toBe("got it")
    }
  })

  test("a scenario that throws is recorded as an error, not a benchmark crash", async () => {
    let first = true
    const result = await runBenchmark({
      createAgent: () => {
        const dir = tmpDir()
        return {
          workspace: dir,
          agent: createAgent({
            dbPath: join(dir, "t.db"),
            workspace: dir,
            model: createFakeModel([{ type: "done", answer: "x" }]),
          }),
        }
      },
      scenarios: [
        { name: "broken", teach: "t", test: "x", verify: () => true },
        {
          name: "ok",
          teach: "t",
          test: "x",
          verify: () => {
            if (first) {
              first = false
              throw new Error("verify exploded")
            }
            return true
          },
        },
        { name: "still-runs", teach: "t", test: "x", verify: () => true },
      ],
    })
    expect(result.total).toBe(3)
    expect(result.scenarios[1]?.error).toBe("verify exploded")
    expect(result.scenarios[2]?.coldPassed).toBe(true)
  })

  test("a hanging scenario fails via timeout instead of stalling the benchmark", async () => {
    const dir = tmpDir()
    const agent = createAgent({
      dbPath: join(dir, "t.db"),
      workspace: dir,
      model: {
        async decide() {
          return new Promise(() => {}) // never resolves
        },
      },
    })
    const result = await runBenchmark({
      createAgent: () => ({ workspace: dir, agent }),
      scenarios: [{ name: "hang", teach: "t", test: "x", verify: () => true }],
      timeoutMs: 500,
    })
    expect(result.scenarios[0]?.error).toContain("timed out")
    expect(result.scenarios[0]?.coldPassed).toBe(false)
  })
})
