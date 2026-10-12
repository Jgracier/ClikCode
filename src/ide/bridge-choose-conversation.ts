/** Choices about a conversation in the list: rename or delete it. */
import { newConversation } from '../commands/ai/conversations.js';
import { aiSessionCommand } from '../tui/slash/handlers.js';
import type { IdeChoice } from './protocol.js';
import type { ChooseContext } from './bridge-choose.js';

/** Whether this family took the choice. */
export async function chooseConversation(cx: ChooseContext, choice: IdeChoice): Promise<boolean> {
  const { host, queued } = cx;
  switch (choice.kind) {
    case 'conversation': {
      const current = choice.sessionId === host.sessionId;
      if (current && host.link.workerTurnRunning && choice.action === 'delete') {
        throw new Error('A turn is running in this conversation: stop it first.');
      }
      queued(async () => {
        // Putting away the open chat lands on a fresh one with its setup,
        // as the terminal's list does; made before, while there is a setup.
        const replacement = current && choice.action === 'delete' ? await newConversation(choice.sessionId) : undefined;
        if (choice.action === 'rename') {
          const name = choice.name?.trim();
          if (!name) throw new Error('A name is needed.');
          await aiSessionCommand(choice.sessionId, `/rename ${name}`);
        } else await aiSessionCommand(choice.sessionId, '/delete confirm');
        if (replacement) await host.switchTo(replacement);
        else if (host.sessionId) await host.emitSession();
        return { sessionId: host.sessionId };
      });
      return true;
    }
    default: return false;
  }
}
