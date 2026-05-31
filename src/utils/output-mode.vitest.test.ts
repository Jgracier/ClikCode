import { afterEach, describe, expect, it, vi } from 'vitest';

describe('output-mode', () => {
  const argvBackup = [...process.argv];
  const envBackup = { ...process.env };

  afterEach(() => {
    process.argv = [...argvBackup];
    process.env = { ...envBackup };
    vi.resetModules();
  });

  it('defaults to json mode unless human output is requested', async () => {
    delete process.env.CLIKDEPLOY_OUTPUT_MODE;
    const mod = await import('./output-mode');
    expect(mod.isJsonDefaultMode()).toBe(true);

    process.argv.push('--human');
    vi.resetModules();
    const humanMod = await import('./output-mode');
    expect(humanMod.isHumanOutputRequested()).toBe(true);
    expect(humanMod.isJsonDefaultMode()).toBe(false);
  });

  it('emitResultJson writes only in json default mode', async () => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const mod = await import('./output-mode');
    expect(mod.emitResultJson({ ok: true })).toBe(true);
    expect(write).toHaveBeenCalled();

    write.mockClear();
    process.argv.push('--human');
    vi.resetModules();
    const humanMod = await import('./output-mode');
    expect(humanMod.emitResultJson({ ok: true })).toBe(false);
    expect(write).not.toHaveBeenCalled();
  });
});
