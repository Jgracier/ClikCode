/** Review and remove saved logins. Everything is asked through the user's own
 * prompt, so the usernames are shown to them and never returned to a caller:
 * the result is a count. */
import type { TurnObserver } from '../../turn/observer.js';
import { allSavedLogins, removeSavedLogin } from './credential-vault.js';
import { uniqueLabels } from './login-fields.js';
import { askPrivateChoice } from './private-login-prompt.js';

const DONE = 'Done';

export async function manageSavedLogins(observer: TurnObserver, stateDir: string, signal?: AbortSignal): Promise<string> {
  let removed = 0;
  for (;;) {
    const logins = await allSavedLogins(stateDir);
    if (!logins.length) return removed ? `Removed ${removed} saved login${removed === 1 ? '' : 's'}. None remain.` : 'No saved logins.';
    const labels = uniqueLabels(logins.map(login => `${login.site} · ${login.label}`));
    const picked = await askPrivateChoice(observer, 'Saved logins', 'Choose a login to remove', [...labels, DONE], signal);
    const login = picked && picked !== DONE ? logins[labels.indexOf(picked)] : undefined;
    if (!login) break;
    const sure = await askPrivateChoice(observer, 'Saved logins', 'Remove the selected login?', ['Remove', 'Keep'], signal);
    if (sure === 'Remove' && await removeSavedLogin(stateDir, login.id)) removed++;
  }
  return removed ? `Removed ${removed} saved login${removed === 1 ? '' : 's'}.` : 'No saved logins were removed.';
}
