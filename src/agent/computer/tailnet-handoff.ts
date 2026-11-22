/** Handoff over the user's own Tailscale network, for a phone (or any other device) that is on it: a live view of this chat's tab on the
 * computer's Tailscale address (and nowhere else). The page is laid out for the device and drawn as Chrome paints it; touch and the device's
 * own keyboard reach it as real input (handoff-live.ts). No relay, no WebAssembly, no third-party host; a random path is the link's secret,
 * good for this one handoff (the device may reconnect to it), and it stops working after ten idle minutes or once the user says
 * they are done. */
import { networkInterfaces } from 'node:os';
import { quiet } from '../../runtime/lifecycle-log.js';
import { computerPage } from './browser.js';
import { serveLiveView } from './handoff-serve.js';
import { runCli } from './run-cli.js';

const IDLE_LIMIT = 10 * 60_000;

const inTailscaleRange = (address: string): boolean => {
  const [a, b] = address.split('.').map(Number);
  return a === 100 && b! >= 64 && b! <= 127;
};

/** This computer's Tailscale IPv4 address, if it is on a tailnet. 100.64.0.0/10 alone proves nothing: it is the carrier-grade
 * NAT range, and an ISP or a phone hotspot hands out addresses in it, so binding to one would serve the handoff to the ISP's
 * network. An address counts only on Tailscale's own interface (`tailscale0` on Linux, "Tailscale" on Windows) or when it is
 * the address `tailscale ip -4` reports (`confirmed`; macOS names the interface utunN) and some interface here holds it. */
export function tailnetAddress(interfaces = networkInterfaces(), confirmed?: string): string | undefined {
  let byName: string | undefined;
  let byConfirmed: string | undefined;
  for (const [name, list] of Object.entries(interfaces)) {
    for (const entry of list ?? []) {
      if (entry.family !== 'IPv4' || entry.internal || !inTailscaleRange(entry.address)) continue;
      if (/^tailscale/i.test(name)) byName ??= entry.address;
      if (confirmed && entry.address === confirmed) byConfirmed ??= entry.address;
    }
  }
  return byConfirmed ?? byName;
}

/** `tailscale ip -4`, asked with a short timeout: the address the Tailscale daemon itself says is this computer's. */
async function tailscaleIp(signal?: AbortSignal): Promise<string | undefined> {
  const candidates = process.platform === 'darwin' ? ['tailscale', '/Applications/Tailscale.app/Contents/MacOS/Tailscale'] : ['tailscale'];
  for (const command of candidates) {
    const result = await runCli(command, ['ip', '-4'], { timeoutMs: 5_000, maxChars: 1_000, ...(signal ? { signal } : {}) });
    if (result.missing) continue;
    const address = result.code === 0 ? result.text.split(/\s+/).find(inTailscaleRange) : undefined;
    if (address) return address;
  }
  return undefined;
}

/** The address to serve a handoff on: Tailscale's interface when it is named as such, else the one the daemon reports. */
export async function findTailnetAddress(options: { interfaces?: ReturnType<typeof networkInterfaces>; ask?: (signal?: AbortSignal) => Promise<string | undefined>; signal?: AbortSignal } = {}): Promise<string | undefined> {
  const interfaces = options.interfaces ?? networkInterfaces();
  const byName = tailnetAddress(interfaces);
  if (byName) return byName;
  const confirmed = await (options.ask ?? tailscaleIp)(options.signal).catch(quiet('agent/computer/tailnet-handoff'));
  return confirmed ? tailnetAddress(interfaces, confirmed) : undefined;
}

export async function runTailnetHandoff(input: {
  stateDir: string; host: string; tab?: string; signal?: AbortSignal; onLink(link: string): void;
}): Promise<void> {
  let finish!: () => void;
  const finished = new Promise<void>(resolve => { finish = resolve; });
  let idle: NodeJS.Timeout | undefined;
  let expire!: (error: Error) => void;
  const expired = new Promise<never>((_, reject) => { expire = reject; });
  expired.catch(() => undefined); // fail-open-ok: only marks it handled; the race that awaits it takes the rejection
  const keepAlive = (): void => {
    clearTimeout(idle);
    idle = setTimeout(() => expire(new Error('The handoff link expired after 10 idle minutes.')), IDLE_LIMIT);
  };
  const stopped = new Promise<never>((_, reject) => { input.signal?.addEventListener('abort', () => reject(new Error('Handoff stopped.')), { once: true }); });
  stopped.catch(() => undefined); // fail-open-ok: only marks it handled; the race that awaits it takes the rejection
  const server = await serveLiveView({ host: input.host, page: () => computerPage(input.stateDir, input.tab), onDone: finish, onActivity: keepAlive });
  try {
    input.onLink(server.address);
    keepAlive();
    await Promise.race([finished, expired, stopped]);
  } finally {
    clearTimeout(idle);
    await server.stop();
  }
}
