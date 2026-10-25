/** The models ClikCode Local can run: the signed public catalog (see catalog-source.ts) plus
 * pinned Hugging Face candidates discovered on this machine (discover.ts), which stay local. */

import { readFileSync } from 'node:fs';
import { catalogModels } from './catalog-source.js';
import { discoveredModelsFile } from './paths.js';
import type { CatalogModel } from './shared/index.js';

export type { CatalogFile, CatalogModel, KvGeometry } from './shared/index.js';

/** Remote candidates are registered after the picker refreshes its cache. */
let remoteModels: readonly CatalogModel[] = [];
export function registerRemoteModels(models: readonly CatalogModel[]): void { remoteModels = models; }
try {
  const saved = JSON.parse(readFileSync(discoveredModelsFile(), 'utf8')) as { models?: CatalogModel[] };
  if (Array.isArray(saved.models)) remoteModels = saved.models.filter((model) =>
    model.discovered && model.id?.startsWith('hf:') && model.weights?.sha256?.match(/^[0-9a-f]{64}$/)
    && model.weights?.revision?.match(/^[0-9a-f]{40}$/) && model.weights.sizeBytes > 0);
} catch { /* A first run has no cache. */ }
export function allLocalModels(): readonly CatalogModel[] {
  const builtIn = new Set(catalogModels().map((model) => `${model.weights.repo}/${model.weights.revision}/${model.weights.file}`));
  return [...catalogModels(), ...remoteModels.filter((model) =>
    !builtIn.has(`${model.weights.repo}/${model.weights.revision}/${model.weights.file}`))];
}
export function catalogModel(id: string): CatalogModel | undefined {
  return allLocalModels().find((model) => model.id === id);
}

/** How a session's local model is named on screen: the catalog label, or
 * nothing when the session has not settled on one (the engine picks on the
 * first turn) -- never a placeholder like "auto" standing in for a model. */
export function localModelLabel(id: string | null | undefined): string | undefined {
  return id ? catalogModel(id)?.label ?? id : undefined;
}

/** A model a user typed, from the built-ins or pinned Hub discoveries. */
export function resolveLocalModelId(typed: string): string {
  const wanted = typed.trim().toLowerCase();
  const model = allLocalModels().find((item) => item.id.toLowerCase() === wanted || item.label.toLowerCase() === wanted);
  if (!model) throw new Error(`"${typed.trim()}" is not a ClikCode Local model. Open /model to see models that fit this machine.`);
  return model.id;
}
