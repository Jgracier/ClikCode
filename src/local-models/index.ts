/** ClikCode Local: a model chosen for this machine, run by mainline
 * llama.cpp within a memory budget, and served on an OpenAI-compatible
 * endpoint for the agent loop.
 *
 *   ensureLocalModel   before each turn on a local model: starts it if it
 *                      is not running (downloading what is missing), and
 *                      holds it for the session. Cheap when it is running.
 *   releaseLocalModel  the session no longer uses a local model.
 *   localModelChoices  rows for a model picker, best first.
 *   releaseLocalModelsOnExit  once, at startup: this process's leases go
 *                      with it.
 *
 * A server outlives the call that started it and is shared: every session
 * on the same model uses one server, and it stops when the last ClikCode
 * process holding it exits, or after an idle period (see lifecycle.ts).
 * Callers therefore call ensureLocalModel before every turn, not once. */

import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { delimiter, dirname, join } from 'node:path';
import { memoryBudget, type MemoryBudget } from './budget.js';
import { LOCAL_MODEL_CATALOG, catalogModel, type CatalogModel } from './catalog.js';
import { chooseModel, fitModel, meetsBar, rankModels, type Measurement, type RankedModel } from './choose.js';
import { formatBytes } from './download.js';
import { probeHardware, type HardwareProfile } from './hardware.js';
import { buildServerArgs, freePort, httpJson, threadPlan, waitForHealth } from './launch.js';
import {
  processAlive, readServerRecord, removeAllOwnLeasesSync, removeLeases, serverDir, startSupervisor, stopServer, sweepOrphan,
  withStartLock, writeLease, type ServerRecord,
} from './lifecycle.js';
import { machineKey, measureServer, readMeasurements, writeMeasurement } from './measure.js';
import { ensureModelFile, missingBytes } from './models.js';
import { preferencesFile, serversDir } from './paths.js';
import { ensureRuntime, selectRuntimeBuild, type RuntimeBuild } from './runtime.js';

export { LOCAL_MODEL_CATALOG } from './catalog.js';
export type { CatalogModel } from './catalog.js';

export interface LocalModelProgress {
  stage: 'probe' | 'runtime' | 'download' | 'start' | 'measure';
  message: string;
  bytes?: number;
  totalBytes?: number;
}

export interface EnsureLocalModelOptions {
  /** The user's pick. Kept as their preference for later calls without
   * one; with none, the best model for this machine is chosen. */
  modelId?: string;
  sessionId: string;
  progress?: (update: LocalModelProgress) => void;
  /** Context window; the model's default (shrunk to fit) when omitted. */
  context?: number;
  /** Load the vision projector too. */
  vision?: boolean;
  /** Stop the server after this many minutes without a request; 0 keeps
   * it for as long as a session holds it. Default 15, or
   * CLIKCODE_LOCAL_IDLE_MINUTES. */
  idleMinutes?: number;
  signal?: AbortSignal;
}

export interface LocalModelEndpoint {
  /** OpenAI-compatible base URL, ending in /v1. */
  baseUrl: string;
  /** The model name to send in requests. */
  model: string;
  contextWindow: number;
  notice?: string;
}

const DEFAULT_IDLE_MINUTES = 15;

function idleMs(minutes: number | undefined): number {
  const configured = minutes ?? Number(process.env.CLIKCODE_LOCAL_IDLE_MINUTES ?? DEFAULT_IDLE_MINUTES);
  return Number.isFinite(configured) && configured > 0 ? configured * 60_000 : 0;
}

async function readPreference(): Promise<string | undefined> {
  try { return (JSON.parse(await readFile(preferencesFile(), 'utf8')) as { modelId?: string }).modelId; } catch { return undefined; }
}

/** Remember (or, with undefined, forget) the user's model pick. */
export async function setLocalModelPreference(modelId: string | undefined): Promise<void> {
  if (!modelId) { await rm(preferencesFile(), { force: true }); return; }
  if (!catalogModel(modelId)) throw new Error(`${modelId} is not a ClikCode Local model.`);
  await mkdir(dirname(preferencesFile()), { recursive: true });
  await writeFile(preferencesFile(), JSON.stringify({ modelId, at: new Date().toISOString() }));
}

interface MachineView {
  hardware: HardwareProfile;
  budget: MemoryBudget;
  build: RuntimeBuild;
  machine: string;
  measurements: Record<string, Measurement>;
}

