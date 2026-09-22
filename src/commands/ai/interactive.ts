/**
 * The interactive session: one terminal, one conversation, until you leave.
 *
 * Everything here exists because a human is watching. It owns the prompter's
 * lifetime, the claim that stops two terminals from driving one conversation,
 * the routing of each typed line to either a turn or a slash handler, and the
 * unwinding of all of that on exit -- including exits it did not choose, like
 * a mobile SSH connection dropping mid-turn.
 */
import { isUsageExhaustedMessage } from '../../turn/usage-exhausted.js';
import type Conf from 'conf';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import chalk from 'chalk';
import { runNativeHarnessCommand } from '../../harness/transport/native/command.js';
import { spawnPortable as spawn } from '../../harness/transport/spawn.js';
import type { HarnessPrompter, PickerOption } from '../../harness/prompter.js';
import type { HarnessSession, HarnessState } from '../../session/model.js';
import { compactPath, sessionProviderLabel } from '../../harness/protocol/labels.js';
import { localHarnessCapabilityManifest, localHarnessForCommand, localHarnessForProvider } from '../../runtime/lazy-bridge.js';
import { readState } from '../../session/state/read.js';
import { writeState } from '../../session/state/write.js';
import { nativeUsageReading } from '../../harness/accounts/account-usage.js';
import { resolveNativeModel } from '../../harness/accounts/model-catalog.js';
import { usageResetLabel } from '../../harness/accounts/usage-reading.js';
import { closePersistentTransport, discardInterruptedTurn, nativeAvailableCommands, persistentTransports, preserveInterruptedTurn, synchronizeNativeTranscript, turnEnvironment } from '../../turn/runtime.js';
import { aiGatewaySessionSend } from '../../turn/drive.js';
import { TERMINAL } from '../../tui/active-terminal.js';
import { emitHarnessOutput, line } from '../../harness/output.js';
import { TerminalHarnessPrompter } from '../../tui/prompter.js';
import { terminalUiSupported } from '../../tui/capabilities.js';
import { expandHomePath, queueAttachment, resolveStandaloneAttachment } from '../../session/attachments.js';
import { claimSession, releaseSession, SESSION_CLAIM_TTL_MS } from '../../session/claim.js';
import { existsSync } from 'node:fs';
import { routeSlashInput, slashPalette, unknownSlashMessage, type SlashHandlerKey } from '../../tui/slash/registry.js';
import { customCommandPrompt } from '../../session/custom-commands.js';
import { LiveTurnInputBroker } from '../../turn/live-input.js';
import { sessionTranscriptMessages } from '../../turn/checkpoint.js';
import { newConversation, newProviderConversation, releaseQueuedTurn } from './conversations.js';
import { aiSessionLeave, launchSession } from './sessions.js';
import { aiSessionCommand } from '../../tui/slash/handlers.js';
import { customCommandsFor, sessionHarness, slashExtrasFor, slashRouteContextFor } from '../../tui/slash/context.js';
import { capabilitiesText } from '../../tui/slash/capabilities-text.js';
import { compactConversation } from '../../tui/slash/compact.js';
import { exportTranscript } from '../../tui/slash/export-transcript.js';
import { initPrompt, readMemoryFile, reviewPrompt } from '../../tui/slash/memory.js';
import { nativeManagerListing } from '../../tui/slash/native-manager.js';
import { addAccountForHarness, interactiveAccountPicker, manageAccountAction } from '../../tui/pickers/account.js';
import { autoSelectSessionHarness, interactiveEnginePicker } from '../../tui/pickers/engine.js';
import { interactiveEffortPicker } from '../../tui/pickers/effort.js';
import { interactiveHarnessOptionPicker } from '../../tui/pickers/options.js';
import { interactiveModelPicker } from '../../tui/pickers/model.js';
import { interactivePermissionPicker } from '../../tui/pickers/permissions.js';
import { interactiveSessionManager, interactiveSessionPicker } from '../../tui/pickers/session.js';
import { interactiveSettingsPicker } from '../../tui/pickers/settings.js';
import { doctorSummary } from '../../tui/doctor-summary.js';
import type { InteractiveSlashHandlerKey, InteractiveSlashOutcome } from '../../tui/slash/interactive-keys.js';
import { closeAllWorkerClients, runTurnThroughWorker } from '../../worker/turn-bridge.js';

