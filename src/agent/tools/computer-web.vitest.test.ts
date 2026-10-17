import { describe, expect, it } from 'vitest';
import { compactSnapshot, computerWebTool } from './computer-web.js';

describe('compactSnapshot', () => {
  const page = ['- banner:', '  - navigation "Main":', '    - link "Models"', '- main:', '  - heading "API Keys" [level=1]', '  - button "Create key"', '- contentinfo:', '  - link "Terms"'].join('\n');

  it('folds the header and footer away and keeps the main area whole', () => {
    const out = compactSnapshot(page);
    expect(out).toContain('- heading "API Keys"');
    expect(out).toContain('- button "Create key"');
    expect(out).not.toContain('Models');
    expect(out).not.toContain('Terms');
    expect(out).toContain('observe with full: true');
  });

  it('leaves a page with no main area, or no header, exactly as it is', () => {
    const noMain = '- banner:\n  - link "Home"\n- button "Go"';
    expect(compactSnapshot(noMain)).toBe(noMain);
    const plain = '- main:\n  - button "Go"';
    expect(compactSnapshot(plain)).toBe(plain);
  });
});

describe('computer_web labels and plan text', () => {
  const label = (args: Record<string, unknown>): string => computerWebTool.label(args as never);
  it('reads like what is happening, not like the call', () => {
    expect(label({ action: 'open', url: 'https://www.huggingface.co/settings/tokens' })).toBe('Open huggingface.co');
    expect(label({ action: 'click', role: 'button', name: 'Create token' })).toBe('Click Create token');
    expect(label({ action: 'capture_secret', secret_name: 'salad/api-key' })).toBe('Capture key as salad/api-key');
    expect(label({ action: 'login' })).toBe('Sign in');
  });
});

describe('capture_secret failures say what really happened', () => {
  it('says "Not saved" with the real reason, never a generic "check the browser"', async () => {
    const { setComputerEnabled } = await import('../computer/settings.js');
    const { mkdtemp, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const stateDir = await mkdtemp(join(tmpdir(), 'clikcode-web-plan-'));
    try {
      await setComputerEnabled(stateDir, true);
      const result = await computerWebTool.run({ action: 'capture_secret', send_to: [{ type: 'clikdeploy', tool: 'x', args: {} }] } as never, { stateDir } as never);
      expect(result.isError).toBe(true);
      expect(result.output).toMatch(/^Not saved: /);
      expect(result.output).not.toContain('Check the browser and try again');
    } finally { await rm(stateDir, { recursive: true, force: true }); }
  });
});
