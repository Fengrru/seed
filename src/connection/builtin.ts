import { closeSync, constants, fstatSync, openSync, readSync, realpathSync, writeFileSync } from "node:fs"
import { basename, dirname, normalize, resolve, sep } from "node:path"
import { z } from "zod"
import { type Connection, fail, ok } from "../schema/connection.js"
import { spawnShell } from "../util/shell.js"

// fs_read never pulls more than this into the model context.
const MAX_READ_BYTES = 256 * 1024

// O_NOFOLLOW exists on POSIX only; on Windows the pre-check alone stands
// (creating symlinks there already requires privileges).
const NOFOLLOW = process.platform === "win32" ? 0 : constants.O_NOFOLLOW

// Opens `full` without following a symlink swapped into the final path
// component after the containment check (TOCTOU): the swap fails with ELOOP
// instead of being followed. On ELOOP the link's target is re-verified, so
// in-root symlinks keep working while escapes fail closed.
function openWithin(root: string, full: string, flags: number): number {
  try {
    return openSync(full, flags | NOFOLLOW)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ELOOP") throw e
    if (!isWithinRealRoot(root, full)) throw e
    return openSync(full, flags)
  }
}

function resolveWithin(root: string, p: string): string | null {
  const rootNorm = normalize(resolve(root))
  const full = normalize(resolve(rootNorm, p))
  if (full !== rootNorm && !full.startsWith(rootNorm + sep)) return null
  return full
}

// resolveWithin is lexical only; a symlink inside the workspace can point at
// anything on disk. Verify containment on the real (symlink-resolved) path.
// For a target that does not exist yet (e.g. a file about to be written),
// resolve the deepest existing ancestor and re-append the missing segments.
function isWithinRealRoot(root: string, target: string): boolean {
  let realRoot: string
  try {
    realRoot = realpathSync.native(root)
  } catch {
    return false
  }

  let cur = target
  const missing: string[] = []
  while (true) {
    let real: string
    try {
      real = realpathSync.native(cur)
    } catch {
      const parent = dirname(cur)
      if (parent === cur) return false
      missing.unshift(basename(cur))
      cur = parent
      continue
    }
    const candidate = missing.length > 0 ? normalize(resolve(real, ...missing)) : real
    return isSameOrChild(candidate, realRoot)
  }
}

function isSameOrChild(path: string, root: string): boolean {
  if (process.platform === "win32") {
    const a = path.toLowerCase()
    const b = root.toLowerCase()
    return a === b || a.startsWith(b + sep.toLowerCase())
  }
  return path === root || path.startsWith(root + sep)
}

export function createReadConnection(root: string): Connection {
  return {
    id: "fs_read",
    trust: "trusted",
    schema: {
      name: "fs_read",
      description: "Read a file by path (relative to the workspace root).",
      inputSchema: z.object({ path: z.string() }),
    },
    async call(args: unknown) {
      const parsed = z.object({ path: z.string() }).safeParse(args)
      if (!parsed.success) return fail("invalid_args", parsed.error.message)
      const full = resolveWithin(root, parsed.data.path)
      if (!full) return fail("outside_root", `path escapes workspace: ${parsed.data.path}`)
      if (!isWithinRealRoot(root, full))
        return fail("outside_root", `path escapes workspace via symlink: ${parsed.data.path}`)
      let fd: number | undefined
      try {
        // Opening pins the inode: whatever the path resolves to afterwards,
        // the bytes read are the file that passed the containment check.
        fd = openWithin(root, full, constants.O_RDONLY)
        const size = fstatSync(fd).size
        const buf = Buffer.alloc(Math.min(size, MAX_READ_BYTES))
        readSync(fd, buf, 0, buf.length, 0)
        return ok({ path: parsed.data.path, content: buf.toString(), truncated: size > MAX_READ_BYTES })
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code
        if (code === "ELOOP") return fail("outside_root", `path escapes workspace via symlink: ${parsed.data.path}`)
        if (code === "ENOENT") return fail("not_found", `no such file: ${parsed.data.path}`)
        return fail("not_found", e instanceof Error ? e.message : String(e))
      } finally {
        if (fd !== undefined) closeSync(fd)
      }
    },
  }
}

export function createWriteConnection(root: string): Connection {
  return {
    id: "fs_write",
    trust: "trusted",
    schema: {
      name: "fs_write",
      description: "Write content to a file (overwrites).",
      inputSchema: z.object({ path: z.string(), content: z.string() }),
    },
    async call(args: unknown) {
      const parsed = z.object({ path: z.string(), content: z.string() }).safeParse(args)
      if (!parsed.success) return fail("invalid_args", parsed.error.message)
      const full = resolveWithin(root, parsed.data.path)
      if (!full) return fail("outside_root", `path escapes workspace: ${parsed.data.path}`)
      if (!isWithinRealRoot(root, full))
        return fail("outside_root", `path escapes workspace via symlink: ${parsed.data.path}`)
      let fd: number | undefined
      try {
        fd = openWithin(root, full, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC)
        writeFileSync(fd, parsed.data.content)
        return ok({ path: parsed.data.path, written: true })
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code
        if (code === "ELOOP") return fail("outside_root", `path escapes workspace via symlink: ${parsed.data.path}`)
        return fail("write_failed", e instanceof Error ? e.message : String(e))
      } finally {
        if (fd !== undefined) closeSync(fd)
      }
    },
  }
}

export function createBashConnection(cwd: string): Connection {
  return {
    id: "bash",
    // Arbitrary shell execution is the highest-risk tool this agent has;
    // "reviewed" lets a trust gate ask for confirmation before each call.
    trust: "reviewed",
    schema: {
      name: "bash",
      description: "Run a shell command in the workspace.",
      inputSchema: z.object({ command: z.string() }),
    },
    async call(args: unknown) {
      const parsed = z.object({ command: z.string() }).safeParse(args)
      if (!parsed.success) return fail("invalid_args", parsed.error.message)
      try {
        const { stdout, stderr, exitCode, timedOut } = await spawnShell(parsed.data.command, cwd)
        return ok({ command: parsed.data.command, stdout, stderr, exitCode, timedOut })
      } catch (e) {
        return fail("exec_failed", e instanceof Error ? e.message : String(e))
      }
    },
  }
}
