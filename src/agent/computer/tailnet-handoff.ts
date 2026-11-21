/** Handoff over the user's own Tailscale network, for a phone (or any other device) that is on it: a live view of this chat's tab on the
 * computer's Tailscale address (and nowhere else). The page is laid out for the device and drawn as Chrome paints it; touch and the device's
 * own keyboard reach it as real input (handoff-live.ts). No relay, no WebAssembly, no third-party host; a random path is the one-use secret,
 * and the link stops working after ten idle minutes or once the user says they are done. */
import { networkInterfaces } from 'node:os';
import { computerPage } from './browser.js';
import { serveLiveView } from './handoff-serve.js';

const IDLE_LIMIT = 10 * 60_000;

/** This computer's Tailscale IPv4 address (100.64.0.0/10), if it is on a tailnet. */
export function tailnetAddress(interfaces = networkInterfaces()): string | undefined {
  for (const list of Object.values(interfaces)) {
    for (const entry of list ?? []) {
      if (entry.family !== 'IPv4' || entry.internal) continue;
      const [a, b] = entry.address.split('.').map(Number);
      if (a === 100 && b! >= 64 && b! <= 127) return entry.address;
    }
  }
  return undefined;
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
