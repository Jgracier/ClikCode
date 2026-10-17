import { computerEnabled, setComputerEnabled } from '../agent/computer/settings.js';
import { stateDirectory } from '../session/store/paths.js';
import { emitResult } from '../cli/structured-output.js';
import { isJsonDefaultMode } from '../cli/output-mode.js';
import { closeComputerBrowser, computerPage } from '../agent/computer/browser.js';
import { loginFields, loginFieldSummary, loginOptions } from '../agent/computer/login-fields.js';
import { lockCredentialVault } from '../agent/computer/credential-vault.js';
import { randomUUID } from 'node:crypto';
import { WorkerClient } from '../worker/client.js';
import { listWorkerRecords } from '../worker/registry.js';
import { resolveChat } from './ai/harness.js';

export async function computerStatus(): Promise<void> {
  const enabled = await computerEnabled(stateDirectory());
  if (isJsonDefaultMode()) return emitResult({ computer: { enabled } });
  process.stdout.write(enabled
    ? 'Computer use is on. The agent can open URLs and control the desktop when a task needs it.\n'
    : 'Computer use is off. Run `clikcode computer on` to make it available.\n');
}

export async function computerSetEnabled(enabled: boolean): Promise<void> {
  await setComputerEnabled(stateDirectory(), enabled);
  if (!enabled) { await closeComputerBrowser(stateDirectory()); lockCredentialVault(stateDirectory()); }
  if (isJsonDefaultMode()) return emitResult({ computer: { enabled } });
  process.stdout.write(enabled
    ? 'Computer use is on. The agent can open URLs and control the desktop when a task needs it.\n'
    : 'Computer use is off for new ClikCode agent turns.\n');
}

/** Safe form metadata for a vendor agent. Never reads input values or takes a screenshot. */
export async function computerInspect(): Promise<void> {
  if (!await computerEnabled(stateDirectory())) throw new Error('Computer use is off.');
  const page = await computerPage(stateDirectory());
  try {
    const site = new URL(page.url()).origin;
    const fields = await loginFields(page);
    const options = await loginOptions(page);
    if (isJsonDefaultMode()) return emitResult({ computer: { site, fields: fields.map(({ label, kind }) => ({ label, kind })), options } });
    process.stdout.write(`${loginFieldSummary(site, fields, options)}\n`);
  } finally { await page.context().browser()?.close().catch(() => undefined); }
}

/** Ask for a site's credentials in the attached chat panel. This command's
 * stdout carries status only; the UI answer goes directly to its worker. */
export async function computerLogin(chat?: string, url?: string, newAccount?: boolean): Promise<void> {
  const workerPid = Number(process.env.CLIKCODE_WORKER_PID);
  const fromTurn = Number.isSafeInteger(workerPid) && workerPid > 0
    ? (await listWorkerRecords()).find(record => record.pid === workerPid)?.sessionId
    : undefined;
  const sessionId = chat ? await resolveChat(chat) : fromTurn;
  if (!sessionId) throw new Error('Use `clikcode computer login --chat <chat>` from outside a ClikCode chat.');
  if (fromTurn && sessionId !== fromTurn) throw new Error('A running chat can request a private login only in its own chat.');
  const client = await WorkerClient.attach(sessionId);
  const id = randomUUID();
  try {
    const result = await new Promise<{ ok: boolean; message: string }>((resolve, reject) => {
      let timer = setTimeout(() => { done(); reject(new Error('This chat is still running an older ClikCode worker. Try again after its current turn finishes.')); }, 5_000);
      const done = (): void => { clearTimeout(timer); client.off('event', onEvent); client.off('close', onClose); };
      const onClose = (): void => { done(); reject(new Error('The ClikCode chat disconnected.')); };
      const onEvent = (event: import('../worker/protocol.js').WorkerEvent): void => {
        if (event.type === 'computer-login-started' && event.id === id) {
          clearTimeout(timer);
          timer = setTimeout(() => { done(); reject(new Error('The private login prompt expired.')); }, 10 * 60_000);
          return;
        }
        if (event.type !== 'computer-login-result' || event.id !== id) return;
        done(); resolve(event);
      };
      client.on('event', onEvent);
      client.on('close', onClose);
      client.send({ type: 'computer-login', id, ...(url ? { url } : {}), ...(newAccount ? { newAccount: true as const } : {}) });
    });
    if (!result.ok) throw new Error(result.message);
    if (isJsonDefaultMode()) emitResult({ computer: { login: result.message } });
    else process.stdout.write(`${result.message}\n`);
  } finally { client.close(); }
}