async function viewMachine(): Promise<MachineView> {
  const hardware = await probeHardware();
  const budget = memoryBudget(hardware);
  const build = selectRuntimeBuild(hardware, budget.gpu);
  if (!build) throw new Error(`llama.cpp publishes no build for ${hardware.platform} ${hardware.arch}.`);
  // The GPU budget only counts if the runtime drives that GPU.
  const effective = budget.gpu && build.backend !== budget.gpu.backend ? { ...budget, gpu: undefined } : budget;
  const machine = machineKey(hardware, build.key);
  return { hardware, budget: effective, build, machine, measurements: await readMeasurements(machine) };
}

/** A running, answering server for this model, if there is one. */
async function liveServer(modelId: string): Promise<ServerRecord | undefined> {
  const record = await readServerRecord(modelId);
  if (!record || !processAlive(record.supervisorPid) || !processAlive(record.serverPid)) return undefined;
  return record;
}

async function runningModels(): Promise<ServerRecord[]> {
  const records: ServerRecord[] = [];
  for (const name of await readdir(serversDir()).catch(() => [] as string[])) {
    const model = LOCAL_MODEL_CATALOG.find((item) => item.id === name);
    const record = model ? await liveServer(model.id) : undefined;
    if (record) records.push(record);
  }
  return records;
}

function logTail(modelId: string): Promise<string> {
  return readFile(join(serverDir(modelId), 'server.log'), 'utf8')
    .then((text) => text.trim().split(/\r?\n/).slice(-8).join('\n'), () => '');
}

function describe(model: CatalogModel, measured: Measurement | undefined): string | undefined {
  if (!measured) return undefined;
  const notes: string[] = [];
  if (!measured.toolCalls) notes.push(`${model.label} did not make a tool call when asked, so tools may not work with it.`);
  if (!meetsBar(measured)) {
    notes.push(`On this machine ${model.label} reads about ${Math.round(measured.promptPerSecond ?? 0)} tokens/s and writes `
      + `${Math.round(measured.generatePerSecond ?? 0)}; replies will be slow.`);
  }
  return notes.length ? notes.join(' ') : undefined;
}

export async function ensureLocalModel(options: EnsureLocalModelOptions): Promise<LocalModelEndpoint> {
  const progress = options.progress ?? (() => {});
  if (options.modelId) await setLocalModelPreference(options.modelId);
  const pick = options.modelId ?? await readPreference();

  // Already running: joined as it is, with no probe and no fit check (its
  // own memory would count against it). With no pick, any running catalog
  // model is used rather than loading a second one beside it.
  const running = pick ? [await liveServer(pick)].filter((record): record is ServerRecord => Boolean(record)) : await runningModels();
  const joinable = running.sort((left, right) => (catalogModel(right.modelId)?.quality ?? 0) - (catalogModel(left.modelId)?.quality ?? 0))[0];
  if (joinable && (await httpJson(joinable.port, 'GET', '/health', undefined, 3000)).status === 200) {
    await writeLease(joinable.modelId, options.sessionId);
    await removeLeases(options.sessionId, joinable.modelId);
    return { baseUrl: `http://127.0.0.1:${joinable.port}/v1`, model: joinable.alias, contextWindow: joinable.context };
  }

  progress({ stage: 'probe', message: 'checking this machine…' });
  const view = await viewMachine();
  const ranked = rankModels(LOCAL_MODEL_CATALOG, view.hardware, view.budget, view.measurements);
  const choice = chooseModel(ranked, pick);
  const model = choice.row.model;

  const record = await withStartLock(model.id, async () => {
    // Another process may have started it while this one waited.
    const started = await liveServer(model.id);
    if (started) {
      await writeLease(model.id, options.sessionId);
      return started;
    }
    await sweepOrphan(model.id);
    const fit = fitModel(model, view.budget, { ...(options.context ? { context: options.context } : {}), vision: Boolean(options.vision) });
    if (!fit.fits) throw new Error(`${model.label} would exceed the memory this machine can spare: ${fit.reason}.`);

    const runtime = await ensureRuntime(view.build, (update) => progress({ stage: 'runtime', ...update }));
    const modelPath = await ensureModelFile(model.weights, (update) => progress({ stage: 'download', ...update }), options.signal);
    const projectorPath = options.vision && model.projector
      ? await ensureModelFile(model.projector, (update) => progress({ stage: 'download', ...update }), options.signal) : undefined;

    // The lease exists before the supervisor does: it exits as soon as it
    // finds none.
    await writeLease(model.id, options.sessionId);
    try {
      const port = await freePort();
      const ramPart = fit.needBytes - fit.gpuBytes;
      const cacheRamMib = Math.max(0, Math.min(2048, Math.floor((view.budget.ramBytes - ramPart) / 1024 ** 2)));
      const args = buildServerArgs({
        modelPath, ...(projectorPath ? { projectorPath } : {}), port, alias: model.id, fit,
        threads: threadPlan(view.hardware), cacheRamMib,
        ...(view.budget.gpu ? { fitTargetMib: view.budget.gpu.fitTargetMib } : {}),
      });
      const libraryVariable = process.platform === 'win32' ? 'PATH' : process.platform === 'darwin' ? 'DYLD_LIBRARY_PATH' : 'LD_LIBRARY_PATH';
      progress({ stage: 'start', message: `starting ${model.label}…` });
      const started = await startSupervisor({
        modelId: model.id, alias: model.id, context: fit.context, port,
        command: runtime.serverPath, args,
        env: { [libraryVariable]: [runtime.directory, process.env[libraryVariable] ?? ''].filter(Boolean).join(delimiter) },
        dir: serverDir(model.id), idleMs: idleMs(options.idleMinutes), pollMs: 2000,
      });
      await waitForHealth(port, () => processAlive(started.supervisorPid),
        (seconds) => progress({ stage: 'start', message: `loading ${model.label}… ${seconds}s` }));
      return started;
    } catch (error) {
      await removeLeases(options.sessionId);
      await stopServer(model.id);
      const tail = await logTail(model.id);
      throw new Error(`${model.label} did not start: ${(error as Error).message}${tail ? `\n${tail}` : ''}`);
    }
  });
  await removeLeases(options.sessionId, model.id);
  // One started by another process may still be loading.
  await waitForHealth(record.port, () => processAlive(record.supervisorPid),
    (seconds) => progress({ stage: 'start', message: `loading ${model.label}… ${seconds}s` }));

  let measured = view.measurements[model.id];
  if (!measured) {
    progress({ stage: 'measure', message: `measuring ${model.label} on this machine…` });
    measured = await measureServer(record.port, record.alias);
    await writeMeasurement(view.machine, model.id, measured);
  }
  const notice = [choice.notice, describe(model, measured)].filter(Boolean).join(' ') || undefined;
  return {
    baseUrl: `http://127.0.0.1:${record.port}/v1`, model: record.alias, contextWindow: record.context,
    ...(notice ? { notice } : {}),
  };
}

