import { exec } from "node:child_process"

export interface ShellResult {
  stdout: string
  stderr: string
  exitCode: number
  timedOut: boolean
}

export interface ShellOptions {
  timeoutMs?: number
}

export function spawnShell(command: string, cwd: string, options: ShellOptions = {}): Promise<ShellResult> {
  const timeoutMs = options.timeoutMs ?? 60_000
  return new Promise((resolve) => {
    exec(command, { cwd, maxBuffer: 64 * 1024 * 1024, timeout: timeoutMs }, (error, stdout, stderr) => {
      resolve({
        stdout,
        stderr,
        exitCode: error ? (typeof error.code === "number" ? error.code : 1) : 0,
        timedOut: Boolean(error?.killed),
      })
    })
  })
}
