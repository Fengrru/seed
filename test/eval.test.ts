import { describe, expect, test } from "bun:test"
import { join } from "node:path"
import { createAgent } from "../src/agent.js"
import { measureWarmVsCold, runEvalCase, runSuite } from "../src/eval/runner.js"
import { createFakeModel } from "../src/model/fake.js"
import { tmpDir } from "./helpers.js"

describe("eval harness", () => {
  test("runEvalCase reports pass/fail, answer, and steps", async () => {
    const dir = tmpDir()
    const agent = createAgent({
      dbPath: join(dir, "t.db"),
      workspace: dir,
      model: createFakeModel([
        { type: "tool", tool: "fs_write", args: { path: "a.txt", content: "x" } },
        { type: "done", answer: "all good" },
      ]),
    })
    const result = await runEvalCase(
      agent,
      undefined,
      {
        name: "writes-file",
        goal: "write a file",
        verify: ({ answer }) => answer.includes("good"),
      },
      dir,
    )
    expect(result.passed).toBe(true)
    expect(result.steps).toBe(1)
    expect(result.answer).toBe("all good")
  })

  test("verify receives the workspace and event log, not just the answer", async () => {
    const dir = tmpDir()
    const agent = createAgent({
      dbPath: join(dir, "t.db"),
      workspace: dir,
      model: createFakeModel([
        { type: "tool", tool: "fs_write", args: { path: "config.json", content: '{"port": 9090}' } },
        { type: "done", answer: "done" },
      ]),
    })
    const result = await runEvalCase(
      agent,
      undefined,
      {
        name: "real-file-check",
        goal: "configure the server",
        verify: async ({ workspace, events, answer }) => {
          expect(events.some((e) => e.type === "step" && e.tool === "fs_write")).toBe(true)
          expect(answer).toBe("done")
          const content = await Bun.file(join(workspace, "config.json")).text()
          return content.includes("9090")
        },
      },
      dir,
    )
    expect(result.passed).toBe(true)
  })

  test("runSuite aggregates pass rate", async () => {
    const dir = tmpDir()
    const agent = createAgent({
      dbPath: join(dir, "t.db"),
      workspace: dir,
      model: createFakeModel([{ type: "done", answer: "yes" }]),
    })
    const suite = await runSuite(
      agent,
      [
        { name: "ok", goal: "g", verify: () => true },
        { name: "fail", goal: "g", verify: () => false },
      ],
      dir,
    )
    expect(suite.passed).toBe(1)
    expect(suite.total).toBe(2)
  })

  test("measureWarmVsCold runs teach in one session and test in another (shared self)", async () => {
    let n = 0
    const makeAgent = () => {
      const dir = tmpDir()
      return {
        workspace: dir,
        agent: createAgent({
          dbPath: join(dir, `t-${n++}.db`),
          workspace: dir,
          model: createFakeModel([
            { type: "tool", tool: "memory", args: { op: "write", key: "rule", content: "snake_case" } },
            { type: "done", answer: "remembered" },
            { type: "tool", tool: "memory", args: { op: "read", key: "rule" } },
            { type: "done", answer: "used snake_case" },
          ]),
        }),
      }
    }

    const result = await measureWarmVsCold({
      createAgent: makeAgent,
      teach: "remember snake_case",
      test: "name a file",
      verify: ({ answer }) => answer.includes("snake_case"),
    })

    // cold agent: test consumes steps[0..1] -> answer "remembered" (no snake_case)
    // warm agent: teach consumes steps[0..1], test consumes steps[2..3] -> "used snake_case"
    expect(result.coldPassed).toBe(false)
    expect(result.warmPassed).toBe(true)
  })
})
