import { describe, expect, test } from "bun:test"
import { createBashConnection, createReadConnection, createWriteConnection } from "../src/connection/builtin.js"
import { InvalidCheckError, runCheck, verifyCommand } from "../src/kernel/verify.js"
import { tmpDir } from "./helpers.js"

describe("builtin connections", () => {
  test("write then read round-trips", async () => {
    const dir = tmpDir()
    const write = createWriteConnection(dir)
    const read = createReadConnection(dir)
    const w = await write.call({ path: "a.txt", content: "hello" })
    expect(w.ok).toBe(true)
    const r = await read.call({ path: "a.txt" })
    expect(r.ok).toBe(true)
    expect((r as { value: { content: string } }).value.content).toBe("hello")
  })

  test("read of missing file returns not_found (not throw)", async () => {
    const dir = tmpDir()
    const read = createReadConnection(dir)
    const r = await read.call({ path: "missing.txt" })
    expect(r.ok).toBe(false)
  })

  test("invalid args return invalid_args", async () => {
    const dir = tmpDir()
    const read = createReadConnection(dir)
    const r = await read.call({ nope: true })
    expect(r.ok).toBe(false)
  })

  test("bash runs a command and returns exit code", async () => {
    const dir = tmpDir()
    const bash = createBashConnection(dir)
    const r = await bash.call({ command: `${process.execPath} --version` })
    expect(r.ok).toBe(true)
    const value = (r as { value: { exitCode: number } }).value
    expect(value.exitCode).toBe(0)
  })
})

describe("verification", () => {
  test("command check passes on exit 0", async () => {
    const r = await runCheck(
      { type: "command", cmd: `${process.execPath} -e "process.exit(0)"` },
      undefined,
      process.cwd(),
    )
    expect(r.ok).toBe(true)
    expect((r as { value: { passed: boolean } }).value.passed).toBe(true)
  })

  test("command check fails on non-zero exit", async () => {
    const r = await runCheck(
      { type: "command", cmd: `${process.execPath} -e "process.exit(1)"` },
      undefined,
      process.cwd(),
    )
    expect((r as { value: { passed: boolean } }).value.passed).toBe(false)
  })

  test("assert check evaluates a predicate", async () => {
    const r = await runCheck({ type: "assert", expr: "v => v > 3" }, 5, process.cwd())
    expect((r as { value: { passed: boolean } }).value.passed).toBe(true)
    const r2 = await runCheck({ type: "assert", expr: "v => v > 3" }, 2, process.cwd())
    expect((r2 as { value: { passed: boolean } }).value.passed).toBe(false)
  })
})

describe("verifyCommand", () => {
  test("reports pass on exit 0", async () => {
    const v = await verifyCommand({ type: "command", cmd: `${process.execPath} -e "process.exit(0)"` }, process.cwd())
    expect(v.ok).toBe(true)
  })

  test("reports fail on non-zero exit", async () => {
    const v = await verifyCommand({ type: "command", cmd: `${process.execPath} -e "process.exit(1)"` }, process.cwd())
    expect(v.ok).toBe(false)
  })

  test("an unknown check type raises InvalidCheckError", async () => {
    await expect(runCheck({ type: "nonsense" } as never, undefined, process.cwd())).rejects.toThrow(InvalidCheckError)
  })
})
