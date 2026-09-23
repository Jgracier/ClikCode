import { describe, expect, it } from 'vitest';
import {
  SLASH_COMMANDS, SLASH_HANDLER_KEYS, SLASH_PALETTE_PINNED, parseSlashInput, resolveSlashCommand, routeSlashInput, slashControls,
  slashHelpText, slashPalette, suggestSlashCommand, unknownSlashMessage,
} from './registry';
import { requiresProviderHandoff } from '../../session/options.js';
import type { AiLocalHarnessDefinition } from '../../harness/definition.js';
import type { HarnessSession } from '../../session/model.js';

const harness = (overrides: Partial<AiLocalHarnessDefinition> = {}): AiLocalHarnessDefinition => ({
  command: 'vendor', provider: 'vendor', displayName: 'Vendor', surface: 'terminal', localAuth: ['vendor-cli'], binary: 'vendor',
  modelArgvPrefix: ['--model'], ...overrides,
});
const session = (overrides: Partial<HarnessSession> = {}): HarnessSession => ({
  id: 's1', route: 'local', accountId: null, provider: 'vendor', model: null, effort: 'medium', accountFailover: 'never',
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', status: 'active', nativeHarness: 'vendor', ...overrides,
});

describe('slash registry', () => {
  it('has exactly one entry per handler key and one handler key per entry', () => {
    const used = SLASH_COMMANDS.map((entry) => entry.handlerKey).sort();
    expect(used).toEqual([...SLASH_HANDLER_KEYS].sort());
    expect(new Set(used).size).toBe(used.length);
  });

  it('never reuses a name or alias', () => {
    const names = SLASH_COMMANDS.flatMap((entry) => [entry.name, ...entry.aliases]);
    expect(new Set(names).size).toBe(names.length);
  });

  it('parses head and args uniformly', () => {
    expect(parseSlashInput('/model')).toEqual({ head: 'model', args: '', words: [] });
    expect(parseSlashInput('/MODEL   gpt-5  high ')).toEqual({ head: 'model', args: 'gpt-5  high', words: ['gpt-5', 'high'] });
    expect(routeSlashInput('/model gpt-5')).toMatchObject({ kind: 'command', head: 'model', args: 'gpt-5' });
    expect(routeSlashInput('/model')).toMatchObject({ kind: 'command', head: 'model', args: '' });
  });

  it('makes /clear and /reset aliases of /new, and keeps /redraw separate', () => {
    expect(resolveSlashCommand('clear')?.name).toBe('new');
    expect(resolveSlashCommand('reset')?.name).toBe('new');
    expect(resolveSlashCommand('redraw')?.handlerKey).toBe('redraw');
  });

  it('says a harness has no model selector before any picker opens', () => {
    const model = resolveSlashCommand('model')!;
    expect(model.availability(session(), harness())).toEqual({ available: true });
    expect(model.availability(session(), harness({ modelArgvPrefix: undefined }))).toEqual({
      available: false, reason: 'Vendor does not publish a model selector.',
    });
  });

  it('allows repository tasks on the gateway route, which now reads local files', () => {
    // The gateway route runs ClikCode's own agent loop on this machine and
    // asks the gateway only for the model step, so its tools touch the same
    // files a local harness's do. These used to refuse with "cannot see local
    // files", which was true of the platform assistant it no longer uses.
    for (const name of ['init', 'review', 'add-dir']) {
      const state = resolveSlashCommand(name)!.availability(session({ route: 'gateway', nativeHarness: undefined }), undefined);
      expect(state.available, `/${name} still refuses on the gateway route`).toBe(true);
    }
  });

  it('keeps deciding on this machine what the agent may do to it', () => {
    // The gateway picks the model and the effort. It does not get to pick how
    // much of the user's filesystem an agent may touch without asking.
    const permissions = resolveSlashCommand('permissions')!.availability(session({ route: 'gateway', nativeHarness: undefined }), undefined);
    expect(permissions.available).toBe(true);
    for (const name of ['model', 'effort']) {
      expect(resolveSlashCommand(name)!.availability(session({ route: 'gateway', nativeHarness: undefined }), undefined).available).toBe(false);
    }
  });

  const VENDOR_EXTRAS = {
    managers: [{ name: 'mcp', label: 'MCP servers' }],
    native: [{ name: 'rewind', description: 'rewind the vendor conversation' }],
    custom: [{ name: 'ship', description: 'ship it', argumentHint: '<ticket>' }],
    harnesses: [{ command: 'vendor', displayName: 'Vendor' }, { command: 'other', displayName: 'Other' }],
  };

  it('generates palette, help and controls from the same entries', () => {
    const palette = slashPalette(session(), harness(), VENDOR_EXTRAS);
    for (const entry of SLASH_COMMANDS) expect(palette.map((row) => row.value)).toContain(`/${entry.name}`);
    expect(palette.find((row) => row.value === '/ship')).toMatchObject({ group: 'Custom', argHint: '<ticket>' });
    // A row carries its registry group and hint through unchanged. /effort
    // rather than /model because the palette pins /model to the top under a
    // group of its own; see the pinning test below.
    expect(palette.find((row) => row.value === '/effort')).toMatchObject({ argHint: '[level]', group: 'Settings' });
    const help = slashHelpText(session(), harness());
    const controls = slashControls().map((control) => control.command);
    for (const entry of SLASH_COMMANDS) {
      expect(help).toContain(`/${entry.name}`);
      expect(controls).toContain(`/${entry.name}`);
    }
  });

  /** Typing `/` on a phone shows about six rows before anything scrolls, so
   * what sits in those rows is the whole of the feature for most uses. */
  it('opens with the commands reached for most, in the order they are reached for', () => {
    const palette = slashPalette(session(), harness(), VENDOR_EXTRAS);
    // Spelled out rather than derived from SLASH_PALETTE_PINNED: comparing the
    // constant to itself passes whatever the constant says.
    expect(palette.slice(0, 6).map((row) => row.value))
      .toEqual(['/provider', '/account', '/resume', '/model', '/new', '/permissions']);
    // One header, not one per pinned command's real group.
    expect(new Set(palette.slice(0, SLASH_PALETTE_PINNED.length).map((row) => row.group))).toEqual(new Set(['Common']));
    // Pinned once, not listed again under the group it came from.
    const values = palette.map((row) => row.value);
    expect(values.filter((value, index) => values.indexOf(value) !== index)).toEqual([]);
  });

  it('never pins a command this session cannot run', () => {
    // /model is unavailable without a harness, and pinning must not put it
    // back: the palette would offer a row that errors when chosen.
    const palette = slashPalette({ ...session(), nativeHarness: undefined } as never, undefined, {});
    const pinned = palette.filter((row) => row.group === 'Common').map((row) => row.value);
    for (const value of pinned) expect(palette.filter((row) => row.value === value)).toHaveLength(1);
  });

  it('keeps the vendor harness out of the palette and in /help', () => {
    const palette = slashPalette(session(), harness(), VENDOR_EXTRAS).map((row) => row.value);
    // A manager surface or an advertised command would otherwise render as if
    // ClikCode owned it.
    for (const vendor of ['/mcp', '/rewind']) expect(palette).not.toContain(vendor);
    expect(palette).toContain('/ship');
    const help = slashHelpText(session(), harness(), VENDOR_EXTRAS);
    for (const vendor of ['/mcp', '/rewind']) expect(help).toContain(vendor);
    expect(help).toContain('/<harness>');
  });

  it('keeps the harness switches out of the palette, and in /help', () => {
    // They are ClikCode's own feature, but two dozen rows each named after a
    // terminal CLI read as the terminal's command list pasted into the
    // palette. Typing one still works; /help is where they are listed.
    const palette = slashPalette(session(), harness(), VENDOR_EXTRAS);
    expect(palette.some((row) => row.group === 'Switch harness')).toBe(false);
    for (const command of ['/vendor', '/other']) expect(palette.map((row) => row.value)).not.toContain(command);
    expect(slashHelpText(session(), harness(), VENDOR_EXTRAS)).toContain('/<harness>');
  });

  it('keeps an unavailable command listed with its reason', () => {
    const row = slashPalette(session(), harness({ modelArgvPrefix: undefined })).find((item) => item.value === '/model');
    expect(row?.detail).toMatch(/unavailable · Vendor does not publish a model selector/);
  });
});

