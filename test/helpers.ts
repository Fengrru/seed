import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const created = new Set<string>()

// Creates a temp directory that is automatically removed when the test
// process exits, so repeated runs do not accumulate garbage in the system
// temp directory.
export function tmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "seed-test-"))
  created.add(dir)
  return dir
}

process.on("exit", () => {
  for (const dir of created) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // already gone — fine
    }
  }
})
