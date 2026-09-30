import { describe, expect, it } from 'vitest';
import { AI_LOCAL_HARNESSES, harnessIntegrationLevel } from '@clikcode/router/ai-local-harness';
import { harnessTurnTransport, sessionTurnTransport } from './select.js';
import type { AiLocalHarnessDefinition } from '../definition.js';

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

  it('uses ACP for every catalog entry that declares it', () => {
    for (const candidate of AI_LOCAL_HARNESSES.filter((item) => item.acp)) {
      expect(harnessTurnTransport(candidate as AiLocalHarnessDefinition), candidate.command).toBe('acp');
    }
  });

  it('keeps native conversations on the transport that created their vendor session', () => {
    const openCode = catalog('opencode');
    expect(sessionTurnTransport(openCode, {})).toBe('acp');
    for (const command of ['gemini', 'opencode', 'goose', 'kiro', 'qwen', 'kilo', 'auggie']) {
      expect(sessionTurnTransport(catalog(command), { nativeSessionId: 'old-cli-thread' }), command).toBe('structured-cli');
    }
    expect(sessionTurnTransport(openCode, { nativeSessionId: 'new-acp-thread', nativeTransport: 'acp' }, true, { acpImages: true })).toBe('acp');
    expect(sessionTurnTransport(openCode, { nativeSessionId: 'fallback-thread', nativeTransport: 'structured-cli' })).toBe('structured-cli');
    expect(sessionTurnTransport(openCode, { nativeSessionId: 'locally-minted', nativeSessionPreallocated: true })).toBe('acp');
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
      expect(Boolean(candidate.turn || candidate.acp), candidate.command).toBe(true);
      if (transport === 'text-cli') expect(harnessIntegrationLevel(candidate), candidate.command).toBe('compatibility');
      else expect(['native', 'structured'], candidate.command).toContain(harnessIntegrationLevel(candidate));
    }
  });
});
