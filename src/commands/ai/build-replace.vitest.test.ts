import { describe, expect, it } from 'vitest';
import { relaunchArgv } from './build-replace';

describe('relaunch argv', () => {
  it('reopens the same chat', () => {
    expect(relaunchArgv('/usr/bin/clikcode', 'chat-1')).toEqual(['/usr/bin/clikcode', 'sessions', 'resume', 'chat-1']);
  });

  it('starts fresh when there is no chat to reopen', () => {
    expect(relaunchArgv('/usr/bin/clikcode')).toEqual(['/usr/bin/clikcode']);
    expect(relaunchArgv('/usr/bin/clikcode', '')).toEqual(['/usr/bin/clikcode']);
  });
});
