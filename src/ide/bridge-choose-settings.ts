/** Choices that set something on the open conversation: model, agent, effort,
 * permissions, account, fast, plan, send. */
import { planModeOnChat, setAgentPlanMode } from '../agent/plan-mode-setting.js';
import { selectGatewayAgent } from '../commands/ai/sessions.js';
import { aiSettingsSetGlobal } from '../commands/ai/settings.js';
import { parseSendMode } from '../turn/send-mode.js';
import type { IdeChoice } from './protocol.js';
import { sessionHarnessDefinition } from './queries.js';
import type { ChooseContext } from './bridge-choose.js';

/** Whether this family took the choice. */
export async function chooseSetting(cx: ChooseContext, choice: IdeChoice): Promise<boolean> {
  const { host, done, setting } = cx;
  switch (choice.kind) {
    case 'model': {
      const { session } = await host.current();
      const line = session.route === 'clikcode-local' ? `/model --download ${choice.model}` : `/model ${choice.model}`;
      await setting(line);
      done();
      return true;
    }
    case 'agent': {
      // The terminal picker's own step: the chat stays on the Gateway and its next turn runs as
      // the agent; a different agent starts a fresh agent thread.
      await selectGatewayAgent(host.requireSession(), choice.agent ?? undefined);
      await host.emitSession();
      done();
      return true;
    }
    case 'effort': await setting(`/effort ${choice.value}`); done(); return true;
    case 'permissions': await setting(`/permissions ${choice.value}`); done(); return true;
    case 'account': await setting(`/accounts use ${choice.accountId}`); done(); return true;
    // Global, not this chat's. With a chat open it goes through the chat as every setting does; with none -- an editor setting its own
    // for a chat on another machine, asked of this computer's ClikCode -- it is the global setting alone.
    case 'send':
      if (host.sessionId) await setting(`/send ${choice.mode}`);
      else await aiSettingsSetGlobal('send', parseSendMode(choice.mode), false);
      done();
      return true;
    case 'fast': await setting(`/fast ${choice.on ? 'on' : 'off'}`); done(); return true;
    case 'plan': {
      const { session } = await host.current();
      const harness = sessionHarnessDefinition(session);
      if (planModeOnChat(session, harness)) { await setAgentPlanMode(session.id, choice.on); await host.emitSession(); done(); return true; }
      if (!harness?.planMode) throw new Error('This provider has no plan mode.');
      const on = harness.planMode.value === true ? 'on' : String(harness.planMode.value);
      await setting(`/settings option ${harness.planMode.option} ${choice.on ? on : 'default'}`);
      done();
      return true;
    }
    default: return false;
  }
}
