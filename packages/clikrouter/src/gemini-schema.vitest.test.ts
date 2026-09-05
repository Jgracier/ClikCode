// Google's function_declarations accept an OpenAPI-3.0 subset, not JSON Schema.
// What is pinned here: the exact zod-v4 output shape a capability produces
// (`$schema`, `additionalProperties: false`, `const`, `default`, unsupported
// `format`s, nullable unions) comes out as something Gemini accepts, at BOTH
// Google request seams, and no other provider's payload is touched.

import { describe, expect, it } from 'vitest';
import { geminiSchemaKeys, toGeminiToolParameters } from './gemini-schema';
import { buildAiChatRequest } from './ai-provider-http';

/**
 * What `z.toJSONSchema(capability.input)` produces for a real capability
 * (configure_metric_alerts-shaped: an object with a string, an enum, a nullable
 * number with a default, an email, an array of objects, and a literal).
 */
const ZOD_V4_OUTPUT: Record<string, unknown> = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  properties: {
    appName: { type: 'string', description: 'The app', minLength: 1 },
    metric: { type: 'string', enum: ['cpu', 'memory', 'restarts'] },
    threshold: {
      anyOf: [{ type: 'number', minimum: 0, exclusiveMaximum: 100 }, { type: 'null' }],
      default: 80,
    },
    notify: { type: 'string', format: 'email' },
    windows: {
      type: 'array',
      items: {
        type: 'object',
        properties: { minutes: { type: 'integer', minimum: 1 } },
        required: ['minutes'],
        additionalProperties: false,
      },
      minItems: 1,
    },
    kind: { const: 'alert' },
    mode: { type: ['string', 'null'], examples: ['fast'] },
    extra: {},
  },
  required: ['appName', 'metric', 'kind'],
  additionalProperties: false,
};

function everyKey(node: unknown, out: Set<string> = new Set()): Set<string> {
  if (Array.isArray(node)) node.forEach((n) => everyKey(n, out));
  else if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      out.add(k);
      // Property NAMES are user data, not schema keys.
      if (k === 'properties' && v && typeof v === 'object') Object.values(v).forEach((c) => everyKey(c, out));
      else everyKey(v, out);
    }
  }
  return out;
}

describe('toGeminiToolParameters', () => {
  it('projects a real zod-v4 schema into the Gemini subset — nothing outside the allowlist survives', () => {
    const projected = toGeminiToolParameters(ZOD_V4_OUTPUT)!;
    const keys = everyKey(projected);
    for (const key of keys) expect(geminiSchemaKeys().has(key), `key ${key}`).toBe(true);
    expect(keys.has('$schema')).toBe(false);
    expect(keys.has('additionalProperties')).toBe(false);
    expect(keys.has('default')).toBe(false);
    expect(keys.has('exclusiveMaximum')).toBe(false);
    expect(keys.has('examples')).toBe(false);
    expect(keys.has('const')).toBe(false);
  });

  it('translates what has a Gemini equivalent instead of dropping it', () => {
    const projected = toGeminiToolParameters(ZOD_V4_OUTPUT)!;
    const props = projected.properties as Record<string, Record<string, unknown>>;
    // nullable union → member + nullable
    expect(props.threshold).toEqual({ type: 'number', minimum: 0, nullable: true });
    // unsupported format is dropped, the type stays
    expect(props.notify).toEqual({ type: 'string' });
    // const → string enum
    expect(props.kind).toEqual({ type: 'string', enum: ['alert'] });
    // type array with null → nullable; examples → example
    expect(props.mode).toEqual({ type: 'string', nullable: true, example: 'fast' });
    // an unconstrained property is carried as a string, not dropped
    expect(props.extra).toEqual({ type: 'string' });
    // nested objects and arrays keep their shape
    expect(props.windows).toEqual({
      type: 'array',
      minItems: 1,
      items: { type: 'object', properties: { minutes: { type: 'integer', minimum: 1 } }, required: ['minutes'] },
    });
    expect(projected.required).toEqual(['appName', 'metric', 'kind']);
  });

  it('keeps only the formats Gemini names, per type', () => {
    expect(toGeminiToolParameters({ type: 'object', properties: { at: { type: 'string', format: 'date-time' } } })).toEqual({
      type: 'object',
      properties: { at: { type: 'string', format: 'date-time' } },
    });
    expect(toGeminiToolParameters({ type: 'object', properties: { id: { type: 'string', format: 'uuid' } } })).toEqual({
      type: 'object',
      properties: { id: { type: 'string' } },
    });
  });

  it('an argument-less tool has NO parameters (Gemini rejects an empty OBJECT)', () => {
    expect(toGeminiToolParameters({ $schema: 'x', type: 'object', properties: {}, additionalProperties: false })).toBeUndefined();
    expect(toGeminiToolParameters({ type: 'object' })).toBeUndefined();
  });

  it('oneOf becomes anyOf; a single-member allOf collapses; a numeric enum is stringified', () => {
    expect(
      toGeminiToolParameters({
        type: 'object',
        properties: {
          a: { oneOf: [{ type: 'string' }, { type: 'number' }] },
          b: { allOf: [{ type: 'integer', minimum: 1 }] },
          c: { type: 'integer', enum: [1, 2] },
        },
      }),
    ).toEqual({
      type: 'object',
      properties: {
        a: { anyOf: [{ type: 'string' }, { type: 'number' }] },
        b: { type: 'integer', minimum: 1 },
        c: { type: 'string', enum: ['1', '2'] },
      },
    });
  });
});

