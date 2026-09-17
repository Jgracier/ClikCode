import { describe, expect, it } from 'vitest';
import { AI_LOCAL_HARNESSES, AI_LOCAL_HARNESS_ADAPTER_VERSION, localHarnessForCommand, localHarnessForProvider, nativeHarnessLaunchArgv, nativeHarnessTurnArgv, selectLocalHarnessRoute, type AiHarnessAccount } from './ai-local-harness';

const account: AiHarnessAccount = {
  id: 'local-codex',
  provider: 'openai',
  label: 'Work Codex',
  authKind: 'oauth',
  models: ['gpt-5.6'],
  status: 'ready',
  credentialRef: 'keychain://clikdeploy/work-codex',
};

const candidate = {
  accountId: account.id,
  provider: 'openai',
  model: 'gpt-5.6',
  accessClass: 'subscription' as const,
  estimatedCostPerMTok: null,
  contextWindowTokens: 128_000,
};

describe('selectLocalHarnessRoute', () => {
  it('uses the shared router while returning only an account identity, never a credential reference', () => {
    expect(selectLocalHarnessRoute([account], [candidate], { route: 'local', strategy: 'auto' })).toMatchObject({
      route: 'local', accountId: 'local-codex', provider: 'openai', model: 'gpt-5.6',
    });
  });

  it('does not route through an account that is not ready', () => {
    expect(selectLocalHarnessRoute([{ ...account, status: 'needs_login' }], [candidate], {
      route: 'local', strategy: 'auto',
    })).toEqual({ route: 'local', reason: 'no ready local account has an eligible model' });
  });

  it('does not inspect local accounts for an explicitly selected gateway route', () => {
    expect(selectLocalHarnessRoute([account], [candidate], { route: 'gateway', strategy: 'auto' })).toEqual({
      route: 'gateway', reason: 'gateway route explicitly selected',
    });
  });
});

