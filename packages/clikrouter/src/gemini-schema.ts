// ============================================
// GEMINI SCHEMA — a tool's JSON Schema, in the subset Google's function_declarations accept
// ============================================
// Every capability's `parameters` is produced by zod v4's `z.toJSONSchema`,
// which emits full JSON Schema 2020-12: a `$schema` URI, `additionalProperties:
// false`, `const`, `default`, `exclusiveMinimum`, `format: "email"`, and so on.
// Google's Schema type (the OpenAPI 3.0 subset used by
// `tools[].functionDeclarations[].parameters`) accepts NONE of those, and the
// request is rejected before any model runs:
//
//   400 Invalid JSON payload received. Unknown name "$schema" at
//       'request.tools[0].function_declarations[0].parameters'
//
// MEASURED 2026-09-04: this is why the connected Google OAuth surface had zero
// successful tool-calling invocations, ever — every agent lane attaches tools.
//
// This is an ALLOWLIST projection, applied at the Google transport seam only
// (ai-provider-http.ts: the `code-assist` OAuth dialect and the API-key
// OpenAI-compatible endpoint, which validates `parameters` the same way).
// Every other provider still receives the schema as produced. Keys Google's
// Schema documents are kept; everything else is dropped, and the few JSON
// Schema constructs that have a Gemini equivalent are translated rather than
// lost:
//
//   type: ["string","null"]            → type: "string", nullable: true
//   anyOf: [X, {type:"null"}]          → X, nullable: true
//   oneOf                              → anyOf
//   allOf: [X]                         → X   (a multi-member allOf is dropped)
//   const: v                           → enum: [v]
//   enum on a non-string type          → type: "string", values stringified
//   format                             → kept only for the formats Gemini names
//   object with no properties          → the `properties` key is omitted
//
// The projection is a request-shape concern, not a routing one, so it lives
// with the transport. PURE: no imports, no I/O.

/** Keys Google's Schema accepts. Anything else is dropped. */
const GEMINI_SCHEMA_KEYS = new Set([
  "type",
  "format",
  "title",
  "description",
  "nullable",
  "enum",
  "maxItems",
  "minItems",
  "properties",
  "required",
  "minProperties",
  "maxProperties",
  "minLength",
  "maxLength",
  "pattern",
  "example",
  "anyOf",
  "propertyOrdering",
  "items",
  "minimum",
  "maximum",
]);

/** The `format` values Gemini names, per type. Any other format is dropped (Gemini 400s on unknown ones). */
const GEMINI_FORMATS: Record<string, ReadonlySet<string>> = {
  string: new Set(["date-time", "enum"]),
  number: new Set(["float", "double"]),
  integer: new Set(["int32", "int64"]),
};

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Project one JSON Schema node into Gemini's Schema. Returns `undefined` for a
 * node that has nothing Gemini can use (an empty schema, a `$ref`, ...).
 */
function project(node: unknown): JsonObject | undefined {
  // `true` / `{}` — "anything". Gemini has no such node; an unconstrained
  // property is best carried as a string the model can fill.
  if (node === true) return { type: "string" };
  if (!isObject(node)) return undefined;
  if (Object.keys(node).length === 0) return { type: "string" };
  if (typeof node.$ref === "string") return undefined;

  let out: JsonObject = {};
  let nullable = node.nullable === true;

  // type — a JSON Schema type may be an array; Gemini's is one value.
  let type = node.type;
  if (Array.isArray(type)) {
    const nonNull = type.filter((t) => t !== "null");
    if (nonNull.length < type.length) nullable = true;
    type = nonNull.length === 1 ? nonNull[0] : undefined;
  }

  // anyOf / oneOf — a nullable union collapses to its one member + nullable.
  const union = Array.isArray(node.anyOf) ? node.anyOf : Array.isArray(node.oneOf) ? node.oneOf : undefined;
  if (union) {
    const members = union.filter((m) => !(isObject(m) && m.type === "null"));
    if (members.length < union.length) nullable = true;
    if (members.length === 1) {
      const single = project(members[0]);
      if (single) out = { ...single };
    } else if (members.length > 1) {
      const projected = members.map(project).filter((m): m is JsonObject => Boolean(m));
      if (projected.length > 0) out.anyOf = projected;
    }
  }

  // allOf — only the trivial single-member form has a faithful translation.
  if (Array.isArray(node.allOf) && node.allOf.length === 1 && !union) {
    const single = project(node.allOf[0]);
    if (single) out = { ...single };
  }

  if (typeof type === "string" && out.anyOf === undefined && out.type === undefined) out.type = type;

  // Plain documented keys, copied through.
  for (const key of ["title", "description", "minItems", "maxItems", "minProperties", "maxProperties", "minLength", "maxLength", "pattern", "minimum", "maximum", "example"]) {
    if (node[key] !== undefined) out[key] = node[key];
  }
  if (node.example === undefined && Array.isArray(node.examples) && node.examples.length > 0) {
    out.example = node.examples[0];
  }

  // const → enum; enum must be STRING-typed for Gemini.
  let enumValues: unknown[] | undefined = Array.isArray(node.enum) ? node.enum : undefined;
  if (enumValues === undefined && node.const !== undefined) enumValues = [node.const];
  if (enumValues) {
    const values = enumValues.filter((v) => v !== null);
    if (values.length < enumValues.length) nullable = true;
    out.enum = values.map((v) => (typeof v === "string" ? v : String(v)));
    out.type = "string";
  }

  // format — only the ones Gemini names for this type.
  if (typeof node.format === "string" && typeof out.type === "string" && out.enum === undefined) {
    if (GEMINI_FORMATS[out.type]?.has(node.format)) out.format = node.format;
  }

  // items
  if (out.type === "array" || node.items !== undefined) {
    const items = project(node.items) ?? (Array.isArray(node.prefixItems) ? project(node.prefixItems[0]) : undefined);
    if (items) out.items = items;
    else if (out.type === "array") out.items = { type: "string" };
  }

  // properties / required
  if (isObject(node.properties)) {
    const properties: JsonObject = {};
    for (const [name, child] of Object.entries(node.properties)) {
      const projected = project(child);
      if (projected) properties[name] = projected;
    }
    if (Object.keys(properties).length > 0) {
      out.properties = properties;
      if (Array.isArray(node.required)) {
        const required = node.required.filter((r): r is string => typeof r === "string" && r in properties);
        if (required.length > 0) out.required = required;
      }
    }
  }
  if (Array.isArray(node.propertyOrdering)) out.propertyOrdering = node.propertyOrdering;

  if (nullable) out.nullable = true;

  // Belt and braces: nothing outside the allowlist leaves this function.
  for (const key of Object.keys(out)) if (!GEMINI_SCHEMA_KEYS.has(key)) delete out[key];
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * A tool's `parameters` as Gemini's function_declarations accept it, or
 * `undefined` for a tool that takes no arguments (Gemini rejects an OBJECT
 * schema with no properties; the declaration simply omits `parameters`).
 */
export function toGeminiToolParameters(schema: Record<string, unknown>): Record<string, unknown> | undefined {
  const projected = project(schema);
  if (!projected) return undefined;
  if (projected.type === "object" && !isObject(projected.properties)) return undefined;
  if (projected.type === undefined && projected.anyOf === undefined) projected.type = "object";
  return projected;
}

/** Every key present anywhere in a projected schema — exported for the tests' allowlist check. */
export function geminiSchemaKeys(): ReadonlySet<string> {
  return GEMINI_SCHEMA_KEYS;
}
