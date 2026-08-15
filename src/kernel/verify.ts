import { type ConnectionResult, fail, ok } from "../schema/connection.js"
import type { Check } from "../schema/knowledge.js"
import { spawnShell } from "../util/shell.js"

export interface Verdict {
  ok: boolean
  detail: string
}

export class InvalidCheckError extends Error {}

export async function runCheck(check: Check, value: unknown, cwd: string): Promise<ConnectionResult> {
  switch (check.type) {
    case "command": {
      const { stdout, stderr, exitCode } = await spawnShell(check.cmd, cwd)
      return ok({ exitCode, stdout, stderr, passed: exitCode === 0 })
    }
    case "assert": {
      try {
        const fn = new Function("value", `return (${check.expr})(value)`)
        return ok({ passed: Boolean(fn(value)) })
      } catch (e) {
        return fail("assert_error", e instanceof Error ? e.message : String(e))
      }
    }
    default:
      // The union makes this unreachable at compile time, but checks are
      // persisted data: a corrupt row must fail loudly, not return undefined.
      throw new InvalidCheckError(`unknown check type: ${JSON.stringify(check)}`)
  }
}

export async function verifyCommand(check: Check, cwd: string): Promise<Verdict> {
  const r = await runCheck(check, undefined, cwd)
  if (r.ok && typeof r.value === "object" && r.value !== null && (r.value as { passed?: boolean }).passed) {
    return { ok: true, detail: "command exited 0" }
  }
  return { ok: false, detail: r.ok ? "command exited non-zero" : r.error.message }
}
