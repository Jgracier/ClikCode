import { describe, expect, it } from 'vitest';
import { declaredHarnessCommands } from './declared-commands.js';
import { localHarnessForCommand } from '../runtime/lazy-bridge.js';

describe('commands ClikCode knows a harness runs', () => {
  it('lists Kiro\'s and Aider\'s, each named once, for harnesses the catalog has', () => {
    for (const command of ['kiro', 'aider']) {
      const names = declaredHarnessCommands(command).map((item) => item.name);
      expect(names.length).toBeGreaterThan(5);
      expect(new Set(names).size).toBe(names.length);
      expect(localHarnessForCommand(command)).toBeDefined();
    }
  });
  it('has none for a harness that lists its own or takes none', () => {
    for (const command of ['claude', 'codex', 'amp', 'openclaw', undefined]) expect(declaredHarnessCommands(command)).toEqual([]);
  });
});
