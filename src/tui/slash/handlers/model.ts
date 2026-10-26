/** /model, /effort and /fast: choosing what runs the conversation. */
import { quiet } from '../../../runtime/lifecycle-log.js';
import { isGatewayService } from '../../../session/route.js';
import { localModelChosen } from '../../../commands/ai/local-model.js';
import { localModelChoices } from '../../../local-models/index.js';
import { resolveLocalModelId, catalogModel } from '../../../local-models/catalog.js';
import { missingBytes } from '../../../local-models/models.js';
import { formatBytes } from '../../../local-models/download.js';
import type { HarnessSession } from '../../../session/model.js';
import { harnessSupportsEffort, harnessSupportsModelSelection, localHarnessForCommand, modelIdFromDisplay } from '../../../runtime/lazy-bridge.js';
import { harnessModelLabel, nativeModelCatalogForPicker, resolveNativeModel } from '../../../harness/accounts/model-catalog.js';
import { readState } from '../../../session/state/read.js';
import { writeState } from '../../../session/state/write.js';
import { emitHarnessOutput } from '../../../harness/output.js';
import { TERMINAL } from '../../active-terminal.js';
import { normalizeModelWord, setSessionHarnessOption } from '../../../session/options.js';
import type { SlashHandlerKey } from '../registry.js';
import { modelChoicesFor } from '../model-choices.js';
import { effortChoicesFor } from '../../../harness/accounts/effort-choices.js';
import type { AiHarnessAccount, AiLocalHarnessDefinition } from '../../../harness/definition.js';
import { assertRealModel, chooseGatewayModel } from '../../../commands/ai/sessions.js';
import { gatewayModelDetail, gatewayModelLabel, gatewayModels, isAutomaticModelWord } from '../../../gateway/models.js';
import { wakeOwnModel } from '../../../gateway/own-models.js';
import { GATEWAY_DEFAULT_EFFORT, GATEWAY_EFFORTS } from '../../../gateway/options.js';
import { type HeadlessSlashHandler, saveSettings } from './shared.js';

/** `/model` on ClikCode Local. With no name, fitting local and Hub models;
 * with one, download consent is required before it is loaded and answering, and
 * the session moves to it -- a failure (it does not fit, a download failed)
 * leaves the session on the model it had. */
async function localModelCommand(session: HarnessSession, value: string): Promise<void> {
  if (!value) {
    const choices = await localModelChoices();
    return emitHarnessOutput({
      panel: 'models',
      models: choices.map((choice) => ({
        model: choice.id, provider: [choice.label, choice.recommended ? 'recommended' : undefined, choice.detail].filter(Boolean).join(' · '),
        label: choice.label, detail: choice.detail, fits: choice.fits, recommended: choice.recommended,
      })),
      selected: session.model,
    });
  }
  const explicitDownload = value.startsWith('--download ');
  const model = resolveLocalModelId(explicitDownload ? value.slice('--download '.length) : value);
  const entry = catalogModel(model)!;
  const bytes = await missingBytes([entry.weights]);
  if (bytes && !explicitDownload) {
    if (!TERMINAL.active?.select) {
      throw new Error(`${entry.label} needs a ${formatBytes(bytes)} download. Run /model --download ${model} to authorize it.`);
    }
    const confirmed = await TERMINAL.active.select(`Download ${entry.label} (${formatBytes(bytes)})?`, [
      { label: 'Cancel', value: false }, { label: `Download ${formatBytes(bytes)}`, value: true },
    ]);
    if (!confirmed) return;
  }
  await localModelChosen(session.id, model);
  // Re-read: loading a model can take a minute, and the turn worker or
  // another command may have written the state since this command read it.
  const state = await readState({ transcripts: [session.id] });
  const current = state.sessions.find((item) => item.id === session.id);
  if (!current) throw new Error(`AI session "${session.id}" was not found`);
  current.model = model;
  if (current.reported?.model) delete current.reported.model;
  return saveSettings(state, current);
}

/** Moving to a model that does not accept the session's effort level adjusts
 * the level rather than leaving a turn to be rejected. Codex publishes levels
 * per model -- gpt-6-luna stops at `max` where gpt-6-sol has `ultra` -- so a
 * model switch can make a valid setting invalid without the user touching it.
 * The model's own published default is the assumption to make; where there is
 * none, the level is dropped and the vendor applies its own default, rather
 * than ClikCode guessing an order of levels it does not own. Never a question
 * and never a notice: the status line shows the level in use. */
async function keepEffortValidFor(
  session: HarnessSession, harness: AiLocalHarnessDefinition, account: AiHarnessAccount | undefined,
): Promise<void> {
  if (!session.effort || !harnessSupportsEffort(harness)) return;
  const choices = await effortChoicesFor(harness, account, session.model);
  if (!choices.values.length || choices.values.includes(session.effort)) return;
  // An empty level sends no effort flag at all (every argv builder checks
  // `input.effort &&`), which is exactly "the vendor's own default".
  session.effort = choices.default ?? '';
}

