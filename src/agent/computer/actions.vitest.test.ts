import { describe, expect, it } from 'vitest';
import { ACTIONS, actionsOf, ALL_ACTION_NAMES, elsewhere, listing, overview, paramsOf, specOf, usage } from './actions.js';
import { toolForCall } from './tool-names.js';

describe('the action table', () => {
  it('names each action once, with an example that calls it, in plain words', () => {
    const names = ACTIONS.map(spec => spec.name);
    expect(new Set(names).size).toBe(names.length);
    for (const spec of ACTIONS) {
      expect(spec.example['action'], spec.name).toBe(spec.name);
      expect(spec.does.length, spec.name).toBeGreaterThan(10);
      expect(spec.does, spec.name).toMatch(/[.)]$/);
    }
    expect(ALL_ACTION_NAMES).toContain('help');
  });

  it('gives every action to exactly one of the two tools', () => {
    expect(actionsOf('browser').length + actionsOf('account').length).toBe(ACTIONS.length);
    expect(actionsOf('browser').map(spec => spec.name)).toEqual(expect.arrayContaining(['open', 'click', 'fill', 'observe', 'handoff']));
    expect(actionsOf('account').map(spec => spec.name)).toEqual(expect.arrayContaining(['login', 'capture_secret', 'read_email_code', 'oauth_connect']));
    expect(actionsOf('browser').map(spec => spec.name)).not.toContain('capture_secret');
  });

  it('lists a tool\'s actions in groups, and nobody else\'s', () => {
    expect(listing('browser')).toMatch(/^LOOK: observe/);
    expect(listing('browser')).toContain('PEOPLE: handoff');
    expect(listing('account')).toMatch(/^SIGN IN: login/);
    expect(listing('account')).not.toContain('observe');
    for (const spec of actionsOf('account')) expect(listing('browser'), spec.name).not.toContain(spec.name);
  });

  it('carries each tool exactly the parameters its actions read', () => {
    for (const kind of ['browser', 'account'] as const) {
      const carried = paramsOf(kind);
      for (const spec of actionsOf(kind)) for (const name of spec.params) expect(carried.has(name), `${spec.name}: ${name}`).toBe(true);
    }
    expect(paramsOf('browser').has('send_to')).toBe(false);
    expect(paramsOf('account').has('viewport')).toBe(false);
    expect(paramsOf('account').has('width')).toBe(false);
    expect(paramsOf('browser').has('url')).toBe(true);
  });

  it('says where an action lives when it is asked of the other tool', () => {
    expect(elsewhere('browser', 'capture_secret')).toBe('capture_secret is an action of account_use, not browser_use. Call account_use with the same arguments.');
    expect(elsewhere('account', 'click')).toContain('Call browser_use');
    expect(elsewhere('browser', 'click')).toBeUndefined();
    expect(elsewhere('browser', 'no_such_action')).toBeUndefined();
  });

  it('writes usage from the action and its parameters', () => {
    const text = usage(specOf('click')!, name => `about ${name}`);
    expect(text).toContain('click (browser_use):');
    expect(text).toContain('  button: about button');
    expect(text).toMatch(/Example: \{"action":"click","target":"e12"\}$/);
    expect(usage(specOf('back')!, () => undefined)).not.toContain('Parameters:');
    expect(overview('browser', 'x')).toContain('observe:');
  });
});

describe('where a call goes', () => {
  it('keeps the old names working for callers outside ClikCode\'s agent, and sends a sign-in action to account_use', () => {
    expect(toolForCall('computer_web', { action: 'click' })).toBe('browser_use');
    expect(toolForCall('computer_web', { action: 'capture_secret' })).toBe('account_use');
    expect(toolForCall('browser_use', { action: 'login' })).toBe('account_use');
    expect(toolForCall('browser_use', { action: 'open' })).toBe('browser_use');
    expect(toolForCall('account_use', { action: 'queue' })).toBe('account_use');
    expect(toolForCall('computer_desktop', { action: 'windows' })).toBe('computer_use');
    expect(toolForCall('browser_use', {})).toBe('browser_use');
  });
});