describe('pass-through rules', () => {
  it('forwards //text and /native <text> verbatim', () => {
    expect(routeSlashInput('//compact keep the api notes')).toEqual({ kind: 'native', prompt: '/compact keep the api notes', why: 'explicit' });
    expect(routeSlashInput('/native /rewind 2')).toMatchObject({ kind: 'command', head: 'native', args: '/rewind 2' });
  });

  it('forwards an unknown command when the harness declares nativeSlashPassthrough', () => {
    expect(routeSlashInput('/rewind 2', { harness: harness({ nativeSlashPassthrough: true }) }))
      .toEqual({ kind: 'native', prompt: '/rewind 2', why: 'passthrough' });
  });

  it('forwards a command the ACP agent advertised for this session', () => {
    expect(routeSlashInput('/plan the migration', { harness: harness(), nativeCommands: ['plan'] }))
      .toEqual({ kind: 'native', prompt: '/plan the migration', why: 'advertised' });
  });

  it('routes discovered custom commands, managers and harness switches', () => {
    const context = { harness: harness(), customCommands: ['ship'], managerNames: ['mcp'], harnessCommands: ['other'] };
    expect(routeSlashInput('/ship ABC-1', context)).toEqual({ kind: 'custom', name: 'ship', args: 'ABC-1' });
    expect(routeSlashInput('/mcp', context)).toEqual({ kind: 'manager', name: 'mcp', args: '' });
    expect(routeSlashInput('/other fix the build', context)).toEqual({ kind: 'harness', command: 'other', args: 'fix the build' });
  });

  it('a registry command always beats passthrough, custom and advertised names', () => {
    const route = routeSlashInput('/model x', { harness: harness({ nativeSlashPassthrough: true }), customCommands: ['model'], nativeCommands: ['model'] });
    expect(route.kind).toBe('command');
  });

  it('errors with a did-you-mean suggestion otherwise', () => {
    const route = routeSlashInput('/modle', { harness: harness() });
    expect(route).toEqual({ kind: 'unknown', head: 'modle', suggestion: 'model' });
    expect(unknownSlashMessage(route as { head: string; suggestion?: string })).toMatch(/did you mean \/model\?/);
    expect(routeSlashInput('/zzzzzzzzqq', { harness: harness() })).toEqual({ kind: 'unknown', head: 'zzzzzzzzqq' });
    expect(suggestSlashCommand('permisions', ['permissions', 'model'])).toBe('permissions');
  });
});

