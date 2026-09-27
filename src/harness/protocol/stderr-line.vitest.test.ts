import { describe, expect, it } from 'vitest';
import { firstUsefulLine } from './stderr-line';

describe('the one line of a failed process worth showing', () => {
  it('passes over warnings to the complaint (Pi)', () => {
    const stderr = "Warning: No project session found with id 'db6d5103'; creating a new session with that id.\nNo API key found for the selected model.\n\nUse /login to log into a provider via OAuth or API key. See:\n  /home/u/docs/providers.md\n";
    expect(firstUsefulLine(stderr)).toBe('No API key found for the selected model.');
  });

  it('passes over terminal notices and colour codes (OpenHands)', () => {
    const stdout = [
      'OpenHands CLI terminal UI may not work correctly in this environment: Rich detected a non-interactive or unsupported terminal; interactive UI may not render correctly',
      "To override Rich's detection, you can set TTY_INTERACTIVE=1 (and optionally TTY_COMPATIBLE=1).",
      '\u001b[38;5;203mHeadless mode requires existing settings.\u001b[0m',
      'Goodbye! 👋',
    ].join('\n');
    expect(firstUsefulLine(stdout)).toBe('Headless mode requires existing settings.');
  });

  it('still prefers the line that names the error', () => {
    expect(firstUsefulLine('Starting up\nloading config\nError: Insufficient credits for Command Code.\n')).toBe('Error: Insufficient credits for Command Code.');
  });

  it('falls back to the first line when nothing complains', () => {
    expect(firstUsefulLine('Goodbye\n')).toBe('Goodbye');
  });
});
