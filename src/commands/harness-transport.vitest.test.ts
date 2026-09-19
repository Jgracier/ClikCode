import { describe, expect, it } from 'vitest';
import { AI_LOCAL_HARNESSES, harnessIntegrationLevel } from '@clikdeploy/clikrouter/ai-local-harness';
import { harnessTurnTransport } from './harness-transport.js';
import type { AiLocalHarnessDefinition } from './types.js';

const harness = (command: string, output: 'text' | 'json' | 'json-lines' = 'json-lines'): AiLocalHarnessDefinition => ({
  command, provider: command, displayName: command, surface: 'terminal', localAuth: ['vendor-cli'], binary: command,
  turn: { startArgv: [], output },
});

describe('harness turn transports', () => {
  it('routes rich protocols centrally and retains safe CLI fallbacks', () => {
    expect(harnessTurnTransport(harness('codex'))).toBe('codex-app-server');
    expect(harnessTurnTransport(harness('cline'))).toBe('acp');
    expect(harnessTurnTransport(harness('copilot', 'text'))).toBe('acp');
    expect(harnessTurnTransport(harness('droid', 'json'))).toBe('acp');
    expect(harnessTurnTransport(harness('droid', 'json'), true)).toBe('structured-cli');
    // Images stay on ACP only when the caller says it forwards them.
    expect(harnessTurnTransport(harness('droid', 'json'), true, { acpImages: true })).toBe('acp');
    expect(harnessTurnTransport(harness('cursor'), true, { acpImages: true })).toBe('structured-cli');
    expect(harnessTurnTransport(harness('codex'), true)).toBe('codex-app-server');
    expect(harnessTurnTransport(harness('cursor'))).toBe('structured-cli');
    expect(harnessTurnTransport(harness('aider', 'text'))).toBe('text-cli');
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
