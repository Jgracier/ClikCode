import { afterEach, describe, expect, it, vi } from 'vitest';

describe('output-mode', () => {
  const argvBackup = [...process.argv];
  const envBackup = { ...process.env };
  const exitCodeBackup = process.exitCode;

  afterEach(() => {
    process.argv = [...argvBackup];
    process.env = { ...envBackup };
    process.exitCode = exitCodeBackup;
    vi.resetModules();
  });

  it('defaults to json mode unless human output is requested', async () => {
    delete process.env.CLIKDEPLOY_OUTPUT_MODE;
    const mod = await import('./output-mode.js');
    expect(mod.isJsonDefaultMode()).toBe(true);

    process.argv.push('--human');
    vi.resetModules();
    const humanMod = await import('./output-mode.js');
    expect(humanMod.isHumanOutputRequested()).toBe(true);
    expect(humanMod.isJsonDefaultMode()).toBe(false);
  });

  it('emitResultJson writes only in json default mode', async () => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const mod = await import('./output-mode.js');
    expect(mod.emitResultJson({ ok: true })).toBe(true);
    expect(write).toHaveBeenCalled();

    write.mockClear();
    process.argv.push('--human');
    vi.resetModules();
    const humanMod = await import('./output-mode.js');
    expect(humanMod.emitResultJson({ ok: true })).toBe(false);
    expect(write).not.toHaveBeenCalled();
  });

  // A failed command must fail the shell too, or `clikdeploy servers ping
  // <dead-box> && clikdeploy deploy` deploys to a box just reported unreachable.
  describe('exit code contract', () => {
    it("sets exitCode 1 for status: 'error' in json mode", async () => {
      vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
      process.exitCode = 0;
      const mod = await import('./output-mode.js');

      expect(mod.emitResultJson({ status: 'error', server: 'dead-box' })).toBe(true);
      expect(process.exitCode).toBe(1);
    });

    it("sets exitCode 1 for status: 'error' in human mode too", async () => {
      const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
      write.mockClear(); // spyOn returns the existing spy if one is already installed
      process.argv.push('--human');
      process.exitCode = 0;
      const mod = await import('./output-mode.js');

      // Human mode renders nothing here, but the shell contract still holds.
      expect(mod.emitResultJson({ status: 'error', server: 'dead-box' })).toBe(false);
      expect(write).not.toHaveBeenCalled();
      expect(process.exitCode).toBe(1);
    });

    it("leaves exitCode untouched for status: 'ok' in both modes", async () => {
      vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
      process.exitCode = 0;
      const jsonMod = await import('./output-mode.js');
      expect(jsonMod.emitResultJson({ status: 'ok', data: [] })).toBe(true);
      expect(process.exitCode).toBe(0);

      process.argv.push('--human');
      vi.resetModules();
      const humanMod = await import('./output-mode.js');
      expect(humanMod.emitResultJson({ status: 'ok', data: [] })).toBe(false);
      expect(process.exitCode).toBe(0);
    });

    it('leaves exitCode untouched for non-error statuses and payload shapes', async () => {
      vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
      const mod = await import('./output-mode.js');

      for (const payload of [
        { status: 'clarification_required' },
        { status: 'invalid_input' },
        { status: 'warn' },
        { checks: [{ name: 'auth', status: 'error' }] }, // nested only — not the result status
        { ok: true },
        null,
        'error',
        undefined,
      ]) {
        process.exitCode = 0;
        mod.emitResultJson(payload);
        expect(process.exitCode, `payload: ${JSON.stringify(payload)}`).toBe(0);
      }
    });

    it('does not clobber an already-failing exit code', async () => {
      vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
      process.exitCode = 2;
      const mod = await import('./output-mode.js');

      mod.emitResultJson({ status: 'ok' });
      expect(process.exitCode).toBe(2);
    });
  });
});