/** Routes real terminal turns through a session worker (src/worker/) rather
 * than running them in this process. ON by default; `CLIKCODE_USE_WORKER=0`
 * falls back to the direct in-process path, which remains completely
 * unchanged.
 *
 * The opt-out is kept deliberately, not left behind: the worker has one
 * known untested gap (a worker has no TTY, so a mid-turn interactive vendor
 * login can only report that it is blocked) against a direct path with
 * hundreds of real invocations behind it. Deleting the fallback is a
 * separate decision that wants real dogfooding first, and it is what
 * unblocks removing claim.ts/claims.ts -- see project memory
 * clikcode-worker-client-split.
 *
 * NOT on that deletion list, contrary to the earlier plan: the
 * SIGHUP/SIGINT-ignoring block a few lines down. Its SIGINT half guards
 * client-side identity derivation and vendor login, and the worker design
 * keeps both of those in the client on purpose -- so that block protects a
 * real, previously reproduced bug (an account never saved because a hangup
 * killed the process before any handler could run) that the worker split
 * does not address. */
const USE_SESSION_WORKER = process.env.CLIKCODE_USE_WORKER !== '0';

export async function aiSessionOpenDefault(config: Conf): Promise<void> {
  const state = await readState();
  const session = launchSession(state, process.cwd());
  state.sessions.push(session);
  await writeState(state);
  await aiSessionInteractive(config, session.id);
}

export async function aiSessionResume(config: Conf, id: string): Promise<void> {
  const state = await readState();
  const session = state.sessions.find((item) => item.id === id);
  if (!session) throw new Error(`AI session "${id}" was not found`);
  if (session.status !== 'active') {
    session.status = 'active';
    session.closedAt = undefined;
    session.updatedAt = new Date().toISOString();
    await writeState(state);
  }
  await aiSessionInteractive(config, session.id);
}


export async function aiSessionInteractive(config: Conf, id: string): Promise<void> {
  // A long-lived interactive session should survive a transient terminal
  // hangup (a flaky/mobile SSH connection dropping and reconnecting mid-use
  // is exactly the kind of thing this hits), not die from it. Node's
  // default action for an unhandled SIGHUP is immediate termination --
  // before any try/catch, before uncaughtException, before anything this
  // process could do about it. run()'s own SIGHUP forwarding only covers
  // the narrow window a login/turn subprocess is actually running; a
  // hangup arriving in any of the gaps around that (mid-suspend, during
  // identity derivation, mid-render) previously killed the whole process
  // silently -- explaining a real, reproduced case where the account never
  // saved because ClikCode itself was gone, with no crash log at all
  // (SIGHUP's default handling pre-empts JS entirely; there was nothing
  // for a crash handler to catch). Ignoring it here covers the session's
  // entire lifetime, not just subprocess windows. SIGINT gets the identical
  // treatment for a related but distinct reason: run()'s own Ctrl+C
  // forwarding to a login/turn subprocess is removed the INSTANT that
  // subprocess exits -- but the terminal stays in cooked mode (raw mode
  // off, from suspend()) for everything that happens after, including this
  // codebase's own identity-derivation retry loop, which can legitimately
  // run for several seconds with nothing visibly changing on screen. A
  // Ctrl+C landing in that specific gap -- a completely natural thing to do
  // when the screen looks idle right after pasting an auth code --
  // previously had no handler registered at all, so Node's default SIGINT
  // action (immediate termination) applied, killing the process mid-save.
  // While raw mode IS active (the normal composer state), Ctrl+C is read
  // as data (byte 0x03) handled entirely inside this UI, never reaching
  // the OS as a real signal at all -- so ignoring the signal here changes
  // nothing about that existing, working "cancel the current turn"
  // behavior; it only closes the gap where raw mode is temporarily off and
  // nothing else is watching. /exit and /quit remain the ways to leave.
  const ignoreHangup = (): void => {};
  const ignoreInterrupt = (): void => {};
  if (process.platform !== 'win32') process.on('SIGHUP', ignoreHangup);
  process.on('SIGINT', ignoreInterrupt);
  try {
    await aiSessionInteractiveInner(config, id);
  } finally {
    if (process.platform !== 'win32') process.off('SIGHUP', ignoreHangup);
    process.off('SIGINT', ignoreInterrupt);
  }
}

