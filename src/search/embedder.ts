/** Text to vectors for conversation search, on this machine.
 *
 * bge-small-en-v1.5 (Q8_0 GGUF, 36.7 MB, 384 dimensions), served by the
 * llama.cpp runtime ClikCode Local already pins (local-models/runtime.ts) as
 * `llama-server --embedding`: no npm dependency, no native addon, nothing
 * sent anywhere. One server for the machine, under the same supervisor as a
 * local model (local-models/supervisor.ts): it stops after IDLE_MS without a
 * request, or once no live ClikCode process holds a lease on it.
 *
 * Everything here is optional. The model and runtime arrive on first use,
 * in the background; until the server answers, and whenever it fails,
 * callers get no embedder and search is lexical only. A failed start is not
 * retried for RETRY_AFTER_MS. CLIKCODE_EMBEDDINGS=0 turns it off; a test
 * process (VITEST) never starts it, and uses setEmbedderForTests. */

import { existsSync } from 'node:fs';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { cpus } from 'node:os';
import { delimiter, join } from 'node:path';
import { downloadVerified } from '../local-models/download.js';
import { freePort, httpJson, waitForHealth } from '../local-models/launch.js';
import { readServerRecord, serverDir, startSupervisor, sweepOrphan, withDownloadLock, withStartLock, writeLease } from '../local-models/lifecycle.js';
import { modelsDir } from '../local-models/paths.js';
import { ensureRuntime, selectRuntimeBuild } from '../local-models/runtime.js';
import { pidIsAlive } from '../session/store/locks.js';

export interface Embedder {
  /** Names the model and its settings: vectors from different ids never mix. */
  id: string;
  dims: number;
  /** One unit vector per text. A query is phrased for retrieval; a passage is stored text. */
  embed(texts: readonly string[], kind: 'query' | 'passage'): Promise<Float32Array[]>;
}

const MODEL = {
  id: 'bge-small-en-v1.5-q8',
  url: 'https://huggingface.co/ggml-org/bge-small-en-v1.5-Q8_0-GGUF/resolve/main/bge-small-en-v1.5-q8_0.gguf',
  file: 'bge-small-en-v1.5-q8_0.gguf',
  sizeBytes: 36_685_152,
  sha256: 'f046db1dc724cf4f6f0a0c5917e922823b73eb1d27b8f9a9c2797f7866974804',
  dims: 384,
  /** bge's retrieval instruction, for queries only. */
  queryPrefix: 'Represent this sentence for searching relevant passages: ',
} as const;

/** The supervisor's name for it (local-models/lifecycle.ts serverDir). */
const SERVER_ID = 'clikcode-embeddings';
const IDLE_MS = 10 * 60_000;
const RETRY_AFTER_MS = 6 * 60 * 60_000;
const START_LIMIT_MS = 60_000;
/** Texts per request; each is at most a chunk (vectors.ts). */
const BATCH = 16;
/** bge reads 512 tokens. One slot each for this many requests at once. */
const SLOT_TOKENS = 512;
const SLOTS = 2;

let injected: Embedder | null | undefined;
/** Tests only: the embedder to use (null: none). */
export function setEmbedderForTests(embedder: Embedder | null | undefined): void { injected = embedder; }

const failedFile = (): string => join(serverDir(SERVER_ID), 'failed.json');

function disabled(): boolean {
  return process.env.CLIKCODE_EMBEDDINGS === '0' || Boolean(process.env.VITEST);
}

class ServerEmbedder implements Embedder {
  readonly id = MODEL.id;
  readonly dims = MODEL.dims;
  constructor(private readonly port: number) {}

  async embed(texts: readonly string[], kind: 'query' | 'passage'): Promise<Float32Array[]> {
    const out: Float32Array[] = [];
    for (let start = 0; start < texts.length; start += BATCH) {
      const batch = texts.slice(start, start + BATCH).map((text) => (kind === 'query' ? MODEL.queryPrefix : '') + text);
      out.push(...await this.request(batch));
    }
    return out;
  }

  /** One request; a text over the model's window is halved until it fits. */
  private async request(inputs: string[]): Promise<Float32Array[]> {
    const reply = await httpJson(this.port, 'POST', '/v1/embeddings', { input: inputs, model: MODEL.id }, 60_000);
    const data = (reply.json as { data?: { index: number; embedding: number[] }[] } | undefined)?.data;
    if (reply.status === 200 && data?.length === inputs.length) {
      return [...data].sort((left, right) => left.index - right.index).map((item) => Float32Array.from(item.embedding));
    }
    if (reply.status === 0) throw new Error('the embedding server did not answer');
    if (inputs.length > 1) {
      const each: Float32Array[] = [];
      for (const input of inputs) each.push(...await this.request([input]));
      return each;
    }
    const only = inputs[0]!;
    if (only.length < 64) throw new Error(`the embedding server refused a text (HTTP ${reply.status}): ${reply.text.slice(0, 200)}`);
    return this.request([only.slice(0, Math.floor(only.length / 2))]);
  }
}

