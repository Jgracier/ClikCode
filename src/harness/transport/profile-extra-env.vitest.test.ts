import { describe, expect, it } from 'vitest';
import { profileExtraEnvironment } from './profile-environment.js';
import { localHarnessForCommand } from '../../runtime/lazy-bridge.js';
import type { AiLocalHarnessDefinition } from '../definition.js';

describe('what a new account profile adds to its environment', () => {
  it('puts a Java vendor\'s home in the profile: Junie ignores $HOME and wrote into the user\'s own ~/.junie', () => {
    const junie = localHarnessForCommand('junie')!;
    expect(profileExtraEnvironment(junie, '/p/junie/1')).toEqual({ JAVA_TOOL_OPTIONS: '-Duser.home=/p/junie/1' });
  });

  it('resolves {profile}/ paths, and leaves values without it alone', () => {
    const harness = { profileExtraEnv: { ADC: '{profile}/adc.json', FLAG: 'on' } } as unknown as AiLocalHarnessDefinition;
    expect(profileExtraEnvironment(harness, '/p/x')).toEqual({ ADC: '/p/x/adc.json', FLAG: 'on' });
    expect(profileExtraEnvironment({} as AiLocalHarnessDefinition, '/p/x')).toBeUndefined();
  });
});
