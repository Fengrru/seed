import { Database } from "bun:sqlite"
import { describe, expect, test } from "bun:test"
import { createSkillConnection } from "../src/connection/skill.js"
import { SqliteSelfStore } from "../src/store/self.js"

describe("skill connection", () => {
  test("define a skill without verification -> draft (unverified proposal)", async () => {
    const self = new SqliteSelfStore(new Database(":memory:"))
    const skill = createSkillConnection(self, process.cwd())
    const r = await skill.call({ op: "define", name: "greet", description: "say hi", steps: "print hi" })
    expect((r as { value: { state: string; hasVerification: boolean } }).value.state).toBe("draft")
    expect((r as { value: { hasVerification: boolean } }).value.hasVerification).toBe(false)
  })

  test("define with verification -> draft, verify passes -> active", async () => {
    const self = new SqliteSelfStore(new Database(":memory:"))
    const skill = createSkillConnection(self, process.cwd())
    await skill.call({
      op: "define",
      name: "ok-check",
      description: "x",
      steps: "x",
      verification: `${process.execPath} -e "process.exit(0)"`,
    })
    expect(self.get("skill", "ok-check")?.state).toBe("draft")

    const v = await skill.call({ op: "verify", name: "ok-check" })
    expect((v as { value: { verified: boolean } }).value.verified).toBe(true)
    expect(self.get("skill", "ok-check")?.state).toBe("active")
    expect(self.get("skill", "ok-check")?.verification.status).toBe("verified")
  })

  test("verify fails on non-zero exit -> stays draft", async () => {
    const self = new SqliteSelfStore(new Database(":memory:"))
    const skill = createSkillConnection(self, process.cwd())
    await skill.call({
      op: "define",
      name: "bad-check",
      description: "x",
      steps: "x",
      verification: `${process.execPath} -e "process.exit(1)"`,
    })
    const v = await skill.call({ op: "verify", name: "bad-check" })
    expect((v as { value: { verified: boolean } }).value.verified).toBe(false)
    expect(self.get("skill", "bad-check")?.verification.status).toBe("failed")
  })

  test("list returns only skills", async () => {
    const self = new SqliteSelfStore(new Database(":memory:"))
    const skill = createSkillConnection(self, process.cwd())
    await skill.call({ op: "define", name: "s1", description: "a", steps: "a" })
    await skill.call({ op: "define", name: "s2", description: "b", steps: "b" })
    const r = await skill.call({ op: "list" })
    const names = (r as { value: { skills: Array<{ name: string }> } }).value.skills.map((s) => s.name)
    expect(names).toEqual(["s1", "s2"])
  })

  test("read returns the procedure and touches metrics", async () => {
    const self = new SqliteSelfStore(new Database(":memory:"))
    const skill = createSkillConnection(self, process.cwd())
    await skill.call({ op: "define", name: "s1", description: "desc", steps: "do this" })
    const r = await skill.call({ op: "read", name: "s1" })
    expect((r as { value: { steps: string } }).value.steps).toBe("do this")
    expect(self.get("skill", "s1")?.metrics.uses).toBe(1)
  })

  test("verify a missing skill returns not_found", async () => {
    const self = new SqliteSelfStore(new Database(":memory:"))
    const skill = createSkillConnection(self, process.cwd())
    const r = await skill.call({ op: "verify", name: "ghost" })
    expect(r.ok).toBe(false)
  })
})
