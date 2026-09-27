/** How llama-server is started: its command line, from the fit and the
 * hardware, and the wait until it answers.
 *
 * CPU settings were measured with llama-bench on an 8-core / 16-thread
 * Zen 4 running a 35B-A3B MoE:
 *  - Generation is fastest at exactly the physical cores (8: 20.8 tokens/s
 *    against 18 at 12); prompt reading a little past them (12: 103 against
 *    97 at 8). llama.cpp takes the two separately (-t, -tb). Past 1.5x the
 *    cores, hyperthreads contend (16 threads: 66).
 *  - Batch and micro-batch sizes (256-2048) made no difference, so
 *    llama.cpp's defaults stand.
 * Being polite to the rest of the machine: the server runs at below-normal
 * priority (the supervisor sets it), so an editor or a build that wants a
 * core gets it first. On a machine with four cores or fewer one core is
 * also left out entirely: there, a model using every core leaves the
 * terminal visibly sluggish even at low priority, because llama.cpp's
 * workers spin between operations rather than yield. */

import { createServer } from 'node:net';
import { request } from 'node:http';
import type { Fit, Placement } from './choose.js';
import type { HardwareProfile } from './hardware.js';

export interface ThreadPlan { threads: number; threadsBatch: number }

export function threadPlan(hardware: Pick<HardwareProfile, 'physicalCores' | 'logicalCores'>): ThreadPlan {
  const reserve = hardware.physicalCores <= 4 && hardware.physicalCores > 1 ? 1 : 0;
  const threads = Math.max(1, hardware.physicalCores - reserve);
  const threadsBatch = Math.max(threads, Math.min(hardware.logicalCores - reserve, Math.floor(threads * 1.5)));
  return { threads, threadsBatch };
}

/** Whether llama-server maps the weights file (llama.cpp's default) or
 * reads it into its own memory (`--load-mode none`, what older builds
 * called --no-mmap).
 *
 * On the CPU it reads them. Mapped, the weights stay in page cache and
 * llama.cpp copies every tensor it repacks for its faster CPU kernels into
 * its own memory as well, so a large share of the model is held twice: a
 * 35B-A3B MoE with a 21.7 GB file held 15.2 GB of its own plus 20.5 GB of
 * mapped file, and gpt-oss 20B 11.8 + 10.8 GB for a 12.1 GB file. The
 * mapped copies of repacked tensors are never read again, but they count
 * as the model's resident memory, so the memory budget cannot tell them
 * from the pages it needs. Read into buffers instead, each tensor exists
 * once (repacked ones are converted as they load), the model's footprint is
 * simply its anonymous memory, and the page cache the read leaves behind is
 * ordinary reclaimable cache.
 *
 * On a GPU (discrete or unified) mapping stays: the weights live in VRAM,
 * or Metal shares the mapped pages with the GPU without a copy. */
export function usesMmap(placement: Placement): boolean {
  return placement !== 'cpu';
}

export interface ServerArgsInput {
  modelPath: string;
  projectorPath?: string;
  port: number;
  alias: string;
  fit: Pick<Fit, 'placement' | 'context' | 'cacheType' | 'parallel'>;
  threads: ThreadPlan;
  /** Per-device margin, MiB, for llama.cpp's --fit when layers are split. */
  fitTargetMib?: number;
  /** Prompt cache kept in RAM, MiB. llama.cpp's default is 8 GiB, which is
   * memory the budget never granted. */
  cacheRamMib: number;
  /** Where saved prompt prefixes live (prefix-cache.ts); omitted for
   * models that cannot use them. */
  slotSavePath?: string;
}

export function buildServerArgs(input: ServerArgsInput): string[] {
  const { fit } = input;
  const args = [
    '--host', '127.0.0.1', '--port', String(input.port),
    '-m', input.modelPath,
    '-a', input.alias,
    '-c', String(fit.context),
    '-np', String(fit.parallel),
    // One KV pool shared by the slots. Without it llama.cpp splits -c
    // evenly (-np 2 at 64K gave each slot 32K), and a conversation would
    // overflow at half the context this engine reports.
    '--kv-unified',
    '--jinja', '-fa', 'on',
    '-t', String(input.threads.threads), '-tb', String(input.threads.threadsBatch),
    '-ctk', fit.cacheType, '-ctv', fit.cacheType,
    '--cache-ram', String(input.cacheRamMib),
    '--no-webui',
  ];
  if (input.projectorPath) args.push('--mmproj', input.projectorPath);
  if (input.slotSavePath) args.push('--slot-save-path', input.slotSavePath);
  if (!usesMmap(fit.placement)) args.push('--load-mode', 'none');
  if (fit.placement === 'gpu') args.push('-ngl', 'all');
  else if (fit.placement === 'gpu-partial') args.push('-ngl', 'auto', '--fit', 'on', '--fit-target', String(input.fitTargetMib ?? 1024));
  else args.push('-ngl', '0');
  return args;
}

/** Ports other local AI services on this machine are known to hold; never
 * handed to llama-server even if they are free at the moment. */
const AVOIDED_PORTS = new Set([8080, 8091, 8092]);

/** A port the OS says is free right now. The window before llama-server
 * binds it is short, and a server that loses the race exits and is
 * restarted on another. */
export async function freePort(): Promise<number> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const port = await new Promise<number>((resolve, reject) => {
      const server = createServer();
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        const chosen = typeof address === 'object' && address ? address.port : 0;
        server.close(() => resolve(chosen));
      });
    });
    if (port && !AVOIDED_PORTS.has(port)) return port;
  }
  throw new Error('Could not find a free local port for the model server.');
}

export function httpJson(port: number, method: 'GET' | 'POST', path: string, body?: unknown, timeoutMs = 10_000): Promise<{ status: number; json?: unknown; text: string }> {
  return new Promise((resolve) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = request({
      host: '127.0.0.1', port, method, path, timeout: timeoutMs,
      headers: payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {},
    }, (res) => {
      let text = '';
      res.on('data', (chunk: Buffer) => { text += chunk.toString(); });
      res.on('end', () => {
        let json: unknown;
        try { json = JSON.parse(text); } catch { /* Not JSON. */ }
        resolve({ status: res.statusCode ?? 0, json, text });
      });
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve({ status: 0, text: '' }));
    if (payload) req.write(payload);
    req.end();
  });
}

/** Ready means /health answers 200: llama-server answers 503 while it is
 * still loading weights, which on a CPU takes from seconds (cached) to
 * minutes (a cold 20 GB file). `stillRunning` ends the wait early when the
 * server has exited. */
export async function waitForHealth(port: number, stillRunning: () => boolean, onWait: (seconds: number) => void, limitMs = 15 * 60_000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < limitMs) {
    const reply = await httpJson(port, 'GET', '/health', undefined, 5000);
    if (reply.status === 200) return;
    if (!stillRunning()) throw new Error('the model server exited while loading');
    onWait(Math.round((Date.now() - started) / 1000));
    await new Promise((done) => setTimeout(done, 1000));
  }
  throw new Error(`the model server did not become ready within ${Math.round(limitMs / 60_000)} minutes`);
}
