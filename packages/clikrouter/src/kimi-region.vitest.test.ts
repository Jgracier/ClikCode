import { describe, expect, it } from 'vitest';
import { localHarnessForCommand } from './ai-local-harness.js';

describe('Kimi signs in on the global property', () => {
  it('asks for the global region explicitly', () => {
    // Kimi's device-code flow defaults to mainland China: bare `kimi login`
    // prints https://www.kimi.com/code/authorize_device, which is the wrong
    // account system for a user outside it. Verified against kimi 2.0.2,
    // whose own `login --help` documents:
    //   --region <region>  Login region: "mainland-cn" (kimi.com) or "global" (kimi.ai)
    // With --region global the same command prints https://www.kimi.ai/...
    expect(localHarnessForCommand('kimi')!.loginArgv).toEqual(['login', '--region', 'global']);
  });

  it('never leaves the region to the vendor default', () => {
    const loginArgv = localHarnessForCommand('kimi')!.loginArgv ?? [];
    expect(loginArgv).toContain('--region');
    expect(loginArgv).not.toContain('mainland-cn');
  });
});
