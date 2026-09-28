/** ClikCode Local: a model chosen for this machine, run by mainline
 * llama.cpp within a memory budget, and served on an OpenAI-compatible
 * endpoint for the agent loop.
 *
 *   ensureLocalModel   before each turn on a local model: starts it if it
 *                      is not running (downloads require an explicit choice), and
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
import { LOCAL_MODEL_CATALOG, allLocalModels, catalogModel, type CatalogModel } from './catalog.js';
import { chooseModel, fitModel, kvCacheBytes, meetsBar, rankModels, MIN_CONTEXT, type Fit, type Footprint, type Measurement, type RankedModel } from './choose.js';
import { formatBytes } from './download.js';
import { discoverHuggingFaceModels } from './discover.js';
import { probeHardware, type HardwareProfile } from './hardware.js';
import { buildServerArgs, freePort, httpJson, threadPlan, usesMmap, waitForHealth } from './launch.js';
import {
  memoryStopFile, processAlive, readServerRecord, removeAllOwnLeasesSync, removeLeases, serverDir, sessionHeldElsewhere, startSupervisor, stopServer,
  sweepOrphan, withStartLock, writeLease, type MemoryEvent, type ServerRecord, type ShrinkStep,
} from './lifecycle.js';
import { footprintKey, latestMeasurement, machineKey, measureServer, readFootprints, readMeasurements, writeMeasurement } from './measure.js';
import { ensureModelFile, missingBytes } from './models.js';
import { footprintsFile, preferencesFile, serversDir } from './paths.js';
import { ensureRuntime, selectRuntimeBuild, type RuntimeBuild } from './runtime.js';
import { prefixCacheDir } from './prefix-cache.js';

export { LOCAL_MODEL_CATALOG, localModelLabel, resolveLocalModelId } from './catalog.js';
export { prefixCacheFor } from './prefix-cache.js';
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
  /** Set only by a user action that has shown and accepted the download size. */
  allowDownload?: boolean;
}

export interface LocalModelEndpoint {
  /** OpenAI-compatible base URL, ending in /v1. */
  baseUrl: string;
  /** The model name to send in requests. */
  model: string;
  contextWindow: number;
  /** Measured prompt reading speed, tokens/s: the agent's context profile
   * depends on it. Both the start and the join path read the same stored
   * measurement, so every turn of a session sees the same number. */
  promptPerSecond?: number;
  /** Where the server saves prompt prefixes, when it was started to
   * (prefix-cache.ts). */
  prefixCacheDir?: string;
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
  footprints: Record<string, Footprint[]>;
}

async function viewMachine(): Promise<MachineView> {
  const hardware = await probeHardware();
  const budget = memoryBudget(hardware);
  const build = selectRuntimeBuild(hardware, budget.gpu);
  if (!build) throw new Error(`llama.cpp publishes no build for ${hardware.platform} ${hardware.arch}.`);
  // The GPU budget only counts if the runtime drives that GPU.
  const effective = budget.gpu && build.backend !== budget.gpu.backend ? { ...budget, gpu: undefined } : budget;
  const machine = machineKey(hardware, build.key);
  return {
    hardware, budget: effective, build, machine, measurements: await readMeasurements(machine),
    footprints: await readFootprints(machine, allLocalModels().map((model) => model.id)),
  };
}

/** A running server for this model, if there is one: its process is
 * alive, or its supervisor is restarting it (smaller, to give memory back),
 * which a caller waits for rather than starting a second one beside it. */
async function liveServer(modelId: string): Promise<ServerRecord | undefined> {
  const record = await readServerRecord(modelId);
  if (!record || !processAlive(record.supervisorPid)) return undefined;
  if (!record.restarting && !processAlive(record.serverPid)) return undefined;
  return record;
}

async function runningModels(): Promise<ServerRecord[]> {
  const records: ServerRecord[] = [];
  for (const name of await readdir(serversDir()).catch(() => [] as string[])) {
    const model = allLocalModels().find((item) => item.id === name);
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
    notes.push(`Near empty context ${model.label} reads about ${Math.round(measured.promptPerSecond ?? 0)} tokens/s and writes `
      + `${Math.round(measured.generatePerSecond ?? 0)}; replies will be slow.`);
  }
  return notes.length ? notes.join(' ') : undefined;
}

function contextLabel(tokens: number): string {
  return `${Math.round(tokens / 1024)}K`;
}

/** The supervisor's note of a restart it made to give memory back, as the
 * user reads it. */