/** The session no longer uses a local model. Its server stops once no
 * other session holds it. */
export async function releaseLocalModel(sessionId: string): Promise<void> {
  await removeLeases(sessionId);
}

/** Stop a model's server now, whatever holds it. */
export async function stopLocalModel(modelId: string): Promise<void> {
  await stopServer(modelId);
}

/** Call once at startup: every lease this process holds is removed as it
 * exits. The supervisor would notice the dead process anyway; this makes
 * it immediate. */
export function releaseLocalModelsOnExit(): void {
  process.once('exit', removeAllOwnLeasesSync);
}

export interface LocalModelChoice {
  id: string;
  label: string;
  detail: string;
  fits: boolean;
  /** Passes the speed bar (measured, or estimated where not yet run). */
  recommended: boolean;
  downloadBytes: number;
}

function placementLabel(row: RankedModel, view: MachineView): string {
  const gpu = view.budget.gpu?.backend.toUpperCase();
  return row.fit.placement === 'cpu' ? 'CPU' : row.fit.placement === 'gpu' ? gpu ?? 'GPU' : `${gpu ?? 'GPU'}+CPU`;
}

/** Catalog rows for this machine, in the order they should be offered:
 * what fits and is fast enough first (best first), then slow, then what
 * does not fit and why. */
export async function localModelChoices(): Promise<LocalModelChoice[]> {
  const view = await viewMachine();
  const rows: LocalModelChoice[] = [];
  for (const row of rankModels(LOCAL_MODEL_CATALOG, view.hardware, view.budget, view.measurements)) {
    const downloadBytes = await missingBytes([row.model.weights]);
    const speed = row.measured?.promptPerSecond
      ? `measured ${Math.round(row.speed.promptPerSecond)} tok/s reading, ${Math.round(row.speed.generatePerSecond)} writing${row.measured.toolCalls ? '' : ', no tool calls'}`
      : `about ${Math.round(row.speed.promptPerSecond)} tok/s reading, ${Math.round(row.speed.generatePerSecond)} writing (estimate)`;
    const parts = row.fit.fits
      ? [placementLabel(row, view), speed, `${Math.round(row.fit.context / 1024)}K context`]
      : [`does not fit: ${row.fit.reason}`];
    parts.push(downloadBytes ? `${formatBytes(downloadBytes)} download` : 'downloaded');
    rows.push({ id: row.model.id, label: row.model.label, detail: parts.join(' · '), fits: row.fit.fits, recommended: row.passes, downloadBytes });
  }
  return rows;
}
