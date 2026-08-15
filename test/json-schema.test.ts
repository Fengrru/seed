import { describe, expect, test } from "bun:test"
import { z } from "zod"
import { toJsonSchema } from "../src/util/json-schema.js"

describe("toJsonSchema", () => {
  test("maps objects with required and optional keys", () => {
    const schema = toJsonSchema(z.object({ a: z.string(), b: z.number().optional() }))
    expect(schema).toEqual({
      type: "object",
      properties: { a: { type: "string" }, b: { type: "number" } },
      required: ["a"],
    })
  })

  test("unwraps defaults and optionals", () => {
    expect(toJsonSchema(z.number().default(3))).toEqual({ type: "number" })
    expect(toJsonSchema(z.string().optional())).toEqual({ type: "string" })
  })

  test("maps literals, enums, arrays, and records", () => {
    expect(toJsonSchema(z.literal("fixed"))).toEqual({ type: "string", enum: ["fixed"] })
    expect(toJsonSchema(z.literal(7))).toEqual({ type: "number", enum: [7] })
    expect(toJsonSchema(z.enum(["a", "b"]))).toEqual({ type: "string", enum: ["a", "b"] })
    expect(toJsonSchema(z.array(z.string()))).toEqual({ type: "array", items: { type: "string" } })
    expect(toJsonSchema(z.record(z.unknown()))).toEqual({ type: "object" })
  })

  test("maps discriminated unions to oneOf", () => {
    const schema = toJsonSchema(
      z.discriminatedUnion("op", [z.object({ op: z.literal("a") }), z.object({ op: z.literal("b") })]),
    )
    expect(schema).toMatchObject({ type: "object" })
    expect((schema as { oneOf: unknown[] }).oneOf).toHaveLength(2)
  })

  test("throws on unsupported zod types", () => {
    expect(() => toJsonSchema(z.union([z.string(), z.number()]))).toThrow("unsupported zod type")
  })
})

describe("nullable support", () => {
  test("nullable fields unwrap to their inner type and are not required", () => {
    const schema = toJsonSchema(z.object({ name: z.string().nullable(), count: z.number() }))
    expect(schema).toEqual({
      type: "object",
      properties: { name: { type: "string" }, count: { type: "number" } },
      required: ["count"],
    })
  })
})
