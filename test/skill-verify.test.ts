import { Database } from "bun:sqlite"
import { describe, expect, test } from "bun:test"
import { harvestInto } from "../src/kernel/harvest.js"
import { verifyDraftSkills } from "../src/kernel/skill-verify.js"
import { SqliteSelfStore } from "../src/store/self.js"

function storeWithDrafts(): SqliteSelfStore {
  const self = new SqliteSelfStore(new Database(":memory:"))
  harvestInto(self, {
    memories: [],
    skills: [
      { name: "good", description: "x", steps: "x", verification: `${process.execPath} -e "process.exit(0)"` },
      { name: "bad", description: "x", steps: "x", verification: `${process.execPath} -e "process.exit(1)"` },
      { name: "no-check", description: "x", steps: "x" },
    ],
  })
  return self
}

describe("verifyDraftSkills (skill loop closure)", () => {
  test("promotes passing skills to active+verified, failing stays draft", async () => {
    const self = storeWithDrafts()
    const { verified, failed } = await verifyDraftSkills(self, process.cwd())

    expect(verified).toContain("good")
    expect(failed).toContain("bad")
    expect(verified).not.toContain("no-check")

    expect(self.get("skill", "good")?.state).toBe("active")
    expect(self.get("skill", "good")?.verification.status).toBe("verified")
    expect(self.get("skill", "bad")?.state).toBe("draft")
    expect(self.get("skill", "bad")?.verification.status).toBe("failed")
    expect(self.get("skill", "no-check")?.state).toBe("draft")
  })
})
