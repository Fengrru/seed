import type { Log } from "../store/log.js"
import type { SelfStore } from "../store/self.js"
import { runCheck } from "./verify.js"

export interface SkillVerifyResult {
  name: string
  verified: boolean
}

// Verification verdicts are appended to the event log so the verification
// action itself is auditable and can serve as evidence for later knowledge.
function emitVerdict(log: Log | undefined, sessionId: string | undefined, name: string, passed: boolean): void {
  if (!log || sessionId === undefined) return
  log.append({
    type: "verdict",
    id: crypto.randomUUID(),
    ts: Date.now(),
    sessionId,
    ok: passed,
    detail: passed ? `skill ${name} verification passed` : `skill ${name} verification failed`,
  })
}

export async function verifySkill(
  self: SelfStore,
  name: string,
  cwd: string,
  log?: Log,
  sessionId?: string,
): Promise<SkillVerifyResult | null> {
  const obj = self.get("skill", name)
  if (obj?.kind !== "skill") return null
  const check = obj.verification.check
  if (!check) return null

  const result = await runCheck(check, undefined, cwd)
  const passed =
    result.ok &&
    typeof result.value === "object" &&
    result.value !== null &&
    (result.value as { passed?: boolean }).passed === true

  if (passed) {
    self.setVerification("skill", name, "verified", Date.now())
    self.setState("skill", name, "active")
  } else {
    self.setVerification("skill", name, "failed", Date.now())
    self.setState("skill", name, "draft")
  }
  emitVerdict(log, sessionId, name, passed)
  return { name, verified: passed }
}

export async function verifyDraftSkills(
  self: SelfStore,
  cwd: string,
  log?: Log,
  sessionId?: string,
): Promise<{ verified: string[]; failed: string[] }> {
  const drafts = self.latest().filter((o) => o.kind === "skill" && o.state === "draft" && o.verification.check !== null)
  const verified: string[] = []
  const failed: string[] = []
  for (const d of drafts) {
    const r = await verifySkill(self, d.name, cwd, log, sessionId)
    if (r) (r.verified ? verified : failed).push(r.name)
  }
  return { verified, failed }
}