describe('path versus slash command', () => {
  const pathExists = (path: string): boolean => ['/etc/hosts', '/etc', '/model'].includes(path);

  it('treats an existing filesystem path as a normal prompt', () => {
    expect(routeSlashInput('/etc/hosts explain this file', { pathExists })).toEqual({ kind: 'prompt', prompt: '/etc/hosts explain this file' });
    expect(routeSlashInput('/etc what is in here', { pathExists, harness: harness({ nativeSlashPassthrough: true }) }))
      .toEqual({ kind: 'prompt', prompt: '/etc what is in here' });
  });

  it('never lets a path shadow a real command', () => {
    expect(routeSlashInput('/model gpt-5', { pathExists })).toMatchObject({ kind: 'command', head: 'model' });
  });

  it('a nested token that is not a path is still an unknown command', () => {
    expect(routeSlashInput('/nope/missing thing', { pathExists })).toMatchObject({ kind: 'unknown' });
  });

  it('plain text is a prompt', () => {
    expect(routeSlashInput('explain /etc/hosts')).toEqual({ kind: 'prompt', prompt: 'explain /etc/hosts' });
  });
});

/** A refusal that names something the user could supply is a question, not an
 * answer. `needs` is how the caller knows which refusals those are. */
describe('a command that is missing only its provider', () => {
  const session = { route: 'local' } as unknown as HarnessSession;

  it('says so, so the caller can ask instead of refusing', () => {
    for (const name of ['model', 'effort', 'permissions', 'options', 'login']) {
      const entry = resolveSlashCommand(name)!;
      expect(entry.availability(session, undefined), name).toMatchObject({ available: false, needs: 'provider' });
    }
  });

  it('does not say so for a real limit', () => {
    // A harness with no model selector is not a missing provider, and asking
    // for one would send the user round a loop that cannot end well.
    const noModels = { command: 'x', displayName: 'X' } as AiLocalHarnessDefinition;
    const model = resolveSlashCommand('model')!.availability(session, noModels);
    expect(model.available).toBe(false);
    expect(model.needs).toBeUndefined();
  });

  it('does not say so for a command that needs nothing', () => {
    expect(resolveSlashCommand('help')!.availability(session, undefined)).toMatchObject({ available: true });
  });
});

/** A conversation with nothing in it has nothing to branch, so choosing an
 * account of another provider is a move, not a handoff. */
describe('switching to an account of another provider', () => {
  it('needs a handoff only once the conversation has content', () => {
    const empty = { id: 's', route: 'local', nativeHarness: 'claude', messages: [] } as unknown as HarnessSession;
    const used = { id: 's', route: 'local', nativeHarness: 'claude', messages: [{ role: 'user', content: 'hi' }] } as unknown as HarnessSession;
    expect(requiresProviderHandoff(empty, 'codex')).toBe(false);
    expect(requiresProviderHandoff(used, 'codex')).toBe(true);
    // The same harness is never a handoff, whatever the history.
    expect(requiresProviderHandoff(used, 'claude')).toBe(false);
  });
});
