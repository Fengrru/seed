import type { z } from "zod"

interface SchemaDef {
  typeName: string
  shape?: () => Record<string, z.ZodType>
  innerType?: z.ZodType
  value?: string | number | boolean
  values?: string[]
  options?: z.ZodType[]
  type?: z.ZodType
  discriminator?: string
}

function defOf(schema: z.ZodType): SchemaDef {
  return (schema as unknown as { _def: SchemaDef })._def
}

export function toJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const def = defOf(schema)
  switch (def.typeName) {
    case "ZodObject": {
      const shape = def.shape?.()
      const properties: Record<string, unknown> = {}
      const required: string[] = []
      for (const [k, v] of Object.entries(shape ?? {})) {
        const inner = defOf(v)
        const isOptional =
          inner.typeName === "ZodOptional" || inner.typeName === "ZodDefault" || inner.typeName === "ZodNullable"
        properties[k] = toJsonSchema(v)
        if (!isOptional) required.push(k)
      }
      return { type: "object", properties, required }
    }
    case "ZodOptional":
    case "ZodDefault":
    case "ZodNullable":
      return toJsonSchema(def.innerType!)
    case "ZodString":
      return { type: "string" }
    case "ZodNumber":
      return { type: "number" }
    case "ZodBoolean":
      return { type: "boolean" }
    case "ZodUnknown":
    case "ZodAny":
      return {}
    case "ZodLiteral": {
      const v = def.value!
      const t = typeof v === "number" ? "number" : typeof v === "boolean" ? "boolean" : "string"
      return { type: t, enum: [v] }
    }
    case "ZodEnum":
      return { type: "string", enum: def.values }
    case "ZodDiscriminatedUnion":
      return {
        type: "object",
        oneOf: def.options?.map(toJsonSchema),
      }
    case "ZodRecord":
      return { type: "object" }
    case "ZodArray":
      return { type: "array", items: toJsonSchema(def.type!) }
    default:
      throw new Error(`unsupported zod type in tool schema: ${def.typeName}`)
  }
}
