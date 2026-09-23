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
    expect(humanMod.isJsonDefaultMode()).toBe(false);
  });
  // A failed command must fail the shell too, or `clikcode ... && clikcode ...`
  // runs the second half after the first reported an error.
  //
  // Asserted against handleCommandError, which is what actually ships it:
  // toCliErrorJson is the only producer of status:'error' in the codebase and
  // it is reached only from there. This previously tested emitResultJson --
  // a second, equivalent implementation with no caller anywhere -- so the
  // contract was guarded only on the copy that never ran.
  describe('exit code contract', () => {
    it('fails the shell for a thrown command error, in json mode', async () => {
      vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
      delete process.env.CLIKDEPLOY_OUTPUT_MODE;
      process.env.CLIKDEPLOY_OUTPUT_MODE = 'json';
      process.exitCode = 0;
      const { handleCommandError } = await import('./program.js');
      handleCommandError(new Error('host unreachable'));
      expect(process.exitCode).toBe(1);
    });

    it('fails the shell in human mode too', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      process.argv.push('--human');
      process.exitCode = 0;
      const { handleCommandError } = await import('./program.js');
      handleCommandError(new Error('host unreachable'));
      expect(process.exitCode).toBe(1);
    });
  });
});
