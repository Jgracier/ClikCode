/** Hosted AI on ClikDeploy: its planner picks the runtime and GPU for a Hugging Face model and bills per hour. */
import { deployPrivateModel, quotePrivateModel, quoteSummary, searchDeployableModels, type DeployableModel, type PrivateModelQuote } from '../gateway/private-models.js';
import type { HostedAdapter, HostedPlan, HostedRow, HostedSelection } from './types.js';

function parameters(count: number | undefined): string {
  if (!count) return '';
  if (count >= 1e9) return `${(count / 1e9).toFixed(count >= 1e10 ? 0 : 1).replace(/\.0$/, '')}B params`;
  return `${Math.round(count / 1e6)}M params`;
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

  async plan(row): Promise<HostedPlan> {
    const model = models.get(row.id) ?? { sourceId: 'huggingface', modelId: row.id, displayName: row.label, gated: row.gated === true };
    let quote: PrivateModelQuote;
    try {
      quote = await quotePrivateModel(row.id);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(model.gated ? `${message} Connect Hugging Face in ClikDeploy, then try again.` : message);
    }
    quoted.set(row.id, { quote, model });
    const summary = quoteSummary(model, quote);
    return {
      title: summary.title,
      lines: summary.body.split('\n'),
      confirm: `Start · $${quote.pricePerHour.toFixed(2)}/hour`,
      costly: true,
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
