import { describe, expect, test } from "bun:test"
import { join } from "node:path"
import { createAgent } from "../src/agent.js"
import { measureEvolution } from "../src/eval/evolution.js"
import { createFakeModel } from "../src/model/fake.js"
import { tmpDir } from "./helpers.js"

describe("measureEvolution", () => {
  test("reports improvement when a later run passes after an early failure", async () => {
    const dir = tmpDir()
    let runCount = 0
    // Scripted model: every run writes the wrong file, so the verify logic
    // (which passes only for the right file path) never passes — the point
    // here is the aggregation math. One tool step per session, so each run
    // has exactly 1 step.
    const fixture = () => {
      const agent = createAgent({
        dbPath: join(dir, "t.db"),
        workspace: dir,
        model: {
          async decide(input) {
            const lastUserIdx = input.history.map((h) => h.role).lastIndexOf("user")
            const toolSteps = input.history.slice(lastUserIdx + 1).filter((h) => h.role === "assistant-tool").length
            return toolSteps === 0
              ? [{ type: "tool", tool: "fs_write", args: { path: "out.txt", content: "wrong" } }]
              : [{ type: "done", answer: "done" }]
          },
        },
      })
      return { workspace: dir, agent }
    }

    const result = await measureEvolution({
      createAgent: fixture,
      goal: "write helper.py with the header",
      verify: ({ events, workspace }) => {
        void workspace
        runCount += 1
        // Only pass from the second run on, and only when the file write
        // targeted the right path.
        const wrote = events.some(
          (e) => e.type === "step" && e.tool === "fs_write" && (e.args as { path: string }).path === "helper.py",
        )
        return runCount > 1 && wrote
      },
      runs: 3,
    })

    expect(result.firstPassed).toBe(false)
    expect(result.lastPassed).toBe(false) // the scripted model never writes helper.py
    expect(result.improved).toBe(false)
    expect(result.runs).toHaveLength(3)
    expect(result.stepsTrend).toEqual([1, 1, 1])
  })

  test("improvement requires the first run to fail and the last to pass", async () => {
    const dir = tmpDir()
    let attempt = 0
    const result = await measureEvolution({
      createAgent: () => {
        const agent = createAgent({
          dbPath: join(dir, "t.db"),
          workspace: dir,
          model: createFakeModel([{ type: "done", answer: "ok" }]),
        })
        return { workspace: dir, agent }
      },
      goal: "g",
      verify: () => {
        attempt += 1
        return attempt >= 2
      },
      runs: 2,
    })
    expect(result.firstPassed).toBe(false)
    expect(result.lastPassed).toBe(true)
    expect(result.improved).toBe(true)
  })

  test("beforeRun runs once before every attempt", async () => {
    const dir = tmpDir()
    const before: number[] = []
    await measureEvolution({
      createAgent: () => {
        const agent = createAgent({
          dbPath: join(dir, "t.db"),
          workspace: dir,
          model: createFakeModel([{ type: "done", answer: "ok" }]),
        })
        return { workspace: dir, agent }
      },
      goal: "g",
      verify: () => true,
      runs: 3,
      beforeRun: (run) => {
        before.push(run)
      },
    })
    expect(before).toEqual([1, 2, 3])
  })
})
