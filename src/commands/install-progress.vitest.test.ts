import { describe, expect, it } from 'vitest';
import { installFailureTail, startSpinner } from './install-progress.js';
import { HARNESS_INSTALL_HINTS, installInstructions } from './harness-install-hints.js';

describe('installFailureTail', () => {
  it('keeps the error and drops npm\'s funding and audit noise', () => {
    const log = [
      'npm notice New major version available',
      'npm warn deprecated left-pad@1.0.0: use String.padStart',
      '12 packages are looking for funding',
      'run `npm fund` for details',
      'npm error code E404',
      "npm error 404 Not Found - GET https://registry.npmjs.org/@vendor%2fcli",
    ].join('\n');
    const tail = installFailureTail(log);
    expect(tail).toContain('E404');
    expect(tail).not.toContain('looking for funding');
    expect(tail).not.toContain('deprecated');
  });

  it('is bounded so a failure is not another dump', () => {
    const log = Array.from({ length: 200 }, (_, index) => `npm error line ${index}`).join('\n');
    expect(installFailureTail(log).split('\n')).toHaveLength(12);
  });
});

describe('startSpinner', () => {
  it('prints one plain line and no frames when stdout is not a terminal', () => {
    const written: string[] = [];
    const spinner = startSpinner('Installing X…', (text) => written.push(text), false);
    spinner.stop('Installed X.');
    expect(written).toEqual(['Installing X…\n', 'Installed X.\n']);
  });

  it('clears its line on a terminal so nothing is left behind', () => {
    const written: string[] = [];
    const spinner = startSpinner('Installing X…', (text) => written.push(text), true);
    spinner.stop();
    expect(written[0]).toContain('Installing X…');
    expect(written[written.length - 1]).toBe('\r\u001b[2K');
  });
});

describe('installInstructions', () => {
  it('gives a verified command with where it came from', () => {
    const text = installInstructions('Cursor Agent', 'cursor', 'cursor-agent');
    expect(text).toContain('curl https://cursor.com/install -fsS | bash');
    expect(text).toContain('cursor.com/docs');
    expect(text).toContain('retry /cursor');
  });

  it('says ClikCode will not run the installer', () => {
    expect(installInstructions('Cursor Agent', 'cursor', 'cursor-agent'))
      .toContain('ClikCode will not run an installer for you');
  });

  it('points at the docs where no command was verified', () => {
    // Kiro publishes downloads rather than a scriptable installer, so there
    // is no command to quote and none is invented.
    const text = installInstructions('Kiro CLI', 'kiro', 'kiro-cli');
    expect(text).toContain('https://kiro.dev');
    expect(text).not.toContain('curl');
  });

  it('quotes the vendor command where one was verified', () => {
    const text = installInstructions('Goose', 'goose', 'goose');
    expect(text).toContain('download_cli.sh');
    expect(text).toContain('Then retry /goose.');
  });

  it('still says something useful for a harness with no hint at all', () => {
    const text = installInstructions('Mystery CLI', 'mystery', 'mystery');
    expect(text).toContain('binary on PATH');
    expect(text).toContain('retry /mystery');
  });

  it('never ships a hint that claims a command without naming its source', () => {
    for (const [command, hint] of Object.entries(HARNESS_INSTALL_HINTS)) {
      if (hint.command) expect(hint.source, `${command} has a command but no source`).toBeTruthy();
    }
  });
});
