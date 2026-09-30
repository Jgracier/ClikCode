import { describe, expect, it } from 'vitest';
import { parseAcpArguments } from '../../src/acp-arguments';

describe('ACP launch arguments', () => {
  it('preserves values with spaces and option names owned by the agent', () => {
    expect(parseAcpArguments('["--name", "Vendor Name", "--config", "two words"]'))
      .toEqual(['--name', 'Vendor Name', '--config', 'two words']);
  });

  it('rejects ambiguous input instead of changing the launch command', () => {
    expect(parseAcpArguments('')).toEqual([]);
    expect(() => parseAcpArguments('--stdio')).toThrow(/JSON array/);
    expect(() => parseAcpArguments('["--stdio", 1]')).toThrow(/array of strings/);
  });
});