async function aiSessionInteractiveInner(config: Conf, id: string): Promise<void> {
  // Reassigned whenever a nested flow writes its own state: `session` must stay
  // a member of whichever snapshot we later hand to writeState, or that write
  // both reverts the nested flow's work and drops our own edits.
  let state = await readState();
  let session = state.sessions.find((item) => item.id === id);
  if (!session) throw new Error(`AI session "${id}" was not found`);
  if (await synchronizeNativeTranscript(state, session)) await writeState(state);
  // Palette rows come from the ONE slash registry (with argHint/group).
  // slashPalette itself leaves out everything the vendor harness owns -- its
  // manager commands, whatever an ACP agent advertised, and the `/<harness>`
  // switch rows -- so what the palette shows is ClikCode's own commands plus
  // the user's custom templates, never the terminal CLI's list mixed in.
  const slashCommandsFor = (target: HarnessSession): PickerOption<string>[] => {
    const harness = sessionHarness(target);
    return slashPalette(target, harness, slashExtrasFor(target, harness));
  };
  // Created before auto-select so a first-ever install/sign-in — the most
  // common time either is actually needed — has somewhere to show its
  // "installing…" spinner and a real terminal to suspend into for a vendor
  // login prompt, instead of running headless before the UI exists.
  const rl: HarnessPrompter = terminalUiSupported()
    ? new TerminalHarnessPrompter()
    : createInterface({
      input, output, terminal: false, historySize: 1_000, removeHistoryDuplicates: true,
      completer: (value: string) => {
        const fallbackCommands = slashCommandsFor(session!).map((item) => item.value);
        const matches = fallbackCommands.filter((command) => command.startsWith(value));
        return [matches.length ? matches : fallbackCommands, value] as [string[], string];
      },
    });
  if (rl instanceof TerminalHarnessPrompter) TERMINAL.active = rl;
  rl.render?.(session);
  if (!session.nativeHarness && session.route !== 'gateway') {
    const auto = await autoSelectSessionHarness(id);
    if (!auto) {
      const selected = await interactiveEnginePicker(config, rl, id);
      if (!selected) return;
      if (selected !== id) id = selected;
    }
    // The picker and auto-select each ran their own read/write cycle, so the
    // snapshot above is stale. Adopt the current one wholesale.
    state = await readState();
    const next = state.sessions.find((item) => item.id === id);
    if (!next) return;
    session = next;
  }
  let stateChanged = false;
  if (session.status !== 'active') {
    session.status = 'active';
    session.closedAt = undefined;
    session.updatedAt = new Date().toISOString();
    stateChanged = true;
  }
  if (!session.model) {
    const harness = session.nativeHarness ? localHarnessForCommand(session.nativeHarness)
      : session.provider ? localHarnessForProvider(session.provider) : undefined;
    const account = session.accountId ? state.accounts.find((item) => item.id === session.accountId) : undefined;
    if (harness) {
      const resolved = await resolveNativeModel(harness, account);
      if (resolved) {
        session.model = resolved;
        session.updatedAt = new Date().toISOString();
        stateChanged = true;
      }
    }
  }
  // Take ownership before the first paint so a terminal opened a moment later
  // skips this conversation instead of attaching to it.
  claimSession(session);
  stateChanged = true;
  if (stateChanged) await writeState(state);
  const initialAccount = session.accountId ? state.accounts.find((account) => account.id === session.accountId)?.label : undefined;
  if (rl.render) rl.render(session, initialAccount);
  else emitHarnessOutput({ status: 'ready', session, account: initialAccount });
  const refreshUsage = (target: HarnessSession, targetState: HarnessState): void => {
    if (!(rl instanceof TerminalHarnessPrompter)) return;
    void nativeUsageReading(target, targetState).then((reading) => {
      if (TERMINAL.active === rl) rl.usage(reading?.label, usageResetLabel(reading?.windows));
    }).catch(() => { /* Usage is optional provider metadata. */ });
  };
  refreshUsage(session, state);
  // Without this, usage only ever refreshed at session-open and right after
  // each submitted message -- fine for a quick back-and-forth, but a long
  // turn or an idle stretch between messages left the number sitting there
  // stale for however long that gap was, well past nativeUsageReading's own
  // 30s cache window (which bounds *how often this can update*, not
  // *whether anything ever asks it to*). This is what actually asks.
  const claimInterval = setInterval(() => {
    void refreshSessionClaim(id).catch(() => undefined);
  }, Math.floor(SESSION_CLAIM_TTL_MS / 3));
  claimInterval.unref();
  const usageInterval = rl instanceof TerminalHarnessPrompter ? setInterval(() => {
    void readState().then((latestState) => {
      const latest = latestState.sessions.find((item) => item.id === id);
      if (latest) refreshUsage(latest, latestState);
    }).catch(() => { /* Usage is optional provider metadata. */ });
    // Half the usage window, so every other tick finds the reading expired and
    // refreshes it. A tick longer than the window would land inside it and
    // silently halve the real refresh rate.
  }, 15_000) : undefined;
  let notice: string | undefined;
  let synchronizedSessionId = id;
  let transportSessionId = id;
  try {
    while (true) {
      let line: string;
      let queuedTurnId: string | undefined;
      let activeWorkspace = process.cwd();
      // One live Codex/ACP child per OPEN conversation: leaving it (new chat,
      // handoff, resume) closes the child it had.
      if (transportSessionId !== id) {
        await closePersistentTransport(transportSessionId);
        nativeAvailableCommands.delete(transportSessionId);
        transportSessionId = id;
      }
      try {
        const latestState = await readState();
        const latest = latestState.sessions.find((item) => item.id === id);
        if (!latest) break;
        activeWorkspace = latest.workspace ?? process.cwd();
        if (synchronizedSessionId !== id) {
          if (await synchronizeNativeTranscript(latestState, latest)) await writeState(latestState);
          synchronizedSessionId = id;
        }
        const account = latest.accountId ? latestState.accounts.find((item) => item.id === latest.accountId)?.label : undefined;
        rl.render?.(latest, account, notice);
        refreshUsage(latest, latestState);
        notice = undefined;
        const queued = latest.queuedTurns?.[0];
        if (queued) {
          // No notice: a queued message is echoed into the conversation as the
          // user message it is, and the waiting row underneath says a turn is
          // running. Announcing it a third time said nothing the screen did
          // not already say.
          line = queued.text;
          queuedTurnId = queued.id;
        } else line = (await rl.question('› ', slashCommandsFor(latest), { rightArrowPalette: true })).trim();
      } catch (error) {
        // A non-interactive caller may close stdin after its final command.
        // Treat that exactly like leaving the foreground harness, not a crash.
        if ((error as NodeJS.ErrnoException).code === 'ERR_USE_AFTER_CLOSE') break;
        throw error;
      }
      if (!line) continue;
      let interruptedSubmission: { text: string; restoreOnEscape: boolean } | undefined;
      /** One turn with the normal waiting / cancel / live-input UI. `echo`
       * paints the submitted text as the pending user message; synthetic
       * prompts (/review, /init, /compact) are not shown as if typed. */
      const runInteractiveTurn = async (targetId: string, promptText: string, turn: { echo: boolean; queuedTurnId?: string }): Promise<void> => {
        const activeState = await readState();
        const active = activeState.sessions.find((item) => item.id === targetId);
        const activeAccount = active?.accountId ? activeState.accounts.find((item) => item.id === active.accountId)?.label : undefined;
        const run = {
          persistentTransports: true,
          ...(turn.queuedTurnId ? { queuedTurnId: turn.queuedTurnId } : {}),
          ...(rl instanceof TerminalHarnessPrompter ? { prompter: rl } : {}),
        };
        if (active && rl.render) {
          const pending: HarnessSession = {
            ...active,
            messages: [...sessionTranscriptMessages(active), ...(turn.echo ? [{ role: 'user' as const, content: promptText }] : [])].slice(-40),
            pendingTurn: undefined,
            ...(turn.queuedTurnId
              ? { queuedTurns: active.queuedTurns?.filter((item) => item.id !== turn.queuedTurnId) }
              : {}),
          };
          rl.render(pending, activeAccount);
          if (USE_SESSION_WORKER && rl instanceof TerminalHarnessPrompter) {
            // The worker owns cancellation/steering and the preserve-vs-
            // discard decision on a real cancel itself now (see
            // worker/session-worker.ts's runTurn) -- interruptedSubmission,
            // a few lines below in the catch block this bypasses, is what
            // the DIRECT path still needs that decision made FOR it from.
            // Left unset here on purpose: `cancelled` will be false for
            // this path regardless (runTurnThroughWorker never rethrows an
            // ordinary cancellation, only a genuine failure), so that
            // block's own `interruptedSubmission &&` check already no-ops
            // correctly without this being threaded through it too.
            const outcome = await runTurnThroughWorker(targetId, rl, promptText, turn);
            if (outcome.notice) notice = outcome.notice;
            return;
          }
          const turnController = new AbortController();
          const liveInput = new LiveTurnInputBroker();
          interruptedSubmission = { text: promptText, restoreOnEscape: false };
          TERMINAL.active?.startWaiting('thinking', (restoreDraft) => {
            interruptedSubmission!.restoreOnEscape = restoreDraft && turn.echo;
            turnController.abort();
          }, (text) => liveInput.submit(text));
          try { await aiGatewaySessionSend(config, targetId, promptText, turnController.signal, { ...run, liveInput }); }
          finally {
            liveInput.close();
            await TERMINAL.active?.flushWaitingSubmissions();
            TERMINAL.active?.stopWaiting();
          }
          return;
        }
        output.write(`${chalk.dim(`${active ? sessionProviderLabel(active) : 'Provider'} · working…`)}\n`);
        try { await aiGatewaySessionSend(config, targetId, promptText, undefined, run); }
        finally { TERMINAL.active?.stopWaiting(); }
      };
      /** A subprocess the user has to wait for gets the same waiting indicator a turn does. */
      const withWaiting = async <T>(label: string, work: () => Promise<T>): Promise<T> => {
        if (!(rl instanceof TerminalHarnessPrompter)) return work();
        rl.startWaiting(label);
        try { return await work(); } finally { rl.stopWaiting(); }
      };
      const pause = async (): Promise<void> => { if (rl.render) await rl.question('Press Enter to return › '); };
      /** The headless handler, with its output in a panel; pauses when one was shown. */
      const viaHeadless = async (text: string): Promise<InteractiveSlashOutcome> => {
        const before = TERMINAL.panelsShown;
        const resulting = await aiSessionCommand(id, text);
        if (TERMINAL.panelsShown > before) await pause();
        return resulting !== id ? { id: resulting } : {};
      };
      try {
        // A queued live-composer submission is always conversation text. A
        // leading slash or path in it must not turn into a local command when
        // it is automatically dispatched after the active turn.
        if (queuedTurnId) {
          await runInteractiveTurn(id, line, { echo: true, queuedTurnId });
          continue;
        }
        const standaloneAttachment = await resolveStandaloneAttachment(line, activeWorkspace);
        if (standaloneAttachment) {
          const attachmentState = await readState();
          const attachmentSession = attachmentState.sessions.find((item) => item.id === id);
          if (!attachmentSession) throw new Error(`AI session "${id}" was not found`);
          await queueAttachment(attachmentSession, standaloneAttachment);
          attachmentSession.updatedAt = new Date().toISOString();
          await writeState(attachmentState);
          notice = `Attached ${compactPath(standaloneAttachment)} for the next request`;
          if (!rl.render) emitHarnessOutput({ panel: 'attachments', attachments: attachmentSession.attachments ?? [] });
          continue;
        }
        const commandState = await readState();
        const commandSession = commandState.sessions.find((item) => item.id === id);
        if (!commandSession) break;
        const commandHarness = sessionHarness(commandSession);
        // `/etc/hosts explain this` is a request about a file, not a command.
        const route = routeSlashInput(line, slashRouteContextFor(commandSession, commandHarness, (path) => existsSync(expandHomePath(path))));
        let outcome: InteractiveSlashOutcome = {};
        if (route.kind === 'prompt') outcome = { prompt: route.prompt, echo: true };
        else if (route.kind === 'native') {
          if (commandSession.route === 'gateway') throw new Error('Native harness commands apply only to local harnesses.');
          outcome = { prompt: route.prompt, echo: true };
        }
        else if (route.kind === 'unknown') throw new Error(unknownSlashMessage(route));
        else if (route.kind === 'custom') {
          const custom = customCommandsFor(commandSession, commandHarness).find((item) => item.name === route.name);
          if (!custom) throw new Error(`custom command /${route.name} is no longer available`);
          outcome = { prompt: customCommandPrompt(custom, route.args, commandHarness), echo: false };
        }
        else if (route.kind === 'harness') {
          // `/<harness> [request]`: hand off, ADOPT the resulting session, and
          // run the request here with the normal waiting UI -- it used to run
          // headless on a branch this loop never switched to.
          const selected = await newProviderConversation(id, route.command);
          outcome = { id: selected, ...(route.args ? { prompt: route.args, echo: true } : {}) };
        }
        else if (route.kind === 'manager') {
          const manager = commandHarness ? (localHarnessCapabilityManifest(commandHarness).managers as Record<string, { label: string; listArgv?: readonly string[]; manageArgv?: readonly string[] } | undefined> | undefined)?.[route.name] : undefined;
          if (!commandHarness || !manager) throw new Error('Choose a provider first.');
          if (manager.listArgv) {
            const listing = await withWaiting(`loading ${manager.label}…`, () => nativeManagerListing(commandState, commandSession, route.name));
            rl.panel?.(listing.label, listing.text);
            if (!rl.panel) emitHarnessOutput({ panel: route.name, text: `${listing.label}\n\n${listing.text}` });
            await pause();
          } else if (manager.manageArgv && rl instanceof TerminalHarnessPrompter) {
            const selectedAccount = commandSession.accountId ? commandState.accounts.find((item) => item.id === commandSession.accountId) : undefined;
            await rl.suspend();
            try { await runNativeHarnessCommand(commandHarness, manager.manageArgv, turnEnvironment(commandHarness, selectedAccount)); }
            finally { rl.resume(); }
          } else throw new Error(`${commandHarness.displayName} requires an interactive terminal for ${manager.label}.`);
        }
        else {
          // Availability is decided BEFORE any picker opens, so `/model` on a
          // harness without a model selector says so instead of offering a list.
          const availability = route.entry.availability(commandSession, commandHarness);
          if (!availability.available) throw new Error(availability.reason ?? `/${route.entry.name} is not available here.`);
          const text = `/${route.entry.name}${route.args ? ` ${route.args}` : ''}`;
          const { args } = route;
          const interactive: Record<InteractiveSlashHandlerKey, () => Promise<InteractiveSlashOutcome | void>> = {
            exit: async () => { await aiSessionLeave(id); return { exit: true }; },
            new: async () => ({ id: await newConversation(id), ...(args ? { prompt: args, echo: true } : {}) }),
            redraw: async () => { rl.render?.(commandSession, commandSession.accountId ? commandState.accounts.find((item) => item.id === commandSession.accountId)?.label : undefined); },
            provider: async () => ({ id: await interactiveEnginePicker(config, rl, id) ?? id }),
            account: async () => args ? viaHeadless(text) : { id: await interactiveAccountPicker(rl, id) ?? id },
            accounts: async () => args ? viaHeadless(text) : { id: await interactiveAccountPicker(rl, id) ?? id },
            model: async () => args ? viaHeadless(text) : interactiveModelPicker(rl, id),
            effort: async () => args ? viaHeadless(text) : interactiveEffortPicker(rl, id),
            permissions: async () => args ? viaHeadless(text) : interactivePermissionPicker(rl, id),
            options: async () => interactiveHarnessOptionPicker(rl, id),
            capabilities: async () => {
              const [title = 'Capabilities', ...rest] = capabilitiesText(commandSession).split('\n');
              rl.panel?.(title, rest.join('\n'));
              if (!rl.panel) emitHarnessOutput({ panel: 'capabilities', text: [title, ...rest].join('\n') });
              await pause();
            },
            settings: async () => args ? viaHeadless(text) : { id: await interactiveSettingsPicker(config, rl, id) ?? id },
            sessions: async () => {
              if (args) return viaHeadless(text);
              const action = await interactiveSessionManager(rl, id);
              if (action === 'exit') return { exit: true };
              if (action === 'new') return { id: await newConversation(id) };
              if (action === 'resume') return { id: (await interactiveSessionPicker(rl, id))?.id ?? id };
              return {};
            },
            // Resume means reopening the selected conversation at its source:
            // retain its account, harness, and exact native session identity.
            // Moving a transcript to another provider remains an explicit
            // /provider action, never a side effect of choosing history.
            resume: async () => ({ id: (await interactiveSessionPicker(rl, id))?.id ?? id }),
            rename: async () => {
              const name = args || (await rl.question('Conversation name › ')).trim();
              if (name) await aiSessionCommand(id, `/rename ${name}`);
            },
            archive: async () => {
              const answer = (await rl.question('Archive this conversation? [y/N] › ')).trim().toLowerCase();
              if (!['y', 'yes'].includes(answer)) return {};
              await aiSessionCommand(id, '/archive');
              return { exit: true };
            },
            delete: async () => {
              const answer = (await rl.question('Delete this conversation? Type delete › ')).trim().toLowerCase();
              if (answer !== 'delete') return {};
              await aiSessionCommand(id, '/delete confirm');
              return { exit: true };
            },
            mention: async () => {
              const path = args || (await rl.question('File to attach › ')).trim();
              return path ? viaHeadless(`/mention ${path}`) : {};
            },
            review: async () => ({ prompt: reviewPrompt(args), echo: false }),
            init: async () => ({ prompt: initPrompt(commandSession), echo: false }),
            native: async () => {
              if (!args) throw new Error('usage: /native <text>  (or //text)');
              return { prompt: args, echo: true };
            },
            compact: async () => {
              const compacted = await compactConversation(id, commandSession, args, (targetId, promptText) => runInteractiveTurn(targetId, promptText, { echo: false }));
              return typeof compacted === 'string'
                ? { id: compacted, notice: 'Conversation compacted · the full transcript stays available in /resume' }
                : { notice: 'Compacted by the provider' };
            },
            export: async () => {
              const path = await exportTranscript(commandSession, args, async (existing) =>
                ['y', 'yes'].includes((await rl.question(`${compactPath(existing)} exists. Overwrite? [y/N] › `)).trim().toLowerCase()));
              return { notice: `Transcript written to ${compactPath(path)}` };
            },
            memory: async () => {
              if (route.words[0]?.toLowerCase() !== 'edit') return viaHeadless(text);
              const memory = await readMemoryFile(commandSession);
              const editor = process.env.VISUAL || process.env.EDITOR || (process.platform === 'win32' ? 'notepad' : 'vi');
              const [editorBinary = 'vi', ...editorArgs] = editor.split(/\s+/).filter(Boolean);
              if (rl instanceof TerminalHarnessPrompter) await rl.suspend();
              try {
                await new Promise<void>((resolveEdit, rejectEdit) => {
                  const child = spawn(editorBinary, [...editorArgs, memory.path], { stdio: 'inherit', cwd: commandSession.workspace ?? process.cwd() });
                  child.once('error', rejectEdit);
                  child.once('exit', () => resolveEdit());
                });
              } finally { if (rl instanceof TerminalHarnessPrompter) rl.resume(); }
              return { notice: `Edited ${compactPath(memory.path)}` };
            },
            doctor: async () => {
              const report = await withWaiting('checking harnesses…', () => doctorSummary(commandState));
              rl.panel?.('ClikCode doctor', report);
              if (!rl.panel) emitHarnessOutput({ panel: 'doctor', text: report });
              await pause();
            },
            login: async () => {
              if (!commandHarness) throw new Error('Choose a provider before signing in.');
              if (commandSession.accountId) await manageAccountAction(rl, commandSession.accountId, 'reauthenticate');
              else await addAccountForHarness(rl, commandHarness);
              return { notice: `Signed in to ${commandHarness.displayName}` };
            },
            logout: async () => {
              if (!commandSession.accountId) throw new Error('This conversation has no account to sign out.');
              await closePersistentTransport(id);
              await withWaiting('signing out…', () => manageAccountAction(rl, commandSession.accountId!, 'disconnect'));
              return { notice: 'Signed out' };
            },
          };
          const handler = (interactive as Partial<Record<SlashHandlerKey, () => Promise<InteractiveSlashOutcome | void>>>)[route.entry.handlerKey];
          outcome = (handler ? await handler() : await viaHeadless(text)) ?? {};
        }
        if (outcome.notice) notice = outcome.notice;
        if (outcome.exit) break;
        if (outcome.id && outcome.id !== id) id = outcome.id;
        if (outcome.prompt) await runInteractiveTurn(id, outcome.prompt, { echo: outcome.echo !== false });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const cancelled = (error as NodeJS.ErrnoException).code === 'ERR_TURN_CANCELLED' || (error as Error).name === 'AbortError';
        // A queued turn is only consumed once its checkpoint starts. Anything
        // that throws before that -- a removed account, an unavailable model, an
        // attachment deleted since it was queued -- leaves the same message at
        // the head of the queue, so the next iteration picks it up and fails
        // identically: a hot loop that never returns a prompt and can only be
        // cleared by hand-editing harness-state.json. Release it and hand the
        // text back so the failure is visible and recoverable.
        if (queuedTurnId && !cancelled) {
          await releaseQueuedTurn(id, queuedTurnId).catch(() => undefined);
          TERMINAL.active?.restoreDraft(line);
        }
        if (cancelled && interruptedSubmission && TERMINAL.active) {
          const outputStarted = TERMINAL.active.turnOutputStarted();
          const partialResponse = TERMINAL.active.liveResponseText();
          if (outputStarted) await preserveInterruptedTurn(id, interruptedSubmission.text, partialResponse, true);
          else {
            await discardInterruptedTurn(id, interruptedSubmission.text);
            if (interruptedSubmission.restoreOnEscape) TERMINAL.active.restoreDraft(interruptedSubmission.text);
          }
          notice = outputStarted ? 'Stopped' : interruptedSubmission.restoreOnEscape ? 'Stopped · draft restored' : 'Stopped';
        // Running out of quota is an outcome, not a fault: ClikCode's own
        // "Usage Exhausted · Resets …" is a finished sentence and reads wrong
        // behind an "Error:" that suggests something broke.
        } else if (rl.render) {
          notice = cancelled ? 'Stopped' : isUsageExhaustedMessage(message) ? message : `Error: ${message}`;
        }
        else emitHarnessOutput({ panel: 'error', message });
      }
    }
  } finally {
    if (usageInterval) clearInterval(usageInterval);
    if (claimInterval) clearInterval(claimInterval);
    if (USE_SESSION_WORKER) await closeAllWorkerClients().catch(() => undefined);
    await closePersistentTransport().catch(() => undefined);
    // Hand the conversation back so the next terminal can resume it. Best
    // effort: a failure here only means the claim expires on its own TTL.
    await releaseSessionClaim(id).catch(() => undefined);
    if (TERMINAL.active === rl) TERMINAL.active = undefined;
    rl.close();
  }
}

/** Refreshes this terminal's claim on its conversation. Runs on a timer rather
 * than per turn so a long turn, or a long idle stretch, both keep the claim
 * alive without any traffic of their own. */
async function refreshSessionClaim(id: string): Promise<void> {
  const state = await readState();
  const session = state.sessions.find((item) => item.id === id);
  if (!session) return;
  claimSession(session);
  await writeState(state);
}

async function releaseSessionClaim(id: string): Promise<void> {
  const state = await readState();
  const session = state.sessions.find((item) => item.id === id);
  if (!session?.claim) return;
  releaseSession(session);
  await writeState(state);
}
