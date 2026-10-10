import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HarnessSession } from '../session/model.js';
import { readState } from '../session/state/read.js';
import { writeState } from '../session/state/write.js';
import { buildBaseProgram } from './program.js';
import { registerClikCodeCommands } from './register.js';

afterEach(() => { vi.restoreAllMocks(); });

async function run(...argv: string[]): Promise<string> {
  let out = '';
  vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string) => { out += chunk; return true; }) as never);
  const program = buildBaseProgram().exitOverride();
  registerClikCodeCommands(program, {} as never);
  await program.parseAsync(['node', 'clikcode', ...argv]);
  return out;
}

describe('clikcode search', () => {
  it('runs the /search engine from a shell: the list for a person, each hit with --json', async () => {
    const state = await readState();
    const now = new Date().toISOString();
    state.sessions.push({
      id: '5e7a1c00-0000-4000-8000-000000000001', route: 'local', accountId: null, provider: 'anthropic', model: 'sonnet', permissionMode: 'ask',
      createdAt: now, updatedAt: now, status: 'active', nativeHarness: 'claude', name: 'Quota footer',
      messages: [{ role: 'user', content: 'the quota reprint in the footer' }, { role: 'assistant', content: 'The quota line is drawn once now.' }],
    } as HarnessSession);
    await writeState(state);
    const json = JSON.parse((await run('--json', 'search', 'quota', 'reprint')).trim().split('\n').at(-1)!);
    expect(json).toMatchObject({ panel: 'search', query: 'quota reprint', results: [{ sessionId: '5e7a1c00-0000-4000-8000-000000000001', title: 'Quota footer' }] });
    expect(json.results[0].first).toMatchObject({ messageIndex: 0 });
    const human = await run('--human', 'search', 'quota', 'reprint');
    expect(human).toContain('"quota reprint" — 1 conversation');
    expect(human).toContain('Quota footer');
  });
});
