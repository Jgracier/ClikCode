/** Validator for the JSON Schema subset the harness tools use: type,
 * required, enum, additionalProperties, items, minimum/maximum. Errors are
 * phrased for the model, which has to repair its own call from them. */

type Schema = Record<string, unknown>;

function typeOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  return typeof value;
}

function matchesType(value: unknown, expected: string): boolean {
  const actual = typeOf(value);
  return actual === expected || (expected === 'number' && actual === 'integer');
}

export function validateAgainstSchema(value: unknown, schema: Schema, at = 'args'): string[] {
  const errors: string[] = [];
  const types = typeof schema.type === 'string' ? [schema.type] : Array.isArray(schema.type) ? schema.type.map(String) : [];
  if (types.length && !types.some((type) => matchesType(value, type))) {
    errors.push(`${at}: expected ${types.join(' or ')}, got ${typeOf(value)}`);
    return errors;
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((option) => option === value)) {
    errors.push(`${at}: must be one of ${schema.enum.map((option) => JSON.stringify(option)).join(', ')}`);
  }
  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) errors.push(`${at}: must be >= ${schema.minimum}`);
    if (typeof schema.maximum === 'number' && value > schema.maximum) errors.push(`${at}: must be <= ${schema.maximum}`);
  }
  if (Array.isArray(value) && schema.items && typeof schema.items === 'object') {
    value.forEach((entry, index) => errors.push(...validateAgainstSchema(entry, schema.items as Schema, `${at}[${index}]`)));
    if (typeof schema.minItems === 'number' && value.length < schema.minItems) errors.push(`${at}: needs at least ${schema.minItems} item(s)`);
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    const properties = (schema.properties && typeof schema.properties === 'object' ? schema.properties : {}) as Record<string, Schema>;
    for (const key of Array.isArray(schema.required) ? schema.required.map(String) : []) {
      if (record[key] === undefined) errors.push(`${at}.${key}: required property is missing`);
    }
    for (const [key, entry] of Object.entries(record)) {
      if (entry === undefined) continue;
      if (properties[key]) errors.push(...validateAgainstSchema(entry, properties[key], `${at}.${key}`));
      else if (schema.additionalProperties === false) {
        errors.push(`${at}.${key}: unknown property (allowed: ${Object.keys(properties).join(', ') || 'none'})`);
      } else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
        errors.push(...validateAgainstSchema(entry, schema.additionalProperties as Schema, `${at}.${key}`));
      }
    }
  }
  return errors;
}
