import { describe, expect, test } from "bun:test"
import { existsSync, symlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { createReadConnection, createWriteConnection } from "../src/connection/builtin.js"
import { tmpDir } from "./helpers.js"

function tmp(): string {
  return tmpDir()
}

describe("workspace path containment", () => {
  test("rejects a ../ escape", async () => {
    const dir = tmp()
    const read = createReadConnection(dir)
    const r = await read.call({ path: "../secret.txt" })
    expect(r.ok).toBe(false)
    expect((r as { error: { code: string } }).error.code).toBe("outside_root")
  })

  test("rejects an absolute path outside the root", async () => {
    const dir = tmp()
    const read = createReadConnection(dir)
    const outside = join(dir, "..", "definitely-outside.txt")
    const r = await read.call({ path: outside })
    expect(r.ok).toBe(false)
    expect((r as { error: { code: string } }).error.code).toBe("outside_root")
  })

  test("rejects a symlink pointing outside the workspace", async () => {
    const dir = tmp()
    const outsideDir = tmp()
    const secret = join(outsideDir, "secret.txt")
    writeFileSync(secret, "top secret")
    const link = join(dir, "link.txt")
    try {
      symlinkSync(secret, link)
    } catch {
      return // symlinks not permitted on this platform — skip silently
    }
    expect(existsSync(link)).toBe(true)

    const read = createReadConnection(dir)
    const r = await read.call({ path: "link.txt" })
    expect(r.ok).toBe(false)
    expect((r as { error: { code: string } }).error.code).toBe("outside_root")

    const write = createWriteConnection(dir)
    const w = await write.call({ path: "link.txt", content: "overwrite" })
    expect(w.ok).toBe(false)
  })

  test("fs_read truncates oversized files", async () => {
    const dir = tmp()
    const file = join(dir, "big.txt")
    await Bun.write(file, "a".repeat(300 * 1024))
    const read = createReadConnection(dir)
    const r = await read.call({ path: "big.txt" })
    expect(r.ok).toBe(true)
    const value = (r as { value: { content: string; truncated: boolean } }).value
    expect(value.truncated).toBe(true)
    expect(value.content.length).toBe(256 * 1024)
  })

  test("symlinks pointing inside the workspace keep working for read and write", async () => {
    const dir = tmp()
    const target = join(dir, "real.txt")
    await Bun.write(target, "inside content")
    const link = join(dir, "link.txt")
    try {
      symlinkSync(target, link)
    } catch {
      return // symlinks not permitted on this platform — skip silently
    }

    const read = createReadConnection(dir)
    const r = await read.call({ path: "link.txt" })
    expect(r.ok).toBe(true)
    expect((r as { value: { content: string } }).value.content).toBe("inside content")

    const write = createWriteConnection(dir)
    const w = await write.call({ path: "link.txt", content: "updated through link" })
    expect(w.ok).toBe(true)
    expect(await Bun.file(target).text()).toBe("updated through link")
  })
})
