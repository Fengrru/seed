import { createHash } from "node:crypto"
import { z } from "zod"

export const KnowledgeKindSchema = z.enum(["memory", "skill", "policy", "connection-meta"])
export const ProvenanceSourceSchema = z.enum([
  "trajectory",
  "search",
  "mcp",
  "human",
  "self-reflection",
  "consolidation",
])
export const VerificationStatusSchema = z.enum(["unverified", "verified", "failed", "stale"])
export const KnowledgeStateSchema = z.enum(["draft", "active", "stale", "archived"])

export type KnowledgeKind = z.infer<typeof KnowledgeKindSchema>
export type ProvenanceSource = z.infer<typeof ProvenanceSourceSchema>
export type VerificationStatus = z.infer<typeof VerificationStatusSchema>
export type KnowledgeState = z.infer<typeof KnowledgeStateSchema>

export const RefSchema = z.object({
  url: z.string().optional(),
  sessionId: z.string().optional(),
  connection: z.string().optional(),
  // A knowledgeId reference marks a derivation edge: this entry was derived
  // from (or depends on) the referenced knowledge entry. Invalidation
  // cascades along these edges.
  knowledgeId: z.string().optional(),
})

export type Ref = z.infer<typeof RefSchema>

export const CheckSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("command"), cmd: z.string() }),
  z.object({ type: z.literal("assert"), expr: z.string() }),
])

export type Check = z.infer<typeof CheckSchema>

export const VerificationSchema = z.object({
  status: VerificationStatusSchema,
  check: CheckSchema.nullable(),
  lastVerifiedAt: z.number().nullable(),
})

export type Verification = z.infer<typeof VerificationSchema>

export const MetricsSchema = z.object({
  uses: z.number().int().nonnegative(),
  successes: z.number().int().nonnegative(),
  lastUsedAt: z.number().nullable(),
})

export type Metrics = z.infer<typeof MetricsSchema>

export const ProvenanceSchema = z.object({
  source: ProvenanceSourceSchema,
  refs: z.array(RefSchema),
  created: z.number(),
})

export type Provenance = z.infer<typeof ProvenanceSchema>

export const KnowledgeObjectSchema = z.object({
  id: z.string(),
  name: z.string(),
  kind: KnowledgeKindSchema,
  version: z.number().int().positive(),
  parentId: z.string().nullable(),
  content: z.unknown(),
  provenance: ProvenanceSchema,
  evidence: z.array(z.string()),
  verification: VerificationSchema,
  ttl: z.number().nullable(),
  state: KnowledgeStateSchema,
  metrics: MetricsSchema,
})

export type KnowledgeObject = z.infer<typeof KnowledgeObjectSchema>

export type NewKnowledgeObject = Omit<KnowledgeObject, "id" | "name" | "version" | "parentId">

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`)
  return `{${entries.join(",")}}`
}

export function contentHash(content: unknown): string {
  return createHash("sha256").update(stableStringify(content)).digest("hex").slice(0, 40)
}
