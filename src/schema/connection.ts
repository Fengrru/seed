import { z } from "zod"

export const TrustSchema = z.enum(["trusted", "reviewed", "untrusted"])

export type Trust = z.infer<typeof TrustSchema>

export interface ToolSchema<S extends z.ZodType = z.ZodType> {
  name: string
  description: string
  inputSchema: S
  jsonSchema?: Record<string, unknown>
}

export type ConnectionResult = { ok: true; value: unknown } | { ok: false; error: { code: string; message: string } }

// Passed to every tool call so connections that write knowledge can record
// where the claim came from (the evidence trail).
export interface CallContext {
  sessionId?: string
  stepId?: string
}

export interface Connection {
  readonly id: string
  readonly trust: Trust
  readonly schema: ToolSchema
  call(args: unknown, ctx?: CallContext): Promise<ConnectionResult>
}

export function ok(value: unknown): ConnectionResult {
  return { ok: true, value }
}

export function fail(code: string, message: string): ConnectionResult {
  return { ok: false, error: { code, message } }
}
