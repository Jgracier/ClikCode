/** What an agent is given for the browser: two tools, each one job, made from one table. */
import { describe, expect, it } from 'vitest';
import { ACTIONS, actionsOf, listing, paramsOf } from '../computer/actions.js';
import { accountUseTool, browserUseTool, computerWebTool, helpFor } from './computer-web.js';

type Schema = { properties: Record<string, { description?: string; type?: unknown }>; required?: string[]; additionalProperties?: boolean };
const schemaOf = (tool: { parameters: unknown }): Schema => tool.parameters as Schema;
const run = (tool: { run(args: never, ctx: never): Promise<{ output: string; isError?: boolean }> }, args: Record<string, unknown>) => tool.run(args as never, { stateDir: '/nonexistent-clikcode-test' } as never);
/** What the model is sent about a tool, in tokens at four characters each. */
const tokens = (tool: { description: string; parameters: unknown }): number => Math.round((tool.description.length + JSON.stringify(tool.parameters).length) / 4);

describe('browser_use and account_use', () => {
  it('are two tools, with one job each', () => {
    expect(browserUseTool.name).toBe('browser_use');
    expect(accountUseTool.name).toBe('account_use');
    expect(schemaOf(browserUseTool).required).toEqual(['action']);
    expect(schemaOf(accountUseTool).required).toEqual(['action']);
  });

  it('describe exactly their own actions', () => {
    for (const [tool, kind] of [[browserUseTool, 'browser'], [accountUseTool, 'account']] as const) {
      for (const spec of actionsOf(kind)) expect(tool.description, `${tool.name}: ${spec.name}`).toContain(spec.name);
      // The grouped list of actions is in the description as it is built, and holds nothing of the other tool's.
      expect(tool.description).toContain(listing(kind));
      for (const spec of ACTIONS.filter(other => other.kind !== kind)) expect(listing(kind).split(/[\s·:,]+/), `${tool.name} must not list ${spec.name}`).not.toContain(spec.name);
    }
  });

  it('carry the parameters their actions read, and none of the other tool\'s', () => {
    const browser = schemaOf(browserUseTool).properties, account = schemaOf(accountUseTool).properties;
    for (const name of paramsOf('browser')) expect(browser[name], `browser_use: ${name}`).toBeDefined();
    for (const name of paramsOf('account')) expect(account[name], `account_use: ${name}`).toBeDefined();
    for (const name of ['send_to', 'secret_name', 'ask_fields', 'recipe_op', 'task']) { expect(browser[name], name).toBeUndefined(); expect(account[name], name).toBeDefined(); }
    for (const name of ['width', 'device', 'expression', 'to_target', 'with_screenshot']) { expect(account[name], name).toBeUndefined(); expect(browser[name], name).toBeDefined(); }
  });

  it('leave no parameter of the engine unclaimed by an action, so nothing is carried that nothing reads', () => {
    const all = schemaOf(computerWebTool).properties;
    const claimed = new Set([...paramsOf('browser'), ...paramsOf('account')]);
    expect(Object.keys(all).filter(name => !claimed.has(name)), 'parameters no action lists').toEqual(['task_status', 'task_reason'].filter(name => !claimed.has(name)));
  });

  it('keep nested shapes out of every conversation: they are explained by help and checked when the action runs', () => {
    for (const tool of [browserUseTool, accountUseTool]) {
      const props = schemaOf(tool).properties as Record<string, { items?: { properties?: unknown } }>;
      for (const name of ['steps', 'ask_fields', 'send_to', 'task', 'custom']) if (props[name]) expect(props[name]!.items?.properties, `${tool.name}.${name}`).toBeUndefined();
    }
  });

  it('stay small: the model carries both of them in every conversation', () => {
    // About 2,300 and 1,900 tokens. A budget, not a target: new actions go in `help`, not in the description.
    expect(tokens(browserUseTool as never)).toBeLessThan(2_700);
    expect(tokens(accountUseTool as never)).toBeLessThan(2_300);
    expect(browserUseTool.description.length).toBeLessThan(1_800);
    expect(accountUseTool.description.length).toBeLessThan(1_800);
  });
});

describe('help', () => {
  it('lists every action of the tool with an example', () => {
    const text = helpFor('browser', undefined);
    for (const spec of actionsOf('browser')) { expect(text, spec.name).toContain(`${spec.name}:`); expect(text, spec.name).toContain(JSON.stringify(spec.example)); }
    expect(text).not.toContain('capture_secret');
  });

  it('gives one action in full: what it does, each parameter as the schema words it, and an example', () => {
    const text = helpFor('browser', 'wait');
    expect(text).toContain('wait (browser_use):');
    expect(text).toContain('  until:');
    expect(text).toContain('  seconds:');
    expect(text).toMatch(/Example: \{"action":"wait"/);
    // The full wording, not the shortened one a conversation carries.
    expect(helpFor('account', 'capture_secret')).toContain('clikdeploy-connector');
    expect(helpFor('account', 'capture_secret').length).toBeGreaterThan(accountUseTool.description.length);
  });

  it('points to the other tool, says what it does not know, and has longer rules in a guide', () => {
    expect(helpFor('browser', 'capture_secret')).toContain('Call account_use');
    expect(helpFor('browser', 'bogus')).toContain('No action or topic "bogus"');
    expect(helpFor('browser', 'guide')).toContain('Dialogs');
    expect(helpFor('account', 'guide')).toContain('API keys');
  });

  it('is an action of both tools', async () => {
    expect((await run(browserUseTool, { action: 'help' })).output).toContain('browser_use actions:');
    expect((await run(accountUseTool, { action: 'help', topic: 'login' })).output).toContain('login (account_use):');
  });
});

describe('a call to the wrong tool', () => {
  it('is answered with where the action lives, not run', async () => {
    const wrong = await run(browserUseTool, { action: 'capture_secret' });
    expect(wrong.isError).toBe(true);
    expect(wrong.output).toBe('capture_secret is an action of account_use, not browser_use. Call account_use with the same arguments.');
    expect((await run(accountUseTool, { action: 'click', target: 'e1' })).output).toContain('Call browser_use');
  });

  it('names an action neither tool has, and what this tool has', async () => {
    const unknown = await run(browserUseTool, { action: 'teleport' });
    expect(unknown.isError).toBe(true);
    expect(unknown.output).toContain('Unknown action "teleport" for browser_use');
    expect(unknown.output).toContain('LOOK: observe');
  });
});
