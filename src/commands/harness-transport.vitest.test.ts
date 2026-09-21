import { describe, expect, it } from 'vitest';
import { AI_LOCAL_HARNESSES, harnessIntegrationLevel } from '@clikcode/router/ai-local-harness';
import { harnessTurnTransport } from './harness-transport.js';
import type { AiLocalHarnessDefinition } from './types.js';

const catalog = (command: string): AiLocalHarnessDefinition => {
  const found = AI_LOCAL_HARNESSES.find((candidate) => candidate.command === command);
  if (!found) throw new Error(`${command} is not in the catalog`);
  return found as AiLocalHarnessDefinition;
};

describe('harness turn transports', () => {
  it('routes rich protocols from the catalog declaration and retains safe CLI fallbacks', () => {
    expect(harnessTurnTransport(catalog('codex'))).toBe('codex-app-server');
    expect(harnessTurnTransport(catalog('codex'), true)).toBe('codex-app-server');
    for (const command of ['cline', 'copilot', 'droid', 'hermes', 'kimi', 'vibe', 'openhands']) {
      expect(harnessTurnTransport(catalog(command)), command).toBe('acp');
    }
    expect(harnessTurnTransport(catalog('cursor'))).toBe('structured-cli');
    expect(harnessTurnTransport(catalog('aider'))).toBe('text-cli');
  });

  it('keeps image turns on the CLI unless the caller forwards images to ACP', () => {
    expect(harnessTurnTransport(catalog('droid'), true)).toBe('structured-cli');
    expect(harnessTurnTransport(catalog('copilot'), true)).toBe('text-cli');
    expect(harnessTurnTransport(catalog('droid'), true, { acpImages: true })).toBe('acp');
    expect(harnessTurnTransport(catalog('cursor'), true, { acpImages: true })).toBe('structured-cli');
  });

  it('leaves experimental ACP declarations on their CLI path unless explicitly allowed', () => {
    for (const command of ['goose', 'qwen', 'kiro']) {
      expect(harnessTurnTransport(catalog(command)), command).toBe('structured-cli');
      expect(harnessTurnTransport(catalog(command), false, { allowExperimentalAcp: true }), command).toBe('acp');
    }
  });

  it('decides from the declaration, not the command name', () => {
    const renamed = { ...catalog('cursor'), command: 'copilot' };
    expect(harnessTurnTransport(renamed)).toBe('structured-cli');
    const adopted = { ...catalog('cursor'), command: 'brand-new', transport: 'acp' as const, acp: { argv: ['acp'] } };
    expect(harnessTurnTransport(adopted)).toBe('acp');
  });

  it('keeps every catalog entry on an honest executable transport', () => {
    for (const candidate of AI_LOCAL_HARNESSES) {
      if (candidate.surface === 'editor-extension') {
        expect(harnessIntegrationLevel(candidate), candidate.command).toBe('editor-only');
        continue;
      }
      const transport = harnessTurnTransport(candidate);
      expect(candidate.turn, candidate.command).toBeDefined();
      if (transport === 'text-cli') expect(harnessIntegrationLevel(candidate), candidate.command).toBe('compatibility');
      else expect(['native', 'structured'], candidate.command).toContain(harnessIntegrationLevel(candidate));
    }
  });
});