describe('local harness catalog', () => {
  it('publishes a versioned adapter contract', () => {
    expect(AI_LOCAL_HARNESS_ADAPTER_VERSION).toBe(2);
  });

  it('uses one reversible command/provider mapping for every supported local harness', () => {
    expect(AI_LOCAL_HARNESSES.map((item) => item.command)).toEqual([
      'claude', 'codex', 'gemini', 'opencode', 'copilot', 'aider', 'goose', 'amp', 'pi',
      'droid', 'kiro', 'qwen', 'cline', 'roo', 'kilo', 'cursor', 'windsurf', 'crush',
      'hermes', 'command',
    ]);
    for (const harness of AI_LOCAL_HARNESSES) {
      expect(localHarnessForCommand(harness.command)).toEqual(harness);
      expect(localHarnessForProvider(harness.provider)).toEqual(harness);
      expect(['terminal', 'editor-extension']).toContain(harness.surface);
    }
  });

  it('declares exact resume arguments only for harnesses with a verified native contract', () => {
    expect(localHarnessForCommand('claude')?.session).toEqual({ idKind: 'uuid', createIdPrefix: ['--session-id'], continueArgv: ['--continue'], resumeIdPrefix: ['--resume'] });
    expect(localHarnessForCommand('codex')?.session).toEqual({ continueArgv: ['resume', '--last'], resumeIdPrefix: ['resume'] });
    expect(localHarnessForCommand('gemini')?.session).toMatchObject({ continueArgv: ['--resume', 'latest'], resumeIdPrefix: ['--resume'] });
    expect(localHarnessForCommand('opencode')?.session).toMatchObject({ continueArgv: ['--continue'], resumeIdPrefix: ['--session'] });
    expect(localHarnessForCommand('aider')?.session).toEqual({ idKind: 'history-file', createIdPrefix: ['--chat-history-file'], resumeIdPrefix: ['--chat-history-file'], resumeIdSuffix: ['--restore-chat-history'] });
  });

  it('does not advertise editor extensions as terminal harnesses', () => {
    expect(localHarnessForCommand('roo')?.surface).toBe('editor-extension');
    expect(localHarnessForCommand('windsurf')?.surface).toBe('editor-extension');
    expect(localHarnessForCommand('cursor')).toMatchObject({ surface: 'terminal', binary: 'cursor-agent' });
    expect(localHarnessForCommand('kiro')).toMatchObject({ surface: 'terminal', binary: 'kiro-cli' });
    expect(localHarnessForCommand('command')).toMatchObject({ surface: 'terminal', binary: 'cmdc' });
  });

  it('keeps every terminal harness behind a centralized one-shot adapter', () => {
    for (const harness of AI_LOCAL_HARNESSES.filter((item) => item.surface === 'terminal')) {
      expect(harness.turn, harness.command).toBeDefined();
    }
  });

  it('builds headless Codex turns instead of launching the Codex TUI', () => {
    const codex = localHarnessForCommand('codex')!;
    expect(nativeHarnessTurnArgv(codex, { prompt: 'inspect this', model: 'gpt-5', workspace: '/repo', effort: 'medium' }))
      .toEqual(['exec', '--json', '--skip-git-repo-check', '--model', 'gpt-5', '--cd', '/repo', '--config', 'model_reasoning_effort="medium"', '-']);
    expect(nativeHarnessTurnArgv(codex, { prompt: 'continue', nativeSessionId: 'thread-id', workspace: '/repo' }))
      .toEqual(['exec', 'resume', 'thread-id', '--json', '--skip-git-repo-check', '-']);
  });

  it('builds headless Claude create and resume turns', () => {
    const claude = localHarnessForCommand('claude')!;
    expect(nativeHarnessTurnArgv(claude, { prompt: 'hello', nativeSessionId: 'new-id', createdHere: true, effort: 'high' }))
      .toEqual(['-p', '--verbose', '--output-format', 'stream-json', '--session-id', 'new-id', '--effort', 'high', 'hello']);
    expect(nativeHarnessTurnArgv(claude, { prompt: 'again', nativeSessionId: 'old-id' }))
      .toEqual(['-p', '--verbose', '--output-format', 'stream-json', '--resume', 'old-id', 'again']);
    expect(nativeHarnessTurnArgv(claude, { prompt: 'safe edit', permissionMode: 'workspace-write' }))
      .toEqual(['-p', '--verbose', '--output-format', 'stream-json', '--permission-mode', 'acceptEdits', '--permission-prompts', 'none', 'safe edit']);
    expect(nativeHarnessTurnArgv(localHarnessForCommand('codex')!, { prompt: 'inspect', permissionMode: 'read-only' }))
      .toEqual(['exec', '--json', '--skip-git-repo-check', '--sandbox', 'read-only', '-']);
    expect(nativeHarnessTurnArgv(localHarnessForCommand('codex')!, { prompt: 'continue', nativeSessionId: 'thread-id', permissionMode: 'workspace-write' }))
      .toEqual(['exec', '--sandbox', 'workspace-write', 'resume', 'thread-id', '--json', '--skip-git-repo-check', '-']);
    expect(nativeHarnessTurnArgv(localHarnessForCommand('codex')!, { prompt: 'inspect', images: ['/tmp/screen.png'] }))
      .toEqual(['exec', '--json', '--skip-git-repo-check', '--image', '/tmp/screen.png', '-']);
  });

  it('builds exact create, resume, continuation, and selector argv from adapter declarations', () => {
    const claude = localHarnessForCommand('claude')!;
    expect(nativeHarnessLaunchArgv(claude, { nativeSessionId: 'new-id', createdHere: true, model: 'opus', effort: 'high' }))
      .toEqual(['--session-id', 'new-id', '--model', 'opus', '--effort', 'high']);
    expect(nativeHarnessLaunchArgv(claude, { nativeSessionId: 'old-id' })).toEqual(['--resume', 'old-id']);
    expect(nativeHarnessLaunchArgv(claude, { launchedBefore: true })).toEqual(['--continue']);

    const aider = localHarnessForCommand('aider')!;
    expect(nativeHarnessLaunchArgv(aider, { nativeSessionId: '/tmp/chat.md' }))
      .toEqual(['--chat-history-file', '/tmp/chat.md', '--restore-chat-history']);

    const codex = localHarnessForCommand('codex')!;
    expect(nativeHarnessLaunchArgv(codex, { nativeSessionId: 'thread-id', model: 'gpt-5', workspace: '/repo' }))
      .toEqual(['resume', 'thread-id', '--model', 'gpt-5', '--cd', '/repo']);

    const kiro = localHarnessForCommand('kiro')!;
    expect(nativeHarnessLaunchArgv(kiro, {})).toEqual(['chat']);
    expect(nativeHarnessLaunchArgv(kiro, { nativeSessionId: 'chat-id' })).toEqual(['chat', '--resume-id', 'chat-id']);

    const pi = localHarnessForCommand('pi')!;
    expect(nativeHarnessLaunchArgv(pi, { nativeSessionId: 'new-id', createdHere: true, effort: 'xhigh' }))
      .toEqual(['--session-id', 'new-id', '--thinking', 'xhigh']);
    expect(nativeHarnessLaunchArgv(pi, { nativeSessionId: 'old-id' })).toEqual(['--session', 'old-id']);

    const cline = localHarnessForCommand('cline')!;
    expect(nativeHarnessLaunchArgv(cline, { nativeSessionId: 'session-id', model: 'openai/gpt-5', workspace: '/repo', effort: 'high' }))
      .toEqual(['--id', 'session-id', '--model', 'openai/gpt-5', '--cwd', '/repo', '--thinking', 'high']);
  });
});
