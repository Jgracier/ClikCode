/** `clikcode notify`: a background program tells the person something (agent/computer/notices.ts). No chat, no model turn. */
import { emitResult } from '../cli/structured-output.js';
import { isJsonDefaultMode } from '../cli/output-mode.js';
import { stateDirectory } from '../session/store/paths.js';

export interface NotifyFlags { key?: string; title?: string; url?: string; clear?: boolean }

export async function notifyCommand(words: string[], flags: NotifyFlags): Promise<void> {
  const { checkNoticeKey, clearNotice, postNotice } = await import('../agent/computer/notices.js');
  const dir = stateDirectory();
  const key = checkNoticeKey(flags.key);
  if (flags.clear) {
    if (words.length || flags.title || flags.url) throw new Error('--clear takes only --key: clikcode notify --clear --key <key>');
    const cleared = await clearNotice(dir, key);
    if (isJsonDefaultMode()) return emitResult({ cleared, key });
    process.stdout.write(cleared ? `Cleared the notice ${key}.\n` : `No notice ${key} was open.\n`);
    return;
  }
  const result = await postNotice(dir, { key, title: flags.title ?? '', message: words.join(' '), ...(flags.url ? { url: flags.url } : {}) });
  if (isJsonDefaultMode()) return emitResult({ delivered: result.delivered, key });
  process.stdout.write(`${result.delivered === 'desktop' ? 'Shown on the desktop and put on the desk' : result.delivered === 'desk' ? 'Put on the desk (no desktop notification could be shown)' : 'Already open: updated it, no new popup'}: ${key}. Clear it with clikcode notify --clear --key ${key}\n`);
}
