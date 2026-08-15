import { describe, expect, test } from "bun:test"
import { spawnShell } from "../src/util/shell.js"

describe("spawnShell", () => {
  test("captures stdout and exit code", async () => {
    const r = await spawnShell(`${process.execPath} -e "console.log('hello')"`, process.cwd())
    expect(r.stdout).toContain("hello")
    expect(r.exitCode).toBe(0)
    expect(r.timedOut).toBe(false)
  })

  test("times out a runaway command and reports timedOut", async () => {
    const r = await spawnShell(`${process.execPath} -e "setTimeout(() => {}, 5000)"`, process.cwd(), {
      timeoutMs: 500,
    })
    expect(r.timedOut).toBe(true)
  })
})