function shrinkNotice(event: MemoryEvent | undefined): string | undefined {
  if (event?.action !== 'shrink' || !event.toContext) return undefined;
  const label = catalogModel(event.modelId)?.label ?? event.modelId;
  return `${label} was restarted at ${contextLabel(event.toContext)} context (from ${contextLabel(event.fromContext)}) to leave memory for other programs: ${event.reason}.`;
}

/** Stops the supervisors made to leave memory for other programs, oldest
 * first, each reported once: read and removed. */
async function takeMemoryStops(): Promise<MemoryEvent[]> {
  const events: MemoryEvent[] = [];
  for (const model of allLocalModels()) {
    const file = memoryStopFile(model.id);
    const event = await readFile(file, 'utf8').then((text) => JSON.parse(text) as MemoryEvent, () => undefined);
    if (!event) continue;
    await rm(file, { force: true });
    events.push(event);
  }
  return events.sort((left, right) => left.at.localeCompare(right.at));
}

function stopNotice(stops: readonly MemoryEvent[], chosen: CatalogModel, fit: Pick<Fit, 'context'> | undefined): string | undefined {
  const last = stops.at(-1);
  if (!last) return undefined;
  const label = catalogModel(last.modelId)?.label ?? last.modelId;
  const when = new Date(last.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const stopped = `${label} was stopped at ${when} to leave memory for other programs (${last.reason}).`;
  if (!fit) return stopped;
  if (last.modelId === chosen.id) return `${stopped} Restarted with ${contextLabel(fit.context)} context, which fits what is free now.`;
  return `${stopped} Chose ${chosen.label} at ${contextLabel(fit.context)} context because it fits what is free now.`;
}

/** The restarts the supervisor may make to give memory back, least
 * drastic first: the same context without the prompt cache, then each
 * halving down to MIN_CONTEXT, all without it. A step that would free
 * nothing is left out. */
function shrinkSteps(model: CatalogModel, fit: Fit, cacheRamMib: number, vision: boolean, args: (context: number, cacheRamMib: number) => string[]): ShrinkStep[] {
  const steps: ShrinkStep[] = [];
  const step = (context: number): ShrinkStep => ({
    context, cacheRamMib: 0, kvBytes: kvCacheBytes(model.kv, context, fit.cacheType, fit.parallel), args: args(context, 0),
    footprintKey: footprintKey({ context, cacheType: fit.cacheType, parallel: fit.parallel, vision }),
  });
  if (cacheRamMib > 0) steps.push(step(fit.context));
  for (let context = Math.floor(fit.context / 2); context >= MIN_CONTEXT; context = Math.floor(context / 2)) steps.push(step(context));
  return steps;
}

export async function ensureLocalModel(options: EnsureLocalModelOptions): Promise<LocalModelEndpoint> {
  const progress = options.progress ?? (() => {});
  if (options.modelId) await setLocalModelPreference(options.modelId);
  const pick = options.modelId ?? await readPreference();

  // Already running: joined as it is, with no probe and no fit check (its
  // own memory would count against it). With no pick, any running catalog
  // model is used rather than loading a second one beside it. A session
  // another live process already holds (the terminal, for its turn worker)
  // is joined without a lease of this process's own: the model follows the
  // process that took it.
  const running = pick ? [await liveServer(pick)].filter((record): record is ServerRecord => Boolean(record)) : await runningModels();
  let joinable: ServerRecord | undefined = running.sort((left, right) => (catalogModel(right.modelId)?.quality ?? 0) - (catalogModel(left.modelId)?.quality ?? 0))[0];
  let healthy = Boolean(joinable) && (await httpJson(joinable!.port, 'GET', '/health', undefined, 3000)).status === 200;
  if (joinable && !healthy && joinable.restarting) {
    // Restarting smaller to give memory back: waited for, not fitted anew
    // -- the fit would count the memory its own restart is about to take.
    const restarting = joinable;
    const label = catalogModel(restarting.modelId)?.label ?? restarting.modelId;
    healthy = await waitForHealth(restarting.port, () => processAlive(restarting.supervisorPid),
      (seconds) => progress({ stage: 'start', message: `${label} is restarting smaller to leave memory for other programs… ${seconds}s` }))
      .then(() => true, () => false);
    joinable = await liveServer(restarting.modelId);
  }
  if (joinable && healthy) {
    if (!await sessionHeldElsewhere(joinable.modelId, options.sessionId)) await writeLease(joinable.modelId, options.sessionId);
    await removeLeases(options.sessionId, joinable.modelId);
    const notice = shrinkNotice(joinable.memoryEvent);
    const speed = (await latestMeasurement(joinable.modelId))?.promptPerSecond;
    const prefixDir = await slotSavePath(joinable.modelId);
    return {
      baseUrl: `http://127.0.0.1:${joinable.port}/v1`, model: joinable.alias, contextWindow: joinable.context,
      ...(speed ? { promptPerSecond: speed } : {}), ...(prefixDir ? { prefixCacheDir: prefixDir } : {}), ...(notice ? { notice } : {}),
    };
  }

  // A server of this model that is shutting down (its last run just ended
  // and it did not answer) still holds its memory: fitting now would count
  // it against the new start. Wait for it to go.
  if (joinable && !healthy) {
    const leaving = joinable;
    const label = catalogModel(leaving.modelId)?.label ?? leaving.modelId;
    const deadline = Date.now() + 60_000;
    while (processAlive(leaving.supervisorPid) && Date.now() < deadline) {
      progress({ stage: 'start', message: `waiting for the previous ${label} to finish stopping…` });
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  progress({ stage: 'probe', message: 'checking this machine…' });
  const view = await viewMachine();
  const stops = await takeMemoryStops();
  const ranked = rankModels(allLocalModels(), view.hardware, view.budget, view.measurements, view.footprints);
  const eligible = pick ? ranked : (await Promise.all(ranked.map(async (row) => ({ row, bytes: await missingBytes([row.model.weights]) }))))
    .filter(({ bytes }) => bytes === 0).map(({ row }) => row);
  let choice: ReturnType<typeof chooseModel>;
  try { choice = chooseModel(eligible, pick); } catch (error) {
    const stopped = ranked[0] ? stopNotice(stops, ranked[0].model, undefined) : undefined;
    if (!pick && !eligible.length) throw new Error('Choose a ClikCode Local model with /model before its first download.');
    throw stopped ? new Error(`${stopped} ${(error as Error).message}`) : error;
  }
  const model = choice.row.model;
  let startedFit: Fit | undefined;

  const record = await withStartLock(model.id, async () => {
    // Another process may have started it while this one waited.
    const started = await liveServer(model.id);
    if (started) {
      await writeLease(model.id, options.sessionId);
      return started;
    }
    await sweepOrphan(model.id);
    const vision = Boolean(options.vision && model.projector);
    const fit = !options.context && !vision ? choice.row.fit : fitModel(model, view.budget, {
      ...(options.context ? { context: options.context } : { context: choice.row.fit.context }),
      vision, footprints: view.footprints[model.id] ?? [],
    });
    if (!fit.fits) throw new Error(`${model.label} would exceed the memory this machine can spare: ${fit.reason}.`);
    startedFit = fit;

    if (!options.allowDownload && await missingBytes([model.weights])) {
      throw new Error(`${model.label} is not downloaded. Open /model and confirm its download first.`);
    }
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
      // Sliding-window models cannot resume from a saved state (prefix-cache.ts).
      const prefixDir = model.kv.sliding ? undefined : prefixCacheDir(serverDir(model.id), fit.cacheType);
      if (prefixDir) await mkdir(prefixDir, { recursive: true });
      const argsFor = (context: number, cacheRam: number): string[] => buildServerArgs({
        modelPath, ...(projectorPath ? { projectorPath } : {}), port, alias: model.id, fit: { ...fit, context },
        threads: threadPlan(view.hardware), cacheRamMib: cacheRam, ...(prefixDir ? { slotSavePath: prefixDir } : {}),
        ...(view.budget.gpu ? { fitTargetMib: view.budget.gpu.fitTargetMib } : {}),
      });
      const args = argsFor(fit.context, cacheRamMib);
      // Watched only on the CPU: a model on a discrete card holds VRAM,
      // which neither MemAvailable nor its RSS shows, and restarting it
      // smaller would free card memory other programs are not short of.
      const watched = fit.placement === 'cpu' || Boolean(view.budget.gpu?.unified);
      const libraryVariable = process.platform === 'win32' ? 'PATH' : process.platform === 'darwin' ? 'DYLD_LIBRARY_PATH' : 'LD_LIBRARY_PATH';
      progress({ stage: 'start', message: `starting ${model.label}…` });
      const started = await startSupervisor({
        modelId: model.id, alias: model.id, context: fit.context, port,
        command: runtime.serverPath, args,
        env: { [libraryVariable]: [runtime.directory, process.env[libraryVariable] ?? ''].filter(Boolean).join(delimiter) },
        dir: serverDir(model.id), idleMs: idleMs(options.idleMinutes), pollMs: 2000,
        ...(watched ? {
          memory: {
            bufferBytes: view.budget.bufferBytes, sampleMs: 2000, footprintsFile: footprintsFile(model.id), machine: view.machine,
            cacheType: fit.cacheType, parallel: fit.parallel, vision, mmap: usesMmap(fit.placement),
            current: {
              context: fit.context, cacheRamMib, kvBytes: kvCacheBytes(model.kv, fit.context, fit.cacheType, fit.parallel),
              footprintKey: footprintKey({ context: fit.context, cacheType: fit.cacheType, parallel: fit.parallel, vision }),
            },
            shrinks: shrinkSteps(model, fit, cacheRamMib, vision, argsFor),
          },
        } : {}),
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
  const notice = [stopNotice(stops, model, startedFit ?? { context: record.context }), choice.notice, describe(model, measured)]
    .filter(Boolean).join(' ') || undefined;
  const speed = (await latestMeasurement(model.id))?.promptPerSecond;
  const prefixDir = await slotSavePath(model.id);
  return {
    baseUrl: `http://127.0.0.1:${record.port}/v1`, model: record.alias, contextWindow: record.context,
    ...(speed ? { promptPerSecond: speed } : {}), ...(prefixDir ? { prefixCacheDir: prefixDir } : {}), ...(notice ? { notice } : {}),
  };
}

/** The --slot-save-path a model's server was started with: read from its
 * launch config, so a server an older ClikCode started (without one) is
 * joined without prefix caching. */
async function slotSavePath(modelId: string): Promise<string | undefined> {
  try {
    const args = (JSON.parse(await readFile(join(serverDir(modelId), 'supervisor-config.json'), 'utf8')) as { args?: unknown }).args;
    if (!Array.isArray(args)) return undefined;
    const at = args.indexOf('--slot-save-path');
    return at >= 0 && typeof args[at + 1] === 'string' ? args[at + 1] as string : undefined;
  } catch { return undefined; }
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

let exitHookInstalled = false;

/** Call once at startup: every lease this process holds is removed as it
 * exits. The supervisor would notice the dead process anyway; this makes
 * it immediate. */
export function releaseLocalModelsOnExit(): void {
  // Idempotent, so every entry point that may take a lease can call it
  // without stacking one exit listener per call.
  if (exitHookInstalled) return;
  exitHookInstalled = true;
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

/** Pinned catalog and remote-header rows, filtered to models that fit memory.
 * Deep-conversation speed decides which are recommended and their order. */
export async function localModelChoices(): Promise<LocalModelChoice[]> {
  const initial = await viewMachine();
  await discoverHuggingFaceModels(initial.budget.ramBytes + (initial.budget.gpu?.bytes ?? 0));
  const view = await viewMachine();
  const rows: LocalModelChoice[] = [];
  for (const row of rankModels(allLocalModels(), view.hardware, view.budget, view.measurements, view.footprints)) {
    if (!row.fit.fits) continue;
    const downloadBytes = await missingBytes([row.model.weights]);
    const basis = row.fit.placement === 'cpu' ? 'estimated at 80% context' : 'short-context estimate; deep GPU speed unverified';
    const speed = row.measured?.promptPerSecond
      ? `${basis}: ${Math.round(row.speed.promptPerSecond)} tok/s reading, ${Math.round(row.speed.generatePerSecond)} writing (calibrated after a short run)${row.measured.toolCalls ? '' : ', no tool calls'}`
      : `${basis}: ${Math.round(row.speed.promptPerSecond)} tok/s reading, ${Math.round(row.speed.generatePerSecond)} writing`;
    const parts = [placementLabel(row, view), speed, `${Math.round(row.fit.context / 1024)}K context`,
      ...(row.model.discovered ? [`Hugging Face ${row.model.weights.repo}`, 'tool use unverified'] : [])];
    parts.push(downloadBytes ? `${formatBytes(downloadBytes)} download` : 'downloaded');
    rows.push({ id: row.model.id, label: row.model.label, detail: parts.join(' · '), fits: row.fit.fits, recommended: row.passes, downloadBytes });
  }
  return rows;
}
