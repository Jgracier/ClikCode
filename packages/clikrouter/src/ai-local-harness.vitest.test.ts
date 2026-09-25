import { afterEach, describe, expect, it } from 'vitest';
import { modelDisplayId, modelIdFromDisplay, AI_LOCAL_HARNESSES, AI_LOCAL_HARNESS_ADAPTER_VERSION, AI_LOCAL_HARNESS_CAPABILITIES, HOME_REDIRECT_ENV_DEFAULTS, allLocalHarnesses, customAcpHarness, guardedPromptArgv, harnessAcpLaunch, harnessLoginArgvForModel, harnessReplyError, harnessCanRunTurns, harnessTierRank, harnessTurnTransport, maxPromptArgvBytes, promptExceedsArgvLimit, registerCustomHarnesses, harnessIntegrationLevel, harnessSupportsEffort, harnessSupportsImages, harnessSupportsPermissionMode, localHarnessCapabilityManifest, localHarnessForCommand, localHarnessForProvider, nativeHarnessLaunchArgv, nativeHarnessTurnArgv } from './ai-local-harness';


describe('local harness catalog', () => {
  it('publishes a versioned adapter contract', () => {
    expect(AI_LOCAL_HARNESS_ADAPTER_VERSION).toBe(7);
  });

  it('reports integration depth without overstating compatibility adapters', () => {
    expect(harnessIntegrationLevel(localHarnessForCommand('codex')!)).toBe('native');
    expect(harnessIntegrationLevel(localHarnessForCommand('cursor')!)).toBe('structured');
    expect(harnessIntegrationLevel(localHarnessForCommand('aider')!)).toBe('compatibility');
    expect(harnessIntegrationLevel(localHarnessForCommand('copilot')!)).toBe('structured');
  });

  it('uses the documented Kiro auth and OpenCode discovery contracts', () => {
    // `kiro-cli login` (Builder ID, Identity Center) and KIRO_API_KEY, both
    // read out of kiro-cli itself.
    expect(localHarnessForCommand('kiro')?.localAuth).toEqual(['api-key', 'oauth', 'vendor-cli']);
    expect(localHarnessForCommand('opencode')?.session).toMatchObject({
      discoverArgv: ['session', 'list', '--format', 'json'], discoverFormat: 'json',
    });
  });

  it('uses one reversible command/provider mapping for every supported local harness', () => {
    // Sorted, not in declaration order: array position carries no meaning
    // (the pickers sort by harnessTierRank), so pinning the order only broke
    // this test every time an entry was inserted. The SET still catches a
    // harness silently appearing or disappearing, which is the part worth
    // guarding.
    expect(AI_LOCAL_HARNESSES.map((item) => item.command).sort()).toEqual([
      'aider', 'amp', 'antigravity', 'auggie', 'claude', 'cline', 'cn', 'codex',
      'command', 'copilot', 'cursor', 'droid', 'gemini', 'goose', 'grok', 'hermes',
      'kilo', 'kimi', 'kiro', 'openclaw', 'opencode', 'openhands', 'pi', 'qwen', 'vibe',
    ]);
    for (const harness of AI_LOCAL_HARNESSES) {
      expect(localHarnessForCommand(harness.command)).toEqual(harness);
      expect(localHarnessForProvider(harness.provider)).toEqual(harness);
      expect(harness.surface).toBe('terminal');
    }
  });

  it('declares exact resume arguments only for harnesses with a verified native contract', () => {
    expect(localHarnessForCommand('claude')?.session).toEqual({ idKind: 'uuid', createIdPrefix: ['--session-id'], continueArgv: ['--continue'], resumeIdPrefix: ['--resume'] });
    expect(localHarnessForCommand('codex')?.session).toEqual({ continueArgv: ['resume', '--last'], resumeIdPrefix: ['resume'] });
    expect(localHarnessForCommand('gemini')?.session).toMatchObject({ continueArgv: ['--resume', 'latest'], resumeIdPrefix: ['--resume'] });
    expect(localHarnessForCommand('opencode')?.session).toMatchObject({ continueArgv: ['--continue'], resumeIdPrefix: ['--session'] });
    expect(localHarnessForCommand('aider')?.session).toEqual({ idKind: 'history-file', createIdPrefix: ['--chat-history-file'], resumeIdPrefix: ['--chat-history-file'], resumeIdSuffix: ['--restore-chat-history'] });
  });

  it('carries no editor-extension-only product and binds the real terminal binaries', () => {
    expect(localHarnessForCommand('roo')).toBeUndefined();
    expect(localHarnessForCommand('windsurf')).toBeUndefined();
    expect(AI_LOCAL_HARNESS_CAPABILITIES.roo).toBeUndefined();
    expect(AI_LOCAL_HARNESS_CAPABILITIES.windsurf).toBeUndefined();
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
      .toEqual(['-p', '--verbose', '--output-format', 'stream-json', '--include-partial-messages', '--safe-mode', '--add-dir', '/one', '--add-dir', '/two']);
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
      .toEqual(['exec', '--output-format', 'stream-json', '--session-id', 'droid-thread', 'continue']);
    expect(nativeHarnessTurnArgv(localHarnessForCommand('kiro')!, { prompt: 'continue', nativeSessionId: 'kiro-thread', effort: 'high' }))
      .toEqual(['chat', '--no-interactive', '--agent-engine', 'v3', '--output-format', 'stream-json', '--resume-id', 'kiro-thread', '--effort', 'high', 'continue']);
  });

  it('builds headless Claude create and resume turns', () => {
    const claude = localHarnessForCommand('claude')!;
    expect(nativeHarnessTurnArgv(claude, { prompt: 'hello', nativeSessionId: 'new-id', createdHere: true, effort: 'high' }))
      .toEqual(['-p', '--verbose', '--output-format', 'stream-json', '--include-partial-messages', '--session-id', 'new-id', '--effort', 'high']);
    expect(nativeHarnessTurnArgv(claude, { prompt: 'again', nativeSessionId: 'old-id' }))
      .toEqual(['-p', '--verbose', '--output-format', 'stream-json', '--include-partial-messages', '--resume', 'old-id']);
    expect(nativeHarnessTurnArgv(claude, { prompt: 'safe edit', permissionMode: 'ask' }))
      .toEqual(['-p', '--verbose', '--output-format', 'stream-json', '--include-partial-messages', '--permission-mode', 'manual', '--permission-prompts', 'none']);
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
    const amp = localHarnessForCommand('amp')!;
    expect(harnessSupportsPermissionMode(amp, 'ask')).toBe(false);
    expect(nativeHarnessTurnArgv(amp, { prompt: 'inspect', permissionMode: 'ask' }))
      .toEqual(nativeHarnessTurnArgv(amp, { prompt: 'inspect' }));
  });

  it('carries Goose’s permission mode in GOOSE_MODE, adding nothing to argv', () => {
    const goose = localHarnessForCommand('goose')!;
    for (const mode of ['ask', 'bypass', 'auto'] as const) {
      expect(harnessSupportsPermissionMode(goose, mode)).toBe(true);
      expect(nativeHarnessTurnArgv(goose, { prompt: 'inspect', permissionMode: mode }))
        .toEqual(['run', '--output-format', 'stream-json', '--text', 'inspect']);
    }
    expect(goose.permissionEnv?.ask).toEqual({ GOOSE_MODE: 'approve' });
  });

  it('declares effort support only where a real flag exists', () => {
    expect(harnessSupportsEffort(localHarnessForCommand('codex')!)).toBe(true);
    expect(harnessSupportsEffort(localHarnessForCommand('claude')!)).toBe(true);
    expect(harnessSupportsEffort(localHarnessForCommand('gemini')!)).toBe(false);
  });

  it('declares permission-mode support for exactly the harnesses that map it to a real flag', () => {
    // Kept hardcoded on purpose: deriving these from the catalog would make
    // the test agree with whatever the catalog says, which is not a test.
    // grok, kimi, vibe, openhands and cn were added after the previous lists
    // were written.
    const fullThreeTier = new Set(['codex', 'claude', 'grok', 'gemini', 'cursor', 'qwen', 'droid', 'command', 'kimi', 'vibe', 'goose']);
    const askAndAuto = new Set(['kilo']);
    const bypassAndAuto = new Set(['openhands']);
    const askAndBypass = new Set([
      'opencode', 'copilot', 'aider', 'antigravity', 'kiro', 'cline',
      'hermes', 'cn',
    ]);
    for (const harness of AI_LOCAL_HARNESSES) {
      expect(harnessSupportsPermissionMode(harness, 'ask'), `${harness.command} ask`).toBe(fullThreeTier.has(harness.command) || askAndBypass.has(harness.command) || askAndAuto.has(harness.command));
      expect(harnessSupportsPermissionMode(harness, 'bypass'), `${harness.command} bypass`).toBe(fullThreeTier.has(harness.command) || askAndBypass.has(harness.command) || bypassAndAuto.has(harness.command));
      expect(harnessSupportsPermissionMode(harness, 'auto'), `${harness.command} auto`).toBe(fullThreeTier.has(harness.command) || askAndAuto.has(harness.command) || bypassAndAuto.has(harness.command));
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
    const openclaw = localHarnessForCommand('openclaw')!;
    expect(nativeHarnessTurnArgv(openclaw, { prompt: 'hi', model: 'openai/gpt', effort: 'low' })).toEqual([
      'agent', '--local', '--json', '--agent', 'main', '--model', 'openai/gpt', '--thinking', 'low', '--message', 'hi',
    ]);
    expect(nativeHarnessTurnArgv(openclaw, { prompt: 'hi', nativeSessionId: 'sess-1' })).toEqual([
      'agent', '--local', '--json', '--agent', 'main', '--session-id', 'sess-1', '--message', 'hi',
    ]);
    expect(nativeHarnessTurnArgv(openclaw, { prompt: 'hi', nativeSessionId: 'agent:main:main' })).toEqual([
      'agent', '--local', '--json', '--agent', 'main', '--session-key', 'agent:main:main', '--message', 'hi',
    ]);
    expect(nativeHarnessTurnArgv(hermes, { prompt: 'hi', permissionMode: 'bypass' })).toContain('--yolo');
    expect(nativeHarnessTurnArgv(hermes, { prompt: 'hi', permissionMode: 'ask' })).not.toContain('--yolo');
    // A Hermes model id names its provider; the CLI takes the halves apart,
    // and a stored provider option cannot override the model's.
    const turn = nativeHarnessTurnArgv(hermes, { prompt: 'hi', model: 'opencode-free:nemotron-3-ultra-free', options: { provider: 'openai-codex' } });
    expect(turn).toEqual(expect.arrayContaining(['--provider', 'opencode-free', '--model', 'nemotron-3-ultra-free']));
    expect(turn).not.toContain('openai-codex');
    expect(nativeHarnessTurnArgv(hermes, { prompt: 'hi', model: 'custom:local:qwen3:8b' })).toEqual(expect.arrayContaining(['--provider', 'custom:local', '--model', 'qwen3:8b']));
    expect(nativeHarnessTurnArgv(hermes, { prompt: 'hi', model: 'anthropic/claude-3.5-sonnet:beta' })).not.toContain('--provider');
    // Signing in follows the model's provider; a reply that is a failed call
    // is read as one.
    expect(harnessLoginArgvForModel(hermes, 'opencode-free:hy3-free')).toEqual(['auth', 'add', 'opencode-free']);
    expect(harnessLoginArgvForModel(hermes, undefined)).toEqual(['model']);
    expect(harnessReplyError(hermes, 'API call failed after 3 retries: HTTP 429: The usage limit has been reached')).toEqual({ statusCode: 429 });
    expect(harnessReplyError(hermes, 'HTTP 400: {"detail":"not supported"}')).toEqual({ statusCode: 400 });
    expect(harnessReplyError(hermes, 'No access token found for Nous Portal login. Run `hermes model` to\r\nre-authenticate.')).toEqual({ statusCode: 401 });
    expect(harnessReplyError(hermes, 'The fix returns HTTP 400: when the body is empty.')).toBeUndefined();
    const claw = localHarnessForCommand('openclaw')!;
    expect(harnessLoginArgvForModel(claw, 'openai/gpt-5.5')).toEqual(['models', 'auth', 'login', '--provider', 'openai']);
    expect(harnessLoginArgvForModel(claw, 'openrouter/moonshotai/kimi-k2')).toEqual(['models', 'auth', 'login', '--provider', 'openrouter']);
    for (const command of ['opencode', 'kilo']) {
      expect(harnessLoginArgvForModel(localHarnessForCommand(command)!, 'anthropic/claude-sonnet-5')).toEqual(['auth', 'login', '--provider', 'anthropic']);
    }
    const goose = localHarnessForCommand('goose')!;
    expect(goose.loginArgv).toEqual(['configure']);
    // Goose drives other CLIs as providers: `claude-code/sonnet` is Claude Code's
    // own sign-in, split at the first slash into Goose's two flags.
    expect(nativeHarnessTurnArgv(goose, { prompt: 'hi', model: 'claude-code/sonnet' })).toEqual(expect.arrayContaining(['--provider', 'claude-code', '--model', 'sonnet']));
    expect(nativeHarnessTurnArgv(goose, { prompt: 'hi', model: 'openrouter/anthropic/claude-5' })).toEqual(expect.arrayContaining(['--provider', 'openrouter', '--model', 'anthropic/claude-5']));
    expect(nativeHarnessTurnArgv(goose, { prompt: 'hi', model: 'sonnet' })).not.toContain('--provider');
    // Every harness that drives providers shows a model as provider:model, and
    // takes it back typed that way.
    expect(modelDisplayId(goose, 'claude-code/sonnet')).toBe('claude-code:sonnet');
    expect(modelDisplayId(goose, 'openrouter/anthropic/claude-5')).toBe('openrouter:anthropic/claude-5');
    expect(modelDisplayId(hermes, 'nous:z-ai/glm-5.2')).toBe('nous:z-ai/glm-5.2');
    expect(modelDisplayId(claw, 'openai/gpt-5.5')).toBe('openai:gpt-5.5');
    expect(modelDisplayId(localHarnessForCommand('pi')!, 'anthropic/claude-fable-5')).toBe('anthropic:claude-fable-5');
    expect(modelDisplayId(localHarnessForCommand('cline')!, 'anthropic/claude-sonnet-5'), 'Cline is one provider').toBe('anthropic/claude-sonnet-5');
    expect(modelIdFromDisplay(goose, 'claude-code:sonnet')).toBe('claude-code/sonnet');
    expect(modelIdFromDisplay(goose, 'ollama/qwen3:8b')).toBe('ollama/qwen3:8b');
    expect(modelIdFromDisplay(goose, 'ollama:qwen3:8b')).toBe('ollama/qwen3:8b');
    expect(modelIdFromDisplay(hermes, 'nous:z-ai/glm-5.2')).toBe('nous:z-ai/glm-5.2');
    expect(harnessLoginArgvForModel(goose, 'anthropic/claude-5')).toEqual(['configure']);
    // Goose never hands Claude Code its history; ClikCode carries it instead.
    expect(goose.turn?.statelessProviders).toEqual(['claude-code']);
    // Every harness either says whether it is signed in or cannot be asked
    // (Antigravity keeps its token in the system keyring only; the drivers
    // sign in per provider from the model picker).
    const unknowable = ['antigravity', 'goose'];
    for (const harness of AI_LOCAL_HARNESSES) {
      if (unknowable.includes(harness.command)) continue;
      expect(Boolean(harness.statusArgv || harness.authFiles?.length || harness.authEnv?.length), `${harness.command} sign-in state`).toBe(true);
      expect(harness.loginArgv, `${harness.command} sign-in`).toBeDefined();
    }
    expect(localHarnessForCommand('cn')!.loginArgv, 'cn 1.5 has no login subcommand').toEqual([]);
    expect(localHarnessForCommand('pi')!.loginArgv, 'Pi signs in inside its own session').toEqual([]);
    expect(nativeHarnessTurnArgv(claw, { prompt: 'hi', model: 'openai/gpt-5.5', nativeSessionId: 's-1', createdHere: true }))
      .toEqual(['agent', '--local', '--json', '--agent', 'main', '--session-id', 's-1', '--model', 'openai/gpt-5.5', '--message', 'hi']);

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
        for (const mode of harness.permissionModes) expect(harness.permissionArgv?.[mode] ?? harness.permissionEnv?.[mode], `${harness.command}:${mode}`).toBeDefined();
      }
      else expect(option, harness.command).toBeUndefined();
    }
  });

  it('hides native aliases that could contradict the normalized permission setting', () => {
    const aliases: Record<string, string[]> = {
      gemini: ['approval-mode'], opencode: ['auto-approve'],
      qwen: ['approval-mode'], cline: ['auto-approve'], cursor: ['auto-review', 'force'], hermes: ['yolo'],
    };
    for (const [command, ids] of Object.entries(aliases)) {
      const harness = localHarnessForCommand(command)!;
      const visible = localHarnessCapabilityManifest(harness).options.map((option) => option.id);
      for (const id of ids) expect(visible, `${command}:${id}`).not.toContain(id);
      expect(() => nativeHarnessTurnArgv(harness, { prompt: 'hi', permissionMode: 'ask', options: Object.fromEntries(ids.map((id) => [id, true])) })).not.toThrow();
    }
  });

  it('ignores an option id retired from an adapter instead of failing an upgraded session', () => {
    const copilot = localHarnessForCommand('copilot')!;
    expect(AI_LOCAL_HARNESS_CAPABILITIES.copilot!.options.map((option) => option.id)).not.toContain('allow-all');
    expect(copilot.normalizedPermissionOptionIds).toBeUndefined();
    expect(copilot.retiredOptionIds).toEqual(['allow-all']);
    expect(nativeHarnessTurnArgv(copilot, { prompt: 'hi', options: { 'allow-all': true } })).not.toContain('--allow-all');
  });

  it('declares only permission aliases that exist as live options', () => {
    for (const harness of AI_LOCAL_HARNESSES) {
      const declared = new Set((AI_LOCAL_HARNESS_CAPABILITIES[harness.command]?.options ?? []).map((option) => option.id));
      for (const id of harness.normalizedPermissionOptionIds ?? []) expect(declared.has(id), `${harness.command}:${id}`).toBe(true);
      for (const id of harness.retiredOptionIds ?? []) expect(declared.has(id), `${harness.command}:${id}`).toBe(false);
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

  it('declares transport, integration, tier, parser and memory file on every entry', () => {
    const transports = ['codex-app-server', 'acp', 'structured-cli', 'text-cli'];
    const parsers = ['claude-stream-json', 'codex-items', 'opencode-json', 'gemini-stream-json', 'cursor-stream-json', 'pi-json', 'cline-json', 'antigravity', 'goose', 'generic-json', 'text'];
    for (const harness of AI_LOCAL_HARNESSES) {
      expect(transports, harness.command).toContain(harness.transport);
      expect(['native', 'structured', 'compatibility'], harness.command).toContain(harness.integration);
      expect(['primary', 'more', 'experimental'], harness.command).toContain(harness.tier);
      expect(parsers, harness.command).toContain(harness.parser);
      expect(harness.memoryFile, harness.command).toMatch(/\.md$/);
      expect(typeof harness.nativeSlashPassthrough, harness.command).toBe('boolean');
      expect(harnessIntegrationLevel(harness), harness.command).toBe(harness.integration);
      // The declared level agrees with the structural reading of the contract.
      expect(harnessIntegrationLevel({ ...harness, integration: undefined }), harness.command).toBe(harness.integration);
      // A text parser and a text contract are the same statement.
      expect(harness.parser === 'text', harness.command).toBe(harness.turn?.output === 'text');
      if (harness.effortArgvPrefix) expect(harness.effortValues?.length, harness.command).toBeGreaterThan(0);
      else expect(harness.effortValues, harness.command).toBeUndefined();
    }
  });

  it('leaves no entry without a turn, and no capability row without an entry', () => {
    for (const harness of AI_LOCAL_HARNESSES) {
      expect(harness.turn, harness.command).toBeDefined();
      expect(harnessCanRunTurns(harness), harness.command).toBe(true);
    }
    const commands = new Set(AI_LOCAL_HARNESSES.map((item) => item.command));
    for (const command of Object.keys(AI_LOCAL_HARNESS_CAPABILITIES)) expect(commands.has(command), command).toBe(true);
  });

  it('declares ACP argv in the catalog, including the proven four and the experimental ones', () => {
    const acp = Object.fromEntries(AI_LOCAL_HARNESSES.filter((item) => item.acp).map((item) => [item.command, item.acp!]));
    expect(acp.cline).toMatchObject({ argv: ['--acp'] });
    expect(acp.copilot).toMatchObject({ argv: ['--acp', '--stdio'] });
    expect(acp.droid).toMatchObject({ argv: ['exec', '--output-format', 'acp'], optionPlacement: 'after' });
    expect(acp.hermes).toMatchObject({ argv: ['acp'] });
    for (const command of ['cline', 'copilot', 'droid', 'hermes']) {
      expect(acp[command]!.experimental, command).toBeUndefined();
      expect(localHarnessForCommand(command)!.transport, command).toBe('acp');
    }
    // gemini moved to a supported `--acp` (its own --help calls
    // --experimental-acp deprecated), so it is no longer in the experimental
    // group even though ClikCode still PREFERS its CLI transport.
    expect(acp.gemini).toMatchObject({ argv: ['--acp'] });
    expect(acp.gemini!.experimental).toBeUndefined();
    for (const [command, argv] of Object.entries({ opencode: ['acp'], goose: ['acp'], qwen: ['--experimental-acp'], kiro: ['acp'], kilo: ['acp'], auggie: ['--acp'] })) {
      expect(acp[command], command).toMatchObject({ argv, experimental: true });
      expect(localHarnessForCommand(command)!.transport, command).not.toBe('acp');
    }
    // kimi's ACP is a SUBCOMMAND, not a flag -- corrected in the catalog
    // against the real Kimi Code 2.0.2 and never reflected here.
    expect(acp.kimi).toMatchObject({ argv: ['acp'] });
    expect(acp.vibe).toEqual({ binary: 'vibe-acp', argv: [] });
    expect(acp.openhands).toMatchObject({ argv: ['acp'] });
    for (const harness of AI_LOCAL_HARNESSES) {
      if (harness.transport === 'acp') expect(harness.acp, harness.command).toBeDefined();
      if (harness.acp) expect(Array.isArray(harness.acp.argv), harness.command).toBe(true);
    }
  });

  it('builds the ACP spawn contract from declarations only', () => {
    expect(harnessAcpLaunch(localHarnessForCommand('droid')!, { model: 'gpt-5', effort: 'high', permissionMode: 'auto' }))
      .toEqual({ binary: 'droid', argv: ['exec', '--output-format', 'acp', '--model', 'gpt-5', '--reasoning-effort', 'high', '--auto', 'low'], modeArgv: ['exec', '--output-format', 'acp'], optionArgv: ['--model', 'gpt-5', '--reasoning-effort', 'high', '--auto', 'low'], optionPlacement: 'after', experimental: false });
    expect(harnessAcpLaunch(localHarnessForCommand('copilot')!, { model: 'gpt-5', effort: 'high', permissionMode: 'bypass' }))
      .toMatchObject({ binary: 'copilot', argv: ['--model', 'gpt-5', '--effort', 'high', '--allow-all', '--acp', '--stdio'] });
    expect(harnessAcpLaunch(localHarnessForCommand('cline')!, { effort: 'low', permissionMode: 'auto' }))
      .toMatchObject({ binary: 'cline', argv: ['--thinking', 'low', '--auto-approve', 'true', '--acp'] });
    expect(harnessAcpLaunch(localHarnessForCommand('cline')!, { permissionMode: 'ask' })).toMatchObject({ binary: 'cline', argv: ['--acp'], optionArgv: [] });
    expect(harnessAcpLaunch(localHarnessForCommand('hermes')!, { permissionMode: 'bypass', effort: 'max' }))
      .toMatchObject({ binary: 'hermes', argv: ['--reasoning', 'max', '--yolo', 'acp'] });
    expect(harnessAcpLaunch(localHarnessForCommand('vibe')!)).toMatchObject({ binary: 'vibe-acp', argv: [] });
    expect(harnessAcpLaunch(localHarnessForCommand('gemini')!)).toMatchObject({ argv: ['--acp'], experimental: false });
    expect(harnessAcpLaunch(localHarnessForCommand('claude')!)).toBeUndefined();
  });

  it('prefers the proven transport and falls back from ACP for image turns', () => {
    expect(harnessTurnTransport(localHarnessForCommand('codex')!)).toBe('codex-app-server');
    expect(harnessTurnTransport(localHarnessForCommand('copilot')!)).toBe('acp');
    expect(harnessTurnTransport(localHarnessForCommand('copilot')!, { hasImages: true })).toBe('text-cli');
    expect(harnessTurnTransport(localHarnessForCommand('droid')!, { hasImages: true })).toBe('structured-cli');
    expect(harnessTurnTransport(localHarnessForCommand('gemini')!)).toBe('structured-cli');
    expect(harnessTurnTransport(localHarnessForCommand('gemini')!, { allowExperimentalAcp: true })).toBe('acp');
    expect(harnessTurnTransport(localHarnessForCommand('aider')!)).toBe('text-cli');
    expect(harnessTurnTransport(customAcpHarness({ command: 'zed-agent', binary: 'zed-agent', argv: [] }))).toBe('acp');
  });

  it('orders pickers by declared tier and keeps basic adapters behind More', () => {
    for (const command of ['aider', 'amp', 'kimi', 'auggie', 'vibe', 'openhands', 'cn']) expect(localHarnessForCommand(command)!.tier, command).toBe('more');
    expect(localHarnessForCommand('claude')!.tier).toBe('primary');
    expect(harnessTierRank(localHarnessForCommand('codex')!)).toBeLessThan(harnessTierRank(localHarnessForCommand('aider')!));
  });

  it('declares parser borrowing instead of name-mapping it', () => {
    expect(localHarnessForCommand('qwen')!.parser).toBe(localHarnessForCommand('claude')!.parser);
    expect(localHarnessForCommand('amp')!.parser).toBe('claude-stream-json');
    expect(localHarnessForCommand('kilo')!.parser).toBe(localHarnessForCommand('opencode')!.parser);
  });

  it('derives Kilo from the shared OpenCode base, differing only where declared', () => {
    const { command: _c, provider: _p, displayName: _d, tier: _t, binary: _b, npmPackage: _n, permissionModes: _pm, permissionArgv: _pa, customCommandDirs: _cd, normalizedPermissionOptionIds: _np, authFiles: _af, ...opencode } = localHarnessForCommand('opencode')!;
    const { command: _kc, provider: _kp, displayName: _kd, tier: _kt, binary: _kb, npmPackage: _kn, permissionModes: _kpm, permissionArgv: _kpa, authFiles: _kaf, ...kilo } = localHarnessForCommand('kilo')!;
    expect(kilo).toEqual(opencode);
    expect(localHarnessForCommand('kilo')!.permissionModes).toEqual(['ask', 'auto']);
    expect(localHarnessForCommand('kilo')!.authFiles).toEqual([{ path: '${XDG_DATA_HOME:-~/.local/share}/kilo/auth.json', contains: '"type"' }]);
  });

  it('upgrades Amp to stream-json while keeping the text contract as its fallback', () => {
    const amp = localHarnessForCommand('amp')!;
    expect(amp).toMatchObject({ transport: 'structured-cli', integration: 'structured', experimental: true });
    expect(nativeHarnessTurnArgv(amp, { prompt: 'hi' })).toEqual(['--stream-json', '-x', 'hi']);
    expect(nativeHarnessTurnArgv(amp, { prompt: 'hi', nativeSessionId: 'T-1' })).toEqual(['threads', 'continue', 'T-1', '--stream-json', '-x', 'hi']);
    expect(nativeHarnessTurnArgv({ ...amp, turn: amp.fallbackTurn }, { prompt: 'hi', nativeSessionId: 'T-1' })).toEqual(['threads', 'continue', 'T-1', '-x', 'hi']);
  });

  it('pipes the prompt where the vendor reads stdin and never leaves it in argv', () => {
    const claude = nativeHarnessTurnArgv(localHarnessForCommand('claude')!, { prompt: '--dangerously-skip-permissions' });
    expect(claude).not.toContain('--dangerously-skip-permissions');
    expect(claude).not.toContain('-');
    expect(nativeHarnessTurnArgv(localHarnessForCommand('codex')!, { prompt: '--oss' }).at(-1)).toBe('-');
    expect(promptExceedsArgvLimit(localHarnessForCommand('claude')!, 'x'.repeat(maxPromptArgvBytes + 1))).toBe(false);
  });

  it('guards an argv prompt that begins with a dash', () => {
    expect(maxPromptArgvBytes).toBe(96 * 1024);
    // Positional prompt on a parser that honors `--`.
    expect(nativeHarnessTurnArgv(localHarnessForCommand('opencode')!, { prompt: '--help me' })).toEqual(['run', '--format', 'json', '--', '--help me']);
    expect(nativeHarnessTurnArgv(localHarnessForCommand('cursor')!, { prompt: '-f' }).slice(-2)).toEqual(['--', '-f']);
    // A prompt that is a FLAG VALUE can never take `--`; it gets the space guard.
    expect(nativeHarnessTurnArgv(localHarnessForCommand('gemini')!, { prompt: '--yolo' }).slice(-2)).toEqual(['--prompt', ' --yolo']);
    expect(nativeHarnessTurnArgv(localHarnessForCommand('aider')!, { prompt: '-x' }).slice(-2)).toEqual(['--message', ' -x']);
    // Positional, but `--` support undeclared: space guard.
    expect(nativeHarnessTurnArgv(localHarnessForCommand('droid')!, { prompt: '-rf' }).at(-1)).toBe(' -rf');
    expect(guardedPromptArgv({ promptGuard: 'double-dash', promptArgvPrefix: ['-p'] }, '-x')).toEqual([' -x']);
    expect(guardedPromptArgv({}, 'plain - dash inside')).toEqual(['plain - dash inside']);
    for (const harness of AI_LOCAL_HARNESSES) {
      if (harness.turn?.promptInput === 'stdin') continue;
      const argv = nativeHarnessTurnArgv(harness, { prompt: '--version' });
      expect(argv.at(-1) === ' --version' || (argv.at(-2) === '--' && argv.at(-1) === '--version'), harness.command).toBe(true);
      expect(argv.filter((arg) => arg === '--version'), harness.command).toHaveLength(argv.at(-2) === '--' ? 1 : 0);
    }
    expect(promptExceedsArgvLimit(localHarnessForCommand('gemini')!, 'é'.repeat(maxPromptArgvBytes / 2 + 1))).toBe(true);
    expect(promptExceedsArgvLimit(localHarnessForCommand('gemini')!, 'short')).toBe(false);
  });

  it('lists what a HOME-redirected account must carry so tools still act as the user', () => {
    const redirected = AI_LOCAL_HARNESSES.filter((item) => item.profileEnv === 'HOME');
    expect(redirected.map((item) => item.command)).toEqual(['antigravity', 'command']);
    for (const harness of redirected) {
      expect(harness.profileEnvPassthrough, harness.command).toEqual(expect.arrayContaining(['GIT_CONFIG_GLOBAL', 'SSH_AUTH_SOCK', 'NPM_CONFIG_USERCONFIG']));
      for (const name of harness.profileEnvPassthrough!) expect(name in HOME_REDIRECT_ENV_DEFAULTS, name).toBe(true);
    }
    for (const harness of AI_LOCAL_HARNESSES.filter((item) => item.profileEnv !== 'HOME')) expect(harness.profileEnvPassthrough, harness.command).toBeUndefined();
    expect(HOME_REDIRECT_ENV_DEFAULTS.GIT_CONFIG_GLOBAL).toBe('~/.gitconfig');
    expect(HOME_REDIRECT_ENV_DEFAULTS.SSH_AUTH_SOCK).toBeNull();
  });

  it('declares vendor custom-command directories and native slash passthrough', () => {
    expect(localHarnessForCommand('claude')).toMatchObject({ memoryFile: 'CLAUDE.md', nativeSlashPassthrough: true, customCommandDirs: ['.claude/commands', '~/.claude/commands'] });
    expect(localHarnessForCommand('codex')).toMatchObject({ memoryFile: 'AGENTS.md', nativeSlashPassthrough: false, customCommandDirs: ['~/.codex/prompts'] });
    expect(localHarnessForCommand('gemini')).toMatchObject({ memoryFile: 'GEMINI.md', customCommandDirs: ['.gemini/commands', '~/.gemini/commands'] });
    expect(AI_LOCAL_HARNESSES.filter((item) => item.nativeSlashPassthrough).map((item) => item.command)).toEqual(['claude']);
  });
});

describe('custom ACP harnesses', () => {
  afterEach(() => { registerCustomHarnesses([]); });

  it('builds a valid definition with no vendor code', () => {
    const harness = customAcpHarness({ command: '/Claude-ACP', binary: 'claude-code-acp', argv: [], displayName: 'Claude (ACP)' });
    expect(harness).toMatchObject({
      command: 'claude-acp', provider: 'acp:claude-acp', displayName: 'Claude (ACP)', surface: 'terminal',
      transport: 'acp', integration: 'structured', tier: 'more', parser: 'text', binary: 'claude-code-acp', acp: { argv: [] },
    });
    expect(harness.turn).toBeUndefined();
    expect(harnessCanRunTurns(harness)).toBe(true);
    expect(harnessIntegrationLevel(harness)).toBe('structured');
    expect(harnessAcpLaunch(customAcpHarness({ command: 'codex-acp', binary: 'npx', argv: ['-y', '@zed-industries/codex-acp'] })))
      .toMatchObject({ binary: 'npx', argv: ['-y', '@zed-industries/codex-acp'] });
    expect(localHarnessCapabilityManifest(harness).options).toEqual([]);
    expect(() => customAcpHarness({ command: 'bad name; rm', binary: 'x', argv: [] })).toThrow('simple lowercase name');
    expect(() => customAcpHarness({ command: 'ok', binary: ' ', argv: [] })).toThrow('needs a binary');
  });

  it('resolves registered harnesses by command and provider without shadowing the catalog', () => {
    const mine = customAcpHarness({ command: 'my-agent', binary: 'my-agent', argv: ['--stdio'] });
    const shadow = customAcpHarness({ command: 'claude', binary: 'evil', argv: [] });
    const providerShadow = customAcpHarness({ command: 'sneaky', binary: 'evil', argv: [], provider: 'anthropic' });
    expect(localHarnessForCommand('my-agent')).toBeUndefined();
    expect(registerCustomHarnesses([mine, shadow, providerShadow, mine])).toEqual([mine]);
    expect(localHarnessForCommand('/my-agent')).toEqual(mine);
    expect(localHarnessForProvider('acp:my-agent')).toEqual(mine);
    expect(localHarnessForCommand('claude')!.binary).toBe('claude');
    expect(localHarnessForProvider('anthropic')!.command).toBe('claude');
    expect(allLocalHarnesses()).toHaveLength(AI_LOCAL_HARNESSES.length + 1);
    registerCustomHarnesses([]);
    expect(localHarnessForCommand('my-agent')).toBeUndefined();
    expect(allLocalHarnesses()).toBe(AI_LOCAL_HARNESSES);
  });
});
