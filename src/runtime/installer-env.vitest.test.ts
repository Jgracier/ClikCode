import { expect, it } from 'vitest';
import { installerEnv } from './installer-env.js';

it('keeps what an installer needs and drops keys, tokens and anything else', () => {
  const env = installerEnv({ PATH: '/bin', HOME: '/h', LC_ALL: 'C', XDG_CONFIG_HOME: '/h/.config', https_proxy: 'http://p', ANTHROPIC_API_KEY: 'sk-x', OPENAI_API_KEY: 'sk-y', CLIKDEPLOY_TOKEN: 't', GITHUB_TOKEN: 'g', AWS_SECRET_ACCESS_KEY: 'a', RANDOM_THING: 'r' }, { CUA_DRIVER_RS_VERSION: '1.2.3' });
  expect(env).toEqual({ PATH: '/bin', HOME: '/h', LC_ALL: 'C', XDG_CONFIG_HOME: '/h/.config', https_proxy: 'http://p', CUA_DRIVER_RS_VERSION: '1.2.3' });
});

it('keeps Windows locations whatever their case', () => {
  expect(installerEnv({ Path: 'C:\\w', SystemRoot: 'C:\\Windows', LOCALAPPDATA: 'C:\\l', ANTHROPIC_API_KEY: 'sk' })).toEqual({ Path: 'C:\\w', SystemRoot: 'C:\\Windows', LOCALAPPDATA: 'C:\\l' });
});
