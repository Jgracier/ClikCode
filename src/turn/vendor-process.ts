/** Reusable vendor processes and build-specific transport fallback. */
import { harnessBinaryIdentity } from '../harness/transport/native/version-memo.js';
import { createCodexSession } from '../harness/transport/codex-app-server.js';
import { createAcpSession } from '../harness/transport/acp-client.js';
import type { AiHarnessAccount, AiLocalHarnessDefinition } from '../harness/definition.js';
import type { HarnessAvailableCommand } from '../harness/events/turn-observer.js';
import type { HarnessTurnTransport } from '../harness/transport/select.js';
import type { CodexSession } from '../harness/transport/codex-app-server.js';
import type { AcpSession } from '../harness/transport/acp-client.js';
import type { VendorBackgroundTurn, VendorBackgroundTurnHandler } from '../harness/transport/background-turn.js';

/** Harnesses whose `experimental` structured turn was rejected, by the build
 * that rejected it; later turns on that build go straight to the catalog's
 * proven `fallbackTurn`.
 *
 * Keyed on the binary's identity, not just the harness. It was a plain set of
 * names, held for the life of the process -- so an update to a vendor build
 * that accepts the experimental contract went on being sent the fallback,
 * because an OLDER build had once said no. What was learned is a fact about
 * that build, and it stops applying the moment the binary changes. */
const rejectedExperimentalTurn = new Map<string, string | undefined>();

export async function usesFallbackTurn(harness: AiLocalHarnessDefinition): Promise<boolean> {
  if (!rejectedExperimentalTurn.has(harness.command)) return false;
  return rejectedExperimentalTurn.get(harness.command) === await harnessBinaryIdentity(harness.binary);
}

export async function rememberFallbackTurn(harness: AiLocalHarnessDefinition): Promise<void> {
  rejectedExperimentalTurn.set(harness.command, await harnessBinaryIdentity(harness.binary));
}

/** ACP `available_commands_update`, per ClikCode session, for the slash registry. */
export const nativeAvailableCommands = new Map<string, readonly HarnessAvailableCommand[]>();
export function sessionNativeCommands(sessionId: string): readonly HarnessAvailableCommand[] {
  return nativeAvailableCommands.get(sessionId) ?? [];
}

interface PersistentTransport { key: string; transport: HarnessTurnTransport; session: CodexSession | AcpSession }
export const persistentTransports = new Map<string, PersistentTransport>();
/** Test seam: the transport session factories. */
const TRANSPORT_SESSIONS = { codex: createCodexSession, acp: createAcpSession };

/** Who receives the work a persistent vendor does between ClikCode turns
 * (harness/transport/background-turn.ts), per ClikCode session. The session
 * worker registers here; without a registration that work is not surfaced. */
const vendorBackgroundTurnHandlers = new Map<string, VendorBackgroundTurnHandler>();
export function setVendorBackgroundTurnHandler(sessionId: string, handler: VendorBackgroundTurnHandler | undefined): void {
  if (handler) vendorBackgroundTurnHandlers.set(sessionId, handler);
  else vendorBackgroundTurnHandlers.delete(sessionId);
}
/** The registered receiver, if any: a transport that can only hand work over
 * when someone will show it (native/held-vendor.ts) asks first. */
export function vendorBackgroundTurnHandlerFor(sessionId: string): VendorBackgroundTurnHandler | undefined {
  return vendorBackgroundTurnHandlers.get(sessionId);
}

/** Everything a vendor child was started with that a later turn must match
 * to reuse it: its harness, the account and the sign-in it holds, the
 * profile environment, and the working directory. */
export function vendorChildKey(
  harness: AiLocalHarnessDefinition, account: AiHarnessAccount, environment: Readonly<Record<string, string>>, workspace: string | undefined,
): string {
  return JSON.stringify([harness.command, account.id, account.signedInAt, environment, workspace]);
}

/** One live child per open ClikCode session, keyed by everything that makes a
 * child reusable (harness, account, profile env, cwd). A different key closes
 * the old child first, which is what covers account/harness/cwd changes. */
export function persistentTransportFor(sessionId: string, transport: HarnessTurnTransport, key: string): PersistentTransport {
  const existing = persistentTransports.get(sessionId);
  if (existing && existing.key === key && existing.transport === transport) return existing;
  if (existing) void closePersistentTransport(sessionId);
  const background = { backgroundTurns: (turn: VendorBackgroundTurn) => vendorBackgroundTurnHandlers.get(sessionId)?.(turn) };
  const created: PersistentTransport = {
    key, transport, session: transport === 'codex-app-server' ? TRANSPORT_SESSIONS.codex(background) : TRANSPORT_SESSIONS.acp(background),
  };
  persistentTransports.set(sessionId, created);
  return created;
}

export async function closePersistentTransport(sessionId?: string): Promise<void> {
  const ids = sessionId === undefined ? [...persistentTransports.keys()] : [sessionId];
  await Promise.all(ids.map(async (id) => {
    const live = persistentTransports.get(id);
    if (!live) return;
    persistentTransports.delete(id);
    await live.session.close().catch(() => undefined);
  }));
}
