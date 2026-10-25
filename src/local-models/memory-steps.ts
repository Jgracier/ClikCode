/** What a local model's memory handling decides and says, apart from the machinery that acts on it
 * (index.ts): the smaller restarts the supervisor may make, and how a restart or stop is told. */
import { catalogModel, type CatalogModel } from './catalog.js';
import { kvCacheBytes, MIN_CONTEXT, type Fit } from './shared/index.js';
import type { MemoryEvent, ShrinkStep } from './lifecycle.js';
import { footprintKey } from './measure.js';

function contextLabel(tokens: number): string {
  return `${Math.round(tokens / 1024)}K`;
}

/** The supervisor's note of a restart it made to give memory back, as the
 * user reads it. */
export function shrinkNotice(event: MemoryEvent | undefined): string | undefined {
  if (event?.action !== 'shrink' || !event.toContext) return undefined;
  const label = catalogModel(event.modelId)?.label ?? event.modelId;
  return `${label} was restarted at ${contextLabel(event.toContext)} context (from ${contextLabel(event.fromContext)}) to leave memory for other programs: ${event.reason}.`;
}

export function stopNotice(stops: readonly MemoryEvent[], chosen: CatalogModel, fit: Pick<Fit, 'context'> | undefined): string | undefined {
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
export function shrinkSteps(model: CatalogModel, fit: Fit, cacheRamMib: number, vision: boolean, args: (context: number, cacheRamMib: number) => string[]): ShrinkStep[] {
  const steps: ShrinkStep[] = [];
  const step = (context: number): ShrinkStep => ({
    context, cacheRamMib: 0, kvBytes: kvCacheBytes(model.kv, context, fit.cacheType, fit.parallel), args: args(context, 0),
    footprintKey: footprintKey({ context, cacheType: fit.cacheType, parallel: fit.parallel, vision }),
  });
  if (cacheRamMib > 0) steps.push(step(fit.context));
  for (let context = Math.floor(fit.context / 2); context >= MIN_CONTEXT; context = Math.floor(context / 2)) steps.push(step(context));
  return steps;
}
