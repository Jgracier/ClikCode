/** Choices about providers and accounts: switch provider, add an account, act on one. */
import { quiet } from '../runtime/lifecycle-log.js';
import { localHarnessForCommand } from '../runtime/lazy-bridge.js';
import { resolveSessionModel } from '../session/attach.js';
import { aiSessionCommand } from '../tui/slash/handlers.js';
import { providerConversationKey } from '../tui/pickers/engine.js';
import { addAccountForHarness, manageAccountAction, useAddedAccount } from '../tui/pickers/account.js';
import { selectProviderConversation } from '../tui/pickers/conversation.js';
import type { IdeChoice } from './protocol.js';
import { gatewayCheckoutUrl } from './queries.js';
import type { ChooseContext } from './bridge-choose.js';

/** Whether this family took the choice. */
export async function chooseProvider(cx: ChooseContext, choice: IdeChoice): Promise<boolean> {
  const { host, done, queued } = cx;
  switch (choice.kind) {
    case 'provider': {
      // A running turn keeps the call it has already started. This records
      // the provider, and the next model call moves (the same handoff an
      // account failover uses).
      queued(async () => {
        const id = host.requireSession();
        const moved = await selectProviderConversation(host.config, host.prompter, id, providerConversationKey(choice.provider));
        if (choice.model) {
          const { session } = await host.current(moved);
          await aiSessionCommand(moved, session.route === 'clikcode-local' ? `/model --download ${choice.model}` : `/model ${choice.model}`);
        } else await resolveSessionModel(moved);
        // A sign-in let the queue go: the user may have opened another
        // chat meanwhile, and keeps it.
        if (host.sessionId !== id) return { sessionId: moved };
        if (moved !== id) await host.switchTo(moved);
        await host.prepareRoute().catch(quiet('ide/bridge-choose-provider'));
        await host.emitSession();
        void host.refreshUsage().catch(quiet('ide/bridge-choose-provider'));
        return { sessionId: host.sessionId };
      });
      return true;
    }
    case 'add-account':
      queued(async () => {
        const harness = localHarnessForCommand(choice.provider);
        if (!harness) throw new Error(`unknown provider "${choice.provider}"`);
        const added = await addAccountForHarness(host.prompter, harness);
        if (added && host.sessionId) {
          const { session } = await host.current();
          if (session.provider === harness.provider || session.nativeHarness === harness.command) await useAddedAccount(session.id, harness, added);
          await host.emitSession();
        }
        return { added: added ?? null };
      });
      return true;
    case 'account-action':
      queued(async () => {
        await manageAccountAction(host.prompter, choice.accountId, choice.action);
        await host.emitSession().catch(quiet('ide/bridge-choose-provider'));
      });
      return true;
    case 'gateway-credit': done({ url: await gatewayCheckoutUrl(host.config) }); return true;
    default: return false;
  }
}
