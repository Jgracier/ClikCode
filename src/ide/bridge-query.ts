/** The editor's screens as data (queries.ts). Answered straight away, not
 * behind the work queue: a list must open while a turn is running. */
import { readState } from '../session/state/read.js';
import { sessionHarness, slashExtrasFor } from '../tui/slash/context.js';
import { slashPalette, TERMINAL_ONLY_COMMANDS } from '../tui/slash/registry.js';
import { withArgValues } from '../tui/slash/arg-values.js';
import type { PaletteEntry } from '../tui/command-palette.js';
import type { IdeQueryName, IdeSlashCommand } from './protocol.js';
import { accountList, chatSettings, conversationList, gatewayStatus, modelList, providerList } from './queries.js';
import { messageOf } from './bridge-support.js';
import type { BridgeHost } from './bridge-host.js';

export async function answerQuery(host: BridgeHost, requestId: string, query: IdeQueryName, options: { provider?: string; network?: boolean }): Promise<void> {
  const answer = (data: unknown): void => host.channel.send({ type: 'result', requestId, ok: true, data });
  try {
    // Every screen lists from the index; only the open chat's history is read.
    const state = await readState({ transcripts: query === 'conversations' || !host.sessionId ? [] : [host.sessionId] });
    const session = host.sessionId ? state.sessions.find((item) => item.id === host.sessionId) : undefined;
    switch (query) {
      case 'slash-commands': {
        const { session: current } = await host.current();
        const harness = sessionHarness(current);
        // The terminal palette's own values (withArgValues): the vendor
        // lists fill in as they load, so a later query has more.
        const rows: PaletteEntry[] = withArgValues(slashPalette(current, harness, { ...slashExtrasFor(current, harness), omit: TERMINAL_ONLY_COMMANDS }), current, harness, state);
        answer(rows.map((row) => {
          const values = row.argValues?.();
          return {
            command: row.value, description: row.detail ?? '', ...(row.argHint ? { argHint: row.argHint } : {}), group: row.group,
            ...(row.aliases?.length ? { aliases: row.aliases } : {}), ...(values?.length ? { argValues: values } : {}),
          } satisfies IdeSlashCommand;
        }));
        return;
      }
      case 'providers': answer(await providerList(host.config, state, session)); return;
      case 'models':
        if (!options.provider) throw new Error('models needs a provider');
        answer(await modelList(host.config, state, session, options.provider));
        return;
      case 'conversations':
        answer(await conversationList(state, host.sessionId));
        return;
      case 'accounts': answer(await accountList(state, session, Boolean(options.network))); return;
      case 'chat-settings': answer(session ? await chatSettings(state, session) : {}); return;
      case 'gateway': answer(await gatewayStatus(host.config)); return;
      default: throw new Error(`unknown query "${String(query)}"`);
    }
  } catch (error) {
    host.channel.send({ type: 'result', requestId, ok: false, error: messageOf(error) });
  }
}