export const modelHandlers = {
  model: async ({ state, session, words }) => {
    // `--any`: an id typed on purpose (the picker's "Enter a model ID…") is
    // taken as given. The published-list check catches a typo in `/model x`;
    // it made "Enter a model ID…" able to enter only ids already listed.
    const trusted = words[0] === '--any';
    if (trusted) words.shift();
    const value = words.join(' ').trim();
    if (session.route === 'clikcode-local') return localModelCommand(session, value);
    // A Gateway conversation chooses from the Gateway's own list; `auto` hands
    // the choice back to it. The Gateway serves the model from its cheapest
    // provider -- subscription, then free, then paid -- and never another model.
    if (isGatewayService(session)) {
      if (!value) {
        const { models } = await gatewayModels();
        return emitHarnessOutput({
          panel: 'models',
          // The model and its price only: which provider serves it is the Gateway's decision.
          models: models.map((model) => ({ model: model.id, label: gatewayModelLabel(model), price: gatewayModelDetail(model) })),
          selected: session.model ?? 'Automatic',
        });
      }
      session.model = trusted && !isAutomaticModelWord(value) ? value : await chooseGatewayModel(value);
      // The model that answered last was answering the previous choice.
      if (session.reported?.model) delete session.reported.model;
      await saveSettings(state, session);
      // One of the user's own models, asleep: started now, so its GPU is starting while they type rather than
      // from their first message (which waits for it, "Starting model", and goes as soon as it is up).
      const chosen = (await gatewayModels().catch(() => ({ models: [] }))).models.find((model) => model.id === session.model);
      if (chosen?.own && chosen.own.state !== 'running') {
        const state = await wakeOwnModel(chosen.id).catch(quiet('tui/slash/handlers/model'));
        if (state === 'starting') {
          return emitHarnessOutput({ panel: 'settings-updated', text: `Starting ${chosen.id} on its GPU. Type away: your message waits and goes the moment it is ready.` });
        }
      }
      return;
    }
    const harness = session.nativeHarness ? localHarnessForCommand(session.nativeHarness) : undefined;
    // No value: show what there is to choose from, which is what
    // /permissions with no value already does. The interactive session opens
    // a picker before reaching here, so this is the headless answer -- and
    // there, listing the models is strictly more useful than a sentence
    // telling the user to go and list the models.
    //
    // THIS session's provider only, and its own account where it has one.
    // `/model` on a chosen provider is not a question about providers: the
    // conversation runs on one, and a model belonging to another is not a
    // thing this command could set. /models is the cross-provider list.
    if (!value) {
      const account = state.accounts.find((item) => item.id === session.accountId);
      const catalog = harness ? await nativeModelCatalogForPicker(harness, account) : undefined;
      return emitHarnessOutput({
        panel: 'models',
        models: catalog && harness
          ? catalog.models.map((model) => ({ account: account?.label ?? 'automatic', provider: harness.provider, model, label: harnessModelLabel(harness, model) }))
          : modelChoicesFor({ ...session, provider: harness?.provider ?? session.provider }, state.accounts),
        selected: session.model,
      });
    }
    if (!harness || !harnessSupportsModelSelection(harness)) throw new Error(`${harness?.displayName ?? 'This provider'} does not publish a model selector.`);
    const account = state.accounts.find((item) => item.id === session.accountId);
    // `/model auto` and `/model default` mean "stop overriding", not "store a
    // word no vendor accepts" -- so they RESOLVE to whatever the harness
    // really publishes instead of clearing the field to null. A null here is
    // what used to surface as "automatic", then as "default": a session whose
    // real model nobody could name.
    // Typed the way the picker shows it (`claude-code:sonnet`), stored the
    // way the harness takes it (`claude-code/sonnet`).
    const typed = normalizeModelWord(harness ? modelIdFromDisplay(harness, value) : value);
    const requested = typed && !trusted ? await assertRealModel(harness, account, typed) : typed;
    const model = requested ?? await resolveNativeModel(harness, account) ?? null;
    if (!model) throw new Error(`${harness.displayName} does not publish any models to choose from.`);
    session.model = model;
    // What the vendor reported running answered the PREVIOUS request. The
    // status line prefers it (a vendor that substitutes a model says so), so
    // left in place it kept naming the old model after this one was chosen,
    // until the next turn happened to report again.
    if (session.reported?.model) delete session.reported.model;
    await keepEffortValidFor(session, harness, account);
    session.updatedAt = new Date().toISOString();
    await writeState(state);
    return emitHarnessOutput({ panel: 'settings', session, account: state.accounts.find((item) => item.id === session.accountId)?.label });
  },
  effort: async ({ state, session, words }) => {
    const value = words.join(' ').trim().toLowerCase();
    if (isGatewayService(session)) {
      if (value !== 'default' && !(GATEWAY_EFFORTS as readonly string[]).includes(value)) {
        throw new Error(`usage: /effort <${['default', ...GATEWAY_EFFORTS].join('|')}>`);
      }
      session.effort = value === 'default' ? GATEWAY_DEFAULT_EFFORT : value;
      return saveSettings(state, session);
    }
    const harness = session.nativeHarness ? localHarnessForCommand(session.nativeHarness) : undefined;
    if (!harness) throw new Error('Choose a provider before setting effort.');
    const account = state.accounts.find((item) => item.id === session.accountId);
    // `default`: no level sent, so the harness uses its own (drive sends the
    // flag only for a non-empty effort).
    if (value === 'default') session.effort = '';
    else setSessionHarnessOption(session, harness, 'effort', value, (await effortChoicesFor(harness, account, session.model)).values);
    return saveSettings(state, session);
  },
  fast: async ({ state, session, words }) => {
    if (!isGatewayService(session)) throw new Error('Speed is a ClikDeploy Gateway choice: it picks among the providers of one model.');
    const value = words.join(' ').trim().toLowerCase();
    const on = value === '' ? session.speed !== 'fast' : value === 'on' ? true : value === 'off' ? false : undefined;
    if (on === undefined) throw new Error('usage: /fast [on|off]');
    if (on) session.speed = 'fast';
    else delete session.speed;
    return saveSettings(state, session);
  },
} satisfies Partial<Record<SlashHandlerKey, HeadlessSlashHandler>>;
