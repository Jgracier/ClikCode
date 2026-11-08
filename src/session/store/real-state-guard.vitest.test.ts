import { userInfo } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { stateDirectory } from './paths.js';

const previous = { home: process.env.CLIKCODE_HOME, HOME: process.env.HOME };
afterEach(() => {
  process.env.CLIKCODE_HOME = previous.home;
  process.env.HOME = previous.HOME;
});

describe('a test never reaches the real ClikCode state', () => {
  it('refuses the user\'s own ~/.clikcode when CLIKCODE_HOME names it', () => {
    process.env.CLIKCODE_HOME = join(userInfo().homedir, '.clikcode');
    expect(() => stateDirectory()).toThrow(/real ClikCode state/);
  });

  it('refuses it when CLIKCODE_HOME and HOME are lost and the home falls back to the account database', () => {
    delete process.env.CLIKCODE_HOME;
    process.env.HOME = userInfo().homedir;
    expect(() => stateDirectory()).toThrow(/real ClikCode state/);
  });

  it('allows a throwaway directory', () => {
    expect(stateDirectory()).toBe(previous.home);
  });
});