async function runningPort(): Promise<number | undefined> {
  const record = await readServerRecord(SERVER_ID);
  if (!record || record.restarting || !pidIsAlive(record.supervisorPid)) return undefined;
  return (await httpJson(record.port, 'GET', '/health', undefined, 2000)).status === 200 ? record.port : undefined;
}

async function recentFailure(): Promise<boolean> {
  const failed = await readFile(failedFile(), 'utf8').then((text) => JSON.parse(text) as { at?: number }, () => undefined);
  return typeof failed?.at === 'number' && Date.now() - failed.at < RETRY_AFTER_MS;
}

/** Fetch what is missing and start the server, once across processes. */
async function start(): Promise<number> {
  const build = selectRuntimeBuild({ platform: process.platform, arch: process.arch }, undefined);
  if (!build) throw new Error(`no llama.cpp build for ${process.platform}-${process.arch}`);
  const modelPath = join(modelsDir(), MODEL.file);
  if (!existsSync(modelPath)) {
    await withDownloadLock(SERVER_ID, () => downloadVerified({ url: MODEL.url, destination: modelPath, sizeBytes: MODEL.sizeBytes, sha256: MODEL.sha256 }));
  }
  const runtime = await ensureRuntime(build);
  return withStartLock(SERVER_ID, async () => {
    const already = await runningPort();
    if (already) return already;
    await sweepOrphan(SERVER_ID);
    const port = await freePort();
    const threads = Math.max(1, Math.min(4, Math.floor(cpus().length / 4)));
    const library = process.platform === 'win32' ? 'PATH' : process.platform === 'darwin' ? 'DYLD_LIBRARY_PATH' : 'LD_LIBRARY_PATH';
    const record = await startSupervisor({
      modelId: SERVER_ID, alias: MODEL.id, context: SLOT_TOKENS * SLOTS, port,
      command: runtime.serverPath,
      args: [
        '-m', modelPath, '--embedding', '--pooling', 'cls', '--host', '127.0.0.1', '--port', String(port),
        '-c', String(SLOT_TOKENS * SLOTS), '-np', String(SLOTS), '-b', String(SLOT_TOKENS * SLOTS), '-ub', String(SLOT_TOKENS),
        '-t', String(threads), '-ngl', '0', '--no-webui', '--log-disable',
      ],
      env: { [library]: [runtime.directory, process.env[library] ?? ''].filter(Boolean).join(delimiter) },
      dir: serverDir(SERVER_ID), idleMs: IDLE_MS, pollMs: 5000,
    });
    await waitForHealth(record.port, () => pidIsAlive(record.supervisorPid), () => undefined, START_LIMIT_MS);
    return record.port;
  });
}

let preparing: Promise<Embedder | undefined> | undefined;

async function prepare(): Promise<Embedder | undefined> {
  try {
    const port = await runningPort() ?? (await recentFailure() ? undefined : await start());
    if (port === undefined) return undefined;
    // This process holds it while it lives; the supervisor stops it once none does.
    await writeLease(SERVER_ID, 'search');
    await rm(failedFile(), { force: true });
    return new ServerEmbedder(port);
  } catch (error) {
    await writeFile(failedFile(), JSON.stringify({ at: Date.now(), reason: error instanceof Error ? error.message : String(error) })).catch(() => undefined);
    return undefined;
  }
}

/** The embedder if it is ready within `waitMs`; otherwise undefined, while
 * it goes on getting ready in the background for the next call. A server
 * that stopped since (idle, or gone) is looked for again. */
export async function embedderWithin(waitMs: number): Promise<Embedder | undefined> {
  if (injected !== undefined) return injected ?? undefined;
  if (disabled()) return undefined;
  if (preparing) {
    const settled = await Promise.race([preparing, new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), 0))]);
    if (settled instanceof ServerEmbedder && await runningPort() === undefined) preparing = undefined;
    else if (settled === undefined && !(await recentFailure())) preparing = undefined;
  }
  preparing ??= prepare();
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<undefined>((resolve) => { timer = setTimeout(() => resolve(undefined), waitMs); timer.unref(); });
  try { return await Promise.race([preparing, late]); } finally { clearTimeout(timer); }
}
