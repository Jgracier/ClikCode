/** Models fine-tuned on this computer: a GGUF this user made, registered so ClikCode Local runs it like any other model.
 *
 * A model is pinned by repo, revision, size and SHA-256 (catalog-schema.ts). A tuned model has no Hugging Face repo, so it is pinned the
 * same way by what it is: the repo is `clikcode-tuned/<name>`, the revision the first 40 hex digits of its SHA-256, and the file is placed
 * where the store looks for it (models.ts modelFilePath), so it is found already downloaded and never fetched. Its size, memory and
 * context come from its own GGUF header, by the same reading a discovered Hugging Face model gets (discover.ts remoteModelFromHeader).
 * The record is `tuned-models.json`; catalog.ts reads it with the built-in and discovered models. */

import { copyFile, link, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { quiet } from '../runtime/lifecycle-log.js';
import { basename, dirname } from 'node:path';
import { remoteModelFromHeader } from './discover.js';
import { sha256File } from './download.js';
import { modelFilePath } from './models.js';
import { tunedModelsFile } from './paths.js';
import { TUNED_ID_PREFIX, TUNED_REPO_PREFIX, type CatalogModel } from './catalog.js';

type Header = Awaited<ReturnType<typeof import('@huggingface/gguf').gguf>>;

const NAME = /^[a-z0-9][a-z0-9._-]{0,39}$/;

export interface RegisterTunedInput {
  /** What the user calls it: lower-case letters, digits, dot, dash, underscore. */
  name: string;
  /** The GGUF the fine-tune made. */
  ggufPath: string;
  /** The base model's license: the catalog takes only these. */
  license?: CatalogModel['license'];
  /** The rank it is given among models that meet the speed bar; defaults below the built-ins, since it has not been checked. */
  quality?: number;
}

export interface TunedDeps {
  readHeader?: (path: string) => Promise<Header>;
}

async function readHeaderOf(path: string): Promise<Header> {
  const { gguf } = await import('@huggingface/gguf');
  return gguf(path, { allowLocalFile: true });
}

async function readRecord(): Promise<CatalogModel[]> {
  try { return ((JSON.parse(await readFile(tunedModelsFile(), 'utf8')) as { models?: CatalogModel[] }).models ?? []); } catch { return []; }
}

async function writeRecord(models: readonly CatalogModel[]): Promise<void> {
  await mkdir(dirname(tunedModelsFile()), { recursive: true });
  const temporary = `${tunedModelsFile()}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify({ models }, null, 2)}\n`);
  await rename(temporary, tunedModelsFile());
}

/** The id a tuned model is chosen by (`/model tuned:<name>`). */
export const tunedModelId = (name: string): string => `${TUNED_ID_PREFIX}${name}`;

/** Registers a fine-tuned GGUF: reads its header, puts the file in the store, records the model. Throws, saying why, when it cannot be fitted. */
export async function registerTunedModel(input: RegisterTunedInput, deps: TunedDeps = {}): Promise<CatalogModel> {
  if (!NAME.test(input.name)) throw new Error(`"${input.name}" is not a model name: use lower-case letters, digits, dots, dashes and underscores, at most 40.`);
  const size = (await stat(input.ggufPath).catch(quiet('local-models/tuned')))?.size;
  if (!size) throw new Error(`No GGUF at ${input.ggufPath}.`);
  const sha256 = await sha256File(input.ggufPath);
  const header = await (deps.readHeader ?? readHeaderOf)(input.ggufPath);
  const file = `${input.name}.gguf`;
  const built = remoteModelFromHeader(
    { id: `${TUNED_REPO_PREFIX}${input.name}`, sha: sha256.slice(0, 40), cardData: { license: input.license ?? 'apache-2.0' } },
    { rfilename: file, lfs: { sha256, size } },
    header,
  );
  if (!built) {
    throw new Error('This GGUF cannot be fitted: its architecture, chat template (it must support tools) or license is not one ClikCode Local can run safely.');
  }
  const model: CatalogModel = {
    ...built,
    id: tunedModelId(input.name),
    label: `${input.name} (tuned)`,
    quality: input.quality ?? 30,
    qualityNote: 'Fine-tuned on this computer; its tool use and quality are unchecked: try it on your own tasks',
  };
  delete model.discovered;

  const destination = modelFilePath(model.weights);
  if (basename(destination) !== file) throw new Error('internal: the store path does not end in the model file');
  await mkdir(dirname(destination), { recursive: true });
  if (input.ggufPath !== destination) {
    try { await link(input.ggufPath, destination); } catch { await copyFile(input.ggufPath, destination); }
  }
  const others = (await readRecord()).filter((item) => item.id !== model.id);
  await writeRecord([...others, model]);
  return model;
}

/** The models this user has tuned. */
export async function listTunedModels(): Promise<CatalogModel[]> {
  return readRecord();
}

/** Forgets a tuned model and says whether there was one. Its file stays in the store until the store is cleaned. */
export async function forgetTunedModel(name: string): Promise<boolean> {
  const all = await readRecord();
  const kept = all.filter((item) => item.id !== tunedModelId(name));
  if (kept.length === all.length) return false;
  await writeRecord(kept);
  return true;
}
