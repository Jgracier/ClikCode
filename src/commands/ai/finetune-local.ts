/** `clikcode finetune`: teach a model from the user's own data on this computer and use it again here as a local model. The cloud
 * counterpart is `clikcode gateway finetune` (ClikDeploy trains it and stores the weights). */
import { emitResult } from '../../cli/structured-output.js';
import { tunedModelId } from '../../local-models/tuned.js';

export interface LocalFineTuneOptions {
  base?: string;
  name?: string;
  epochs?: string;
  rank?: string;
  license?: string;
}

export async function aiLocalFineTune(
  datasetPath: string,
  options: LocalFineTuneOptions = {},
  deps: { fineTune?: typeof import('../../local-models/finetune-local.js').fineTuneLocalModel; progress?: (line: string) => void } = {},
): Promise<void> {
  if (!options.base) throw new Error('Name the base model with --base, a Hugging Face repo such as Qwen/Qwen2.5-0.5B-Instruct (the original weights, not a GGUF).');
  if (!options.name) throw new Error('Name the new model with --name, e.g. --name support-bot. You will choose it as tuned:support-bot.');
  const epochs = options.epochs === undefined ? undefined : Number(options.epochs);
  const rank = options.rank === undefined ? undefined : Number(options.rank);
  if (rank !== undefined && (!Number.isInteger(rank) || rank < 4 || rank > 128)) throw new Error('--rank must be a whole number from 4 to 128');
  if (options.license !== undefined && options.license !== 'apache-2.0' && options.license !== 'mit') throw new Error('--license must be apache-2.0 or mit: ClikCode Local runs only models under those licenses.');
  const fineTune = deps.fineTune ?? (await import('../../local-models/finetune-local.js')).fineTuneLocalModel;
  const { model, seconds } = await fineTune({
    dataset: datasetPath, base: options.base, name: options.name,
    ...(epochs !== undefined ? { epochs } : {}), ...(rank !== undefined ? { loraRank: rank } : {}),
    ...(options.license ? { license: options.license as 'apache-2.0' | 'mit' } : {}),
  }, { ...(deps.progress ? { progress: deps.progress } : {}) });
  emitResult({
    model: tunedModelId(options.name), label: model.label, sizeBytes: model.weights.sizeBytes, minutes: Math.round(seconds / 60),
    use: `Choose it with /model ${tunedModelId(options.name)}, or: clikcode send --harness clikcode-local --model ${tunedModelId(options.name)} "…"`,
  });
}
