import { describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { createAgent } from "../src/agent.js"
import { createFakeModel } from "../src/model/fake.js"
import { tmpDir } from "./helpers.js"

function tmp(): string {
  return tmpDir()
}

describe("skill auto-verification gate", () => {
  test("autoHarvest alone does NOT execute distilled verification commands", async () => {
    const dir = tmp()
    const marker = join(dir, "marker.txt")
    const cmd = `echo verified > ${JSON.stringify(marker)}`
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
          memories: [],
          skills: [{ name: "checked", description: "d", steps: "s", verification: cmd }],
        },
      ),
    })
    const { answer } = await agent.session().run("task")
    expect(answer).toBe("done")

    const skill = agent.self.get("skill", "checked")
    expect(skill).not.toBeNull()
    expect(skill?.state).toBe("draft")
    expect(existsSync(marker)).toBe(false)
  })

  test("autoVerifySkills opt-in runs distilled verification commands and adopts the skill", async () => {
    const dir = tmp()
    const marker = join(dir, "marker.txt")
    const cmd = `echo verified > ${JSON.stringify(marker)}`
    const agent = createAgent({
      dbPath: join(dir, "t.db"),
      workspace: dir,
      autoHarvest: true,
      autoVerifySkills: true,
      model: createFakeModel(
        [
          { type: "tool", tool: "fs_write", args: { path: "a.txt", content: "x" } },
          { type: "done", answer: "done" },
        ],
        {
          memories: [],
          skills: [{ name: "checked", description: "d", steps: "s", verification: cmd }],
        },
      ),
    })
    await agent.session().run("task")

    const skill = agent.self.get("skill", "checked")
    expect(skill).not.toBeNull()
    expect(skill?.state).toBe("active")
    expect(skill?.verification.status).toBe("verified")
    expect(existsSync(marker)).toBe(true)
  })
})
