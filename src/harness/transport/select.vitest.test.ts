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
    expect(harnessTurnTransport(catalog('codex'))).toBe('codex-app-server');
    for (const command of ['claude', 'cline', 'copilot', 'cursor', 'droid', 'grok', 'hermes', 'kimi', 'vibe', 'openhands']) {
      expect(harnessTurnTransport(catalog(command)), command).toBe('acp');
    }
    expect(harnessTurnTransport(catalog('aider'))).toBe('text-cli');
  });

  it('uses ACP for every catalog entry that declares it', () => {
    for (const candidate of AI_LOCAL_HARNESSES.filter((item) => item.acp)) {
      expect(harnessTurnTransport(candidate as AiLocalHarnessDefinition), candidate.command).toBe('acp');
    }
  });

  it('keeps native conversations on the transport that created their vendor session', () => {
    const openCode = catalog('opencode');
    expect(sessionTurnTransport(openCode, {})).toBe('acp');
    for (const command of ['gemini', 'goose', 'kiro', 'qwen', 'auggie', 'cursor']) {
      expect(sessionTurnTransport(catalog(command), { nativeSessionId: 'old-cli-thread' }), command).toBe('structured-cli');
    }
    expect(sessionTurnTransport(openCode, { nativeSessionId: 'new-acp-thread', nativeTransport: 'acp' })).toBe('acp');
    const cursor = catalog('cursor');
    expect(sessionTurnTransport(cursor, { nativeSessionId: 'fallback-thread', nativeTransport: 'structured-cli' })).toBe('structured-cli');
    expect(sessionTurnTransport(openCode, { nativeSessionId: 'locally-minted', nativeSessionPreallocated: true })).toBe('acp');
  });

  it('never pins a thread to the CLI when ACP and the CLI share one session store', () => {
    // Grok Build: `grok agent stdio` loads a `grok -p` thread and `grok -p
    // --resume` continues an ACP one (verified live both ways). A chat once
    // pinned to the one-shot CLI by a single fallback turn kept no process
    // alive between turns, so subagents it started died with each turn.
    // Claude Code, OpenCode and Kilo verified the same way.
    for (const command of ['grok', 'claude', 'opencode', 'kilo']) {
      const shared = catalog(command);
      expect(sessionTurnTransport(shared, { nativeSessionId: 'old-cli-thread' }), command).toBe('acp');
      expect(sessionTurnTransport(shared, { nativeSessionId: 'fallback-thread', nativeTransport: 'structured-cli' }), command).toBe('acp');
      expect(sessionTurnTransport(shared, { nativeSessionId: 'acp-thread', nativeTransport: 'acp' }), command).toBe('acp');
    }
  });

  it('decides from the declaration, not the command name', () => {
    const renamed = { ...catalog('cursor'), command: 'copilot' };
    expect(harnessTurnTransport(renamed)).toBe('acp');
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
