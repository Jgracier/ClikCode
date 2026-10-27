/** Hosted AI on ClikDeploy: its planner picks the runtime and GPU for a Hugging Face model and bills per hour. */
import { deployPrivateModel, quotePrivateModel, quoteSummary, searchDeployableModels, type DeployableModel, type PrivateModelQuote } from '../gateway/private-models.js';
import type { HostedAdapter, HostedPlan, HostedRow, HostedSelection } from './types.js';

function parameters(count: number | undefined): string {
  if (!count) return '';
  if (count >= 1e9) return `${(count / 1e9).toFixed(count >= 1e10 ? 0 : 1).replace(/\.0$/, '')}B params`;
  return `${Math.round(count / 1e6)}M params`;
}

/** An hourly price at the precision that matters: a cent is a lot for a small model, so those show a third decimal. */
export function perHour(price: number): string {
  return `$${price < 0.1 ? price.toFixed(3).replace(/0$/, '') : price.toFixed(2)}/hour`;
}

/** The quote a plan was shown, kept to start with: the price accepted is the one deployed. */
const quoted = new Map<string, { quote: PrivateModelQuote; model: DeployableModel }>();
const models = new Map<string, DeployableModel>();

export const clikdeploy: HostedAdapter = {
  target: 'clikdeploy',

  async list(query) {
    const found = await searchDeployableModels(query.trim());
    const rows: HostedRow[] = [];
    for (const model of found) {
      if (model.modality && model.modality !== 'llm') continue;
      models.set(model.modelId, model);
      rows.push({
        target: 'clikdeploy', id: model.modelId, label: model.modelId,
        detail: [parameters(model.parameterCount), model.gated ? 'restricted access' : '', 'price shown before it starts'].filter(Boolean).join(' · '),
        ...(model.gated ? { gated: true } : {}),
      });
    }
    return rows;
  },

  async plan(row, signal): Promise<HostedPlan> {
    const model = models.get(row.id) ?? { sourceId: 'huggingface', modelId: row.id, displayName: row.label, gated: row.gated === true };
    let quote: PrivateModelQuote;
    try {
      quote = await quotePrivateModel(row.id, signal);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(model.gated ? `${message} Connect Hugging Face in ClikDeploy, then try again.` : message);
    }
    quoted.set(row.id, { quote, model });
    const summary = quoteSummary(model, quote);
    return {
      title: summary.title,
      lines: summary.body.split('\n'),
      confirm: `Start · ${perHour(quote.pricePerHour)}`,
      costly: true,
      // The price, what it runs on, and the speed as the planner estimates it: what a choice between here and there turns on.
      summary: [perHour(quote.pricePerHour), quote.sku?.displayName, quote.throughput?.decodeTokensPerSec ? `~${Math.round(quote.throughput.decodeTokensPerSec)} tok/s` : '']
        .filter(Boolean).join(' · '),
    };
  },

  async start(row): Promise<HostedSelection> {
    const shown = quoted.get(row.id) ?? { quote: await quotePrivateModel(row.id), model: models.get(row.id) ?? { sourceId: 'huggingface', modelId: row.id, displayName: row.label, gated: row.gated === true } };
    quoted.delete(row.id);
    const deployment = await deployPrivateModel(shown.model, shown.quote);
    // The deployment just created, never its public model name: the create response establishes ownership.
    return { route: 'gateway', model: deployment.gatewayModelId, any: true };
  },
};
