/** The contract is one contract, and it is the same one for every transport.
 *
 * Each transport used to declare its own turn input with its own callbacks,
 * and they had drifted -- nine on codex-app-server, eight on ACP, two on the
 * gateway, none on the structured CLI. Nothing said what a harness owed the
 * UI, so whether a plan or a thought reached the screen depended on which of
 * two dozen harnesses had been picked. This is the test that would have caught
 * that, and it fails the moment a transport declares a callback of its own
 * again instead of implementing the shared one. */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const srcRoot = new URL('../../', import.meta.url).pathname;
const read = (name: string): string => readFileSync(join(srcRoot, name), 'utf8');

const TRANSPORTS = ['harness/transport/codex-app-server.ts', 'harness/transport/acp-client.ts', 'gateway/harness.ts'];

describe('the turn observer', () => {
  it('is declared in exactly one place', () => {
    for (const file of TRANSPORTS) {
      const source = read(file);
      const declared = [...source.matchAll(/^\s*(on[A-Z][A-Za-z]*)\?:/gm)].map((m) => m[1]);
      expect(declared, `${file} declares its own turn callbacks: ${declared.join(', ')}`).toEqual([]);
    }
  });

  it('is what every transport turn input extends', () => {
    for (const file of TRANSPORTS) {
      expect(read(file), `${file} does not extend HarnessTurnObserver`).toContain('extends HarnessTurnObserver');
    }
  });

  it('carries one plan shape, not one per transport', () => {
    for (const file of [...TRANSPORTS, 'tui/prompter.ts', 'commands/ai.ts']) {
      const source = read(file);
      for (const stale of ['CodexPlanEntry', 'AcpPlanEntry', 'AcpAvailableCommand']) {
        expect(source, `${file} still refers to ${stale}`).not.toContain(stale);
      }
    }
  });
});
