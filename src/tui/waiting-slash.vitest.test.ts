import { describe, expect, it } from 'vitest';
import { commandLineTypedDuringTurn } from './waiting-slash.js';

describe('a line typed while a turn is running', () => {
  it('offers a slash line to the router', () => {
    expect(commandLineTypedDuringTurn('/model')).toBe('/model');
    expect(commandLineTypedDuringTurn('  /permissions plan  ')).toBe('/permissions plan');
  });

  it('leaves conversation alone', () => {
    expect(commandLineTypedDuringTurn('also check the disk')).toBeUndefined();
    expect(commandLineTypedDuringTurn('')).toBeUndefined();
  });

  it('leaves the verbatim-to-the-harness escape alone', () => {
    // `//status` is how a leading slash is typed AT the model; treating it as
    // a command would remove the only way to do that.
    expect(commandLineTypedDuringTurn('//status')).toBeUndefined();
  });

  it('is not fooled into a command by a bare slash', () => {
    expect(commandLineTypedDuringTurn('/')).toBeUndefined();
  });

  it('offers a path-shaped line too, because the router decides that', () => {
    // routeSlashInput asks the filesystem; this cannot, and guessing here
    // would mean two places deciding what a slash line means.
    expect(commandLineTypedDuringTurn('/etc/hosts explain this')).toBe('/etc/hosts explain this');
  });
});