describe('the Google transport seams', () => {
  const tools = [
    { name: 'configure_metric_alerts', description: 'Set alerts', parameters: ZOD_V4_OUTPUT },
    { name: 'list_apps', description: 'List', parameters: { $schema: 'x', type: 'object', properties: {}, additionalProperties: false } },
  ];

  it('code-assist (OAuth subscription) sends projected functionDeclarations', () => {
    const req = buildAiChatRequest({
      provider: 'google',
      model: 'gemini-2.5-flash',
      apiKey: 'ya29.x',
      credentialSource: 'oauth',
      projectId: 'p',
      messages: [{ role: 'user', content: 'hi' }],
      tools,
    });
    expect(req.dialect).toBe('code-assist');
    const inner = req.body.request as { tools: Array<{ functionDeclarations: Array<Record<string, unknown>> }> };
    const declarations = inner.tools[0]!.functionDeclarations;
    expect(declarations).toHaveLength(2);
    expect(everyKey(declarations[0]!.parameters).has('$schema')).toBe(false);
    expect(everyKey(declarations[0]!.parameters).has('additionalProperties')).toBe(false);
    // The argument-less tool declares no `parameters` at all.
    expect(declarations[1]).toEqual({ name: 'list_apps', description: 'List' });
    expect(JSON.stringify(req.body)).not.toContain('$schema');
  });

  it('the API-key OpenAI-compatible endpoint gets the same projection', () => {
    const req = buildAiChatRequest({
      provider: 'google',
      model: 'gemini-2.5-flash',
      apiKey: 'AIza-test',
      credentialSource: 'env',
      messages: [{ role: 'user', content: 'hi' }],
      tools,
    });
    expect(req.dialect).toBe('openai-chat');
    expect(JSON.stringify(req.body)).not.toContain('$schema');
    expect(JSON.stringify(req.body)).not.toContain('additionalProperties');
  });

  it('every other OpenAI-compatible provider still receives the schema as produced', () => {
    const req = buildAiChatRequest({
      provider: 'groq',
      model: 'llama-3.3-70b-versatile',
      apiKey: 'gsk_test',
      credentialSource: 'env',
      messages: [{ role: 'user', content: 'hi' }],
      tools,
    });
    const body = req.body as { tools: Array<{ function: { parameters: Record<string, unknown> } }> };
    expect(body.tools[0]!.function.parameters).toBe(ZOD_V4_OUTPUT);
  });
});
