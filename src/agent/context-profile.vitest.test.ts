import { describe, expect, it } from 'vitest';
import { CONTEXT_PROFILE_ENV, LEAN_BELOW_PROMPT_PER_SECOND, LEAN_MAX_CONTEXT_WINDOW, PROFILES, parseContextProfile, resolveContextProfile, selectContextProfile } from './context-profile.js';
import { defaultTools, toolSpecs } from './tools/registry.js';

describe('selectContextProfile', () => {
  it.each([
    // [label, hints, expected]
    ['nothing known', {}, 'lean'],
    ['laptop CPU, 32K window', { contextWindow: 32_768, promptPerSecond: 70 }, 'minimal'],
    ['laptop CPU, large window', { contextWindow: 131_072, promptPerSecond: 90 }, 'minimal'],
    ['fast GPU, large window', { contextWindow: 65_536, promptPerSecond: 1_800 }, 'full'],
    ['fast GPU, small window', { contextWindow: 16_384, promptPerSecond: 1_800 }, 'lean'],
    ['speed exactly at the threshold', { contextWindow: 65_536, promptPerSecond: LEAN_BELOW_PROMPT_PER_SECOND }, 'full'],
    ['window exactly at the threshold', { contextWindow: LEAN_MAX_CONTEXT_WINDOW, promptPerSecond: 5_000 }, 'lean'],
    ['large window, speed unknown, not hosted', { contextWindow: 131_072 }, 'lean'],
    ['hosted, nothing else known', { hosted: true }, 'full'],
    ['hosted, 200K window', { hosted: true, contextWindow: 200_000 }, 'full'],
    ['hosted, 32K window', { hosted: true, contextWindow: 32_000 }, 'lean'],
  ] as const)('%s -> %s', (_label, hints, expected) => {
    expect(selectContextProfile(hints)).toBe(expected);
  });

  it('keeps an unknown-speed or hosted model out of minimal', () => {
    expect(selectContextProfile({ contextWindow: 32_768 })).toBe('lean');
    expect(selectContextProfile({ hosted: true, contextWindow: 32_768, promptPerSecond: 70 })).toBe('lean');
  });
});

describe('resolveContextProfile', () => {
  const fast = { hosted: true, contextWindow: 200_000 };

  it('lets the environment force any profile, over the session setting', () => {
    for (const name of ['minimal', 'lean', 'full'] as const) {
      expect(resolveContextProfile({ hints: fast, session: 'lean', env: { [CONTEXT_PROFILE_ENV]: name } }).name).toBe(name);
    }
    expect(resolveContextProfile({ hints: {}, env: { [CONTEXT_PROFILE_ENV]: ' FULL ' } }).name).toBe('full');
  });

  it('uses the session setting when the environment does not force one', () => {
    expect(resolveContextProfile({ hints: fast, session: 'minimal', env: {} }).name).toBe('minimal');
  });

  it('ignores an unrecognized override and chooses automatically', () => {
    expect(resolveContextProfile({ hints: fast, session: 'huge', env: { [CONTEXT_PROFILE_ENV]: 'tiny' } }).name).toBe('full');
    expect(parseContextProfile('')).toBeUndefined();
    expect(parseContextProfile(3)).toBeUndefined();
  });
});

describe('profile tool specs', () => {
  const specs = toolSpecs(defaultTools());

  it('lean and full send the specs untouched', () => {
    expect(PROFILES.lean.shapeSpecs(specs)).toEqual(specs);
    expect(PROFILES.full.shapeSpecs(specs)).toEqual(specs);
  });

  it('minimal drops additionalProperties:false and nothing else from the schemas', () => {
    const shaped = PROFILES.minimal.shapeSpecs(specs);
    expect(JSON.stringify(shaped)).not.toContain('"additionalProperties":false');
    const strip = (text: string): string => text.replace(/"additionalProperties":false,?/g, '').replace(/,}/g, '}');
    shaped.forEach((spec, index) => {
      expect(spec.name).toBe(specs[index].name);
      expect(JSON.stringify(spec.parameters)).toBe(strip(JSON.stringify(specs[index].parameters)));
    });
  });

  it('minimal shortens only the descriptions it has a terse form for, and deterministically', () => {
    const shaped = PROFILES.minimal.shapeSpecs(specs);
    const changed = shaped.filter((spec, index) => spec.description !== specs[index].description).map((spec) => spec.name);
    expect(changed.sort()).toEqual(['active_conversations', 'agent', 'hindsight', 'read_conversation', 'search_conversations', 'task', 'web_fetch', 'web_search']);
    shaped.forEach((spec, index) => expect(spec.description.length).toBeLessThanOrEqual(specs[index].description.length));
    expect(JSON.stringify(PROFILES.minimal.shapeSpecs(specs))).toBe(JSON.stringify(shaped));
  });
});

describe('the compact profile', () => {
  const specs = [
    { name: 'read_file', description: 'Read a file and return its text. Use offset and limit for a large file; never read a binary.', parameters: { type: 'object', additionalProperties: false, required: ['path'], properties: { path: { type: 'string', description: 'The file to read, relative to the working directory or absolute. Absolute paths outside it are refused.' }, offset: { type: 'integer', minimum: 1, description: 'First line.' } } } },
  ];

  it('keeps what a call must look like and cuts the advice: first sentences, short parameter notes, no closed-object marker', () => {
    const [shaped] = PROFILES.compact.shapeSpecs(specs);
    expect(shaped!.description).toBe('Read a file and return its text.');
    const parameters = shaped!.parameters as { required: string[]; properties: Record<string, { type: string; minimum?: number; description?: string }>; additionalProperties?: boolean };
    expect(parameters.required).toEqual(['path']);
    expect(parameters.additionalProperties).toBeUndefined();
    expect(parameters.properties.path).toEqual({ type: 'string', description: 'The file to read, relative to the working directory or…' });
    expect(parameters.properties.offset).toEqual({ type: 'integer', minimum: 1, description: 'First line.' });
  });

  it('is deterministic (the specs are part of the cached prefix), leaves its input alone, and is chosen only by the override', () => {
    const before = JSON.stringify(specs);
    expect(JSON.stringify(PROFILES.compact.shapeSpecs(specs))).toBe(JSON.stringify(PROFILES.compact.shapeSpecs(specs)));
    expect(JSON.stringify(specs)).toBe(before);
    expect(parseContextProfile('Compact')).toBe('compact');
    expect(resolveContextProfile({ hints: { hosted: true }, env: { CLIKCODE_CONTEXT_PROFILE: 'compact' } as never }).name).toBe('compact');
    for (const hints of [{ hosted: true }, { contextWindow: 8192 }, { promptPerSecond: 60 }, {}]) expect(selectContextProfile(hints)).not.toBe('compact');
  });
});

describe('the bare profile', () => {
  it('keeps names, types, required fields and enums, and no notes: what a model that learned the tools still needs to be asked to call them', () => {
    const [shaped] = PROFILES.bare.shapeSpecs([{ name: 'edit_file', description: 'Replace text in a file. Fails when the old text is not unique, so add context.', parameters: { type: 'object', additionalProperties: false, required: ['path'], properties: { path: { type: 'string', description: 'The file.' }, mode: { type: 'string', enum: ['a', 'b'], description: 'How.' } } } }]);
    expect(shaped).toEqual({ name: 'edit_file', description: 'Replace text in a file.', parameters: { type: 'object', required: ['path'], properties: { path: { type: 'string' }, mode: { type: 'string', enum: ['a', 'b'] } } } });
    expect(parseContextProfile('bare')).toBe('bare');
  });
});
