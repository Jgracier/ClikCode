import { describe, expect, it } from 'vitest';
import { AI_LOCAL_HARNESSES, AI_LOCAL_HARNESS_ADAPTER_VERSION, harnessIntegrationLevel, harnessSupportsEffort, harnessSupportsImages, harnessSupportsPermissionMode, localHarnessCapabilityManifest, localHarnessForCommand, localHarnessForProvider, nativeHarnessLaunchArgv, nativeHarnessTurnArgv, selectLocalHarnessRoute, type AiHarnessAccount } from './ai-local-harness';

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
    expect(AI_LOCAL_HARNESS_ADAPTER_VERSION).toBe(6);
  });

  it('reports integration depth without overstating compatibility adapters', () => {
    expect(harnessIntegrationLevel(localHarnessForCommand('codex')!)).toBe('native');
    expect(harnessIntegrationLevel(localHarnessForCommand('cursor')!)).toBe('structured');
    expect(harnessIntegrationLevel(localHarnessForCommand('aider')!)).toBe('compatibility');
    expect(harnessIntegrationLevel(localHarnessForCommand('roo')!)).toBe('editor-only');
  });

  it('uses the documented Kiro auth and OpenCode discovery contracts', () => {
    expect(localHarnessForCommand('kiro')?.localAuth).toEqual(['api-key']);
    expect(localHarnessForCommand('opencode')?.session).toMatchObject({
      discoverArgv: ['session', 'list', '--format', 'json'], discoverFormat: 'json',
    });
  });

  it('uses one reversible command/provider mapping for every supported local harness', () => {
    expect(AI_LOCAL_HARNESSES.map((item) => item.command)).toEqual([
      'claude', 'codex', 'gemini', 'opencode', 'copilot', 'aider', 'goose', 'amp', 'antigravity', 'pi',
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

  it('publishes a valid, duplicate-free normalized option manifest for every harness', () => {
    for (const harness of AI_LOCAL_HARNESSES) {
      const manifest = localHarnessCapabilityManifest(harness);
      const ids = manifest.options.map((option) => option.id);
      expect(new Set(ids).size, harness.command).toBe(ids.length);
      for (const option of manifest.options) {
        expect(option.description.length, `${harness.command}:${option.id}`).toBeGreaterThan(0);
        if (option.kind === 'enum') expect(option.values?.length, `${harness.command}:${option.id}`).toBeGreaterThan(0);
      }
    }
  });

  it('maps only declared provider options into argv and rejects unknown values', () => {
    const claude = localHarnessForCommand('claude')!;
    expect(nativeHarnessTurnArgv(claude, { prompt: 'inspect', options: { 'safe-mode': true, 'add-dir': ['/one', '/two'] } }))
      .toEqual(['-p', '--verbose', '--output-format', 'stream-json', '--include-partial-messages', '--safe-mode', '--add-dir', '/one', '--add-dir', '/two', 'inspect']);
    expect(() => nativeHarnessTurnArgv(claude, { prompt: 'inspect', options: { invented: true } }))
      .toThrow('does not declare option "invented"');
    const cursor = localHarnessForCommand('cursor')!;
    expect(() => nativeHarnessTurnArgv(cursor, { prompt: 'inspect', options: { mode: 'yolo' } }))
      .toThrow('Execution mode must be one of plan, ask');
    const codex = localHarnessForCommand('codex')!;
    expect(nativeHarnessTurnArgv(codex, { prompt: 'research', options: { search: true } }))
      .toEqual(['--search', 'exec', '--json', '--skip-git-repo-check', '-']);
    expect(nativeHarnessTurnArgv(codex, { prompt: 'push changes', permissionMode: 'ask', options: { 'network-access': true } }))
      .toEqual(['--config', 'sandbox_workspace_write.network_access=true', '--sandbox', 'workspace-write', '--ask-for-approval', 'on-request', 'exec', '--json', '--skip-git-repo-check', '-']);
    const pi = localHarnessForCommand('pi')!;
    const piArgv = nativeHarnessTurnArgv(pi, { prompt: 'inspect', options: { tools: ['read', 'bash'] } });
    expect(piArgv).toContain('read,bash');
    expect(piArgv.filter((arg) => arg === '--tools')).toHaveLength(1);
  });

  it('builds headless Codex turns instead of launching the Codex TUI', () => {
    const codex = localHarnessForCommand('codex')!;
    expect(nativeHarnessTurnArgv(codex, { prompt: 'inspect this', model: 'gpt-5', workspace: '/repo', effort: 'medium' }))
      .toEqual(['exec', '--json', '--skip-git-repo-check', '--model', 'gpt-5', '--cd', '/repo', '--config', 'model_reasoning_effort="medium"', '-']);
    expect(nativeHarnessTurnArgv(codex, { prompt: 'continue', nativeSessionId: 'thread-id', workspace: '/repo' }))
      .toEqual(['exec', 'resume', 'thread-id', '--json', '--skip-git-repo-check', '-']);
  });

  it('uses each vendor\'s exact native-session selector', () => {
    expect(nativeHarnessTurnArgv(localHarnessForCommand('droid')!, { prompt: 'continue', nativeSessionId: 'droid-thread' }))
      .toEqual(['exec', '--output-format', 'json', '--session-id', 'droid-thread', 'continue']);
    expect(nativeHarnessTurnArgv(localHarnessForCommand('kiro')!, { prompt: 'continue', nativeSessionId: 'kiro-thread', effort: 'high' }))
      .toEqual(['chat', '--no-interactive', '--agent-engine', 'v3', '--output-format', 'stream-json', '--resume-id', 'kiro-thread', '--effort', 'high', 'continue']);
  });

  it('builds headless Claude create and resume turns', () => {
    const claude = localHarnessForCommand('claude')!;
    expect(nativeHarnessTurnArgv(claude, { prompt: 'hello', nativeSessionId: 'new-id', createdHere: true, effort: 'high' }))
      .toEqual(['-p', '--verbose', '--output-format', 'stream-json', '--include-partial-messages', '--session-id', 'new-id', '--effort', 'high', 'hello']);
    expect(nativeHarnessTurnArgv(claude, { prompt: 'again', nativeSessionId: 'old-id' }))
      .toEqual(['-p', '--verbose', '--output-format', 'stream-json', '--include-partial-messages', '--resume', 'old-id', 'again']);
    expect(nativeHarnessTurnArgv(claude, { prompt: 'safe edit', permissionMode: 'ask' }))
      .toEqual(['-p', '--verbose', '--output-format', 'stream-json', '--include-partial-messages', '--permission-mode', 'manual', '--permission-prompts', 'none', 'safe edit']);
    expect(nativeHarnessTurnArgv(localHarnessForCommand('codex')!, { prompt: 'inspect', permissionMode: 'ask' }))
      .toEqual(['--sandbox', 'workspace-write', '--ask-for-approval', 'on-request', 'exec', '--json', '--skip-git-repo-check', '-']);
    expect(nativeHarnessTurnArgv(localHarnessForCommand('codex')!, { prompt: 'continue', nativeSessionId: 'thread-id', permissionMode: 'bypass' }))
      .toEqual(['--sandbox', 'danger-full-access', '--ask-for-approval', 'never', 'exec', 'resume', 'thread-id', '--json', '--skip-git-repo-check', '-']);
    expect(nativeHarnessTurnArgv(localHarnessForCommand('codex')!, { prompt: 'inspect', permissionMode: 'auto' }))
      .toEqual(['--approve-for-me', 'exec', '--json', '--skip-git-repo-check', '-']);
    expect(nativeHarnessTurnArgv(localHarnessForCommand('codex')!, { prompt: 'inspect', images: ['/tmp/screen.png'] }))
      .toEqual(['exec', '--json', '--skip-git-repo-check', '--image', '/tmp/screen.png', '-']);
  });

  it('leaves permission mode as a no-op for a harness that does not declare support for it', () => {
    const goose = localHarnessForCommand('goose')!;
    expect(harnessSupportsPermissionMode(goose, 'ask')).toBe(false);
    expect(nativeHarnessTurnArgv(goose, { prompt: 'inspect', permissionMode: 'ask' }))
      .toEqual(['run', '--output-format', 'stream-json', '--text', 'inspect']);
  });

  it('declares effort support only where a real flag exists', () => {
    expect(harnessSupportsEffort(localHarnessForCommand('codex')!)).toBe(true);
    expect(harnessSupportsEffort(localHarnessForCommand('claude')!)).toBe(true);
    expect(harnessSupportsEffort(localHarnessForCommand('gemini')!)).toBe(false);
  });

  it('declares permission-mode support for exactly the harnesses that map it to a real flag', () => {
    const fullThreeTier = new Set(['codex', 'claude', 'gemini', 'cursor', 'qwen', 'droid', 'command']);
    const askAndAuto = new Set(['kilo']);
    const askAndBypass = new Set([
      'opencode', 'copilot', 'aider', 'antigravity', 'kiro', 'cline',
      'crush', 'hermes', 'command',
    ]);
    for (const harness of AI_LOCAL_HARNESSES) {
      expect(harnessSupportsPermissionMode(harness, 'ask')).toBe(fullThreeTier.has(harness.command) || askAndBypass.has(harness.command) || askAndAuto.has(harness.command));
      expect(harnessSupportsPermissionMode(harness, 'bypass')).toBe(fullThreeTier.has(harness.command) || askAndBypass.has(harness.command));
      expect(harnessSupportsPermissionMode(harness, 'auto')).toBe(fullThreeTier.has(harness.command) || askAndAuto.has(harness.command));
    }
  });

  it('maps each newly-supported harness\'s permission modes to its own real, confirmed flags', () => {
    const opencode = localHarnessForCommand('opencode')!;
    expect(nativeHarnessTurnArgv(opencode, { prompt: 'hi', permissionMode: 'bypass' })).toContain('--auto');
    expect(nativeHarnessTurnArgv(opencode, { prompt: 'hi', permissionMode: 'ask' })).not.toContain('--auto');

    const cursor = localHarnessForCommand('cursor')!;
    expect(nativeHarnessTurnArgv(cursor, { prompt: 'hi', permissionMode: 'ask' })).not.toContain('--force');
    expect(nativeHarnessTurnArgv(cursor, { prompt: 'hi', permissionMode: 'bypass' })).toContain('--force');
    expect(nativeHarnessTurnArgv(cursor, { prompt: 'hi', permissionMode: 'auto' })).toContain('--auto-review');

    const hermes = localHarnessForCommand('hermes')!;
    expect(nativeHarnessTurnArgv(hermes, { prompt: 'hi', permissionMode: 'bypass' })).toContain('--yolo');
    expect(nativeHarnessTurnArgv(hermes, { prompt: 'hi', permissionMode: 'ask' })).not.toContain('--yolo');

    const antigravity = localHarnessForCommand('antigravity')!;
    expect(nativeHarnessTurnArgv(antigravity, { prompt: 'hi', permissionMode: 'ask' })).not.toContain('--mode');
    const antigravityBypass = nativeHarnessTurnArgv(antigravity, { prompt: 'hi', permissionMode: 'bypass' });
    expect(antigravityBypass).toContain('--dangerously-skip-permissions');

    expect(nativeHarnessTurnArgv(localHarnessForCommand('qwen')!, { prompt: 'hi', permissionMode: 'auto' }))
      .toEqual(expect.arrayContaining(['--approval-mode', 'auto']));
    expect(nativeHarnessTurnArgv(localHarnessForCommand('droid')!, { prompt: 'hi', permissionMode: 'auto' }))
      .toEqual(expect.arrayContaining(['--auto', 'low']));
    expect(nativeHarnessTurnArgv(localHarnessForCommand('droid')!, { prompt: 'hi', permissionMode: 'bypass' }))
      .toContain('--skip-permissions-unsafe');

    const cases: Array<[string, string[], string[]]> = [
      ['gemini', ['--approval-mode', 'default'], ['--approval-mode', 'yolo']],
      ['qwen', ['--approval-mode', 'default'], ['--approval-mode', 'yolo']],
      ['copilot', [], ['--allow-all']],
      ['aider', [], ['--yes-always']],
      ['kiro', [], ['--trust-all-tools']],
      ['cline', ['--auto-approve', 'false'], ['--auto-approve', 'true']],
      ['crush', [], ['--yolo']],
      ['command', [], ['--yolo']],
    ];
    for (const [command, askArgs, bypassArgs] of cases) {
      const harness = localHarnessForCommand(command)!;
      const ask = nativeHarnessTurnArgv(harness, { prompt: 'hi', permissionMode: 'ask' });
      const bypass = nativeHarnessTurnArgv(harness, { prompt: 'hi', permissionMode: 'bypass' });
      for (const arg of askArgs) expect(ask, `${command}:ask`).toContain(arg);
      for (const arg of bypassArgs) expect(bypass, `${command}:bypass`).toContain(arg);
      if (bypassArgs.length) expect(bypass, command).not.toEqual(ask);
    }
    expect(nativeHarnessTurnArgv(localHarnessForCommand('kilo')!, { prompt: 'hi', permissionMode: 'auto' })).toContain('--auto');
  });

  it('shows the exact normalized permission choices every mapped harness accepts', () => {
    for (const harness of AI_LOCAL_HARNESSES) {
      const option = localHarnessCapabilityManifest(harness).options.find((item) => item.id === 'permissions');
      if (harness.permissionModes?.length) {
        expect(option?.values, harness.command).toEqual(harness.permissionModes);
        for (const mode of harness.permissionModes) expect(harness.permissionArgv?.[mode], `${harness.command}:${mode}`).toBeDefined();
      }
      else expect(option, harness.command).toBeUndefined();
    }
  });

  it('hides native aliases that could contradict the normalized permission setting', () => {
    const aliases: Record<string, string[]> = {
      gemini: ['approval-mode'], opencode: ['auto-approve'], copilot: ['allow-all'],
      qwen: ['approval-mode'], cline: ['auto-approve'], cursor: ['auto-review', 'force'], hermes: ['yolo'],
    };
    for (const [command, ids] of Object.entries(aliases)) {
      const harness = localHarnessForCommand(command)!;
      const visible = localHarnessCapabilityManifest(harness).options.map((option) => option.id);
      for (const id of ids) expect(visible, `${command}:${id}`).not.toContain(id);
      expect(() => nativeHarnessTurnArgv(harness, { prompt: 'hi', permissionMode: 'ask', options: Object.fromEntries(ids.map((id) => [id, true])) })).not.toThrow();
    }
  });

  it('declares image-attachment support only where a real flag exists, and drops images silently otherwise', () => {
    expect(harnessSupportsImages(localHarnessForCommand('codex')!)).toBe(true);
    expect(harnessSupportsImages(localHarnessForCommand('claude')!)).toBe(false);
    expect(nativeHarnessTurnArgv(localHarnessForCommand('claude')!, { prompt: 'inspect', nativeSessionId: 'new-id', createdHere: true, images: ['/tmp/screen.png'] }))
      .not.toContain('/tmp/screen.png');
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
