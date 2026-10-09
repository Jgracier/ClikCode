import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buttonTitle, keyHint, STOP_TURN_COMMAND } from './wording';
import { turnStopReason } from './turn-usage';

describe('one verb per action', () => {
  it('says stop, in the band and on the button', () => {
    expect(keyHint('stop')).toBe('ctrl+c stop');
    expect(keyHint('sendNow')).toBe('enter again send into the chat');
    expect(keyHint('takeBack')).toBe('esc edit');
    // The waiting line's hint while Esc is what stops the turn.
    expect(keyHint('escStop')).toBe('esc stop');
    expect(buttonTitle('sendNow')).toBe('Send into the chat (Enter again)');
  });

  it('names a stopped turn the same whatever the vendor called it', () => {
    expect(['cancelled', 'interrupted', 'stopped'].map(turnStopReason)).toEqual(['stopped', 'stopped', 'stopped']);
  });

  it('is the VS Code command palette title too', () => {
    const manifest = JSON.parse(readFileSync(new URL('../../../packages/vscode/package.json', import.meta.url), 'utf8')) as { contributes: { commands: Array<{ command: string; title: string }> } };
    expect(manifest.contributes.commands.find((entry) => entry.command === 'clikcode.cancel')?.title).toBe(STOP_TURN_COMMAND);
  });
});
