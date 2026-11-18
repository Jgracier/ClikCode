/** The account's exact current agreement, reviewed before recording acceptance. */
import type { HarnessPrompter } from '../harness/prompter.js';
import { acceptGatewayUncensoredTerms, gatewayModels, gatewayModelForWord, gatewayUncensoredConsent } from './models.js';

export async function reviewGatewayModelAgreement(model: string, prompter: HarnessPrompter): Promise<boolean> {
  const list = await gatewayModels();
  if (!gatewayModelForWord(list.models, model)?.tags?.includes('uncensored')) return true;
  const consent = await gatewayUncensoredConsent();
  if (consent.accepted) return true;
  if (!prompter.select) throw new Error('Review the Gateway agreement with clikcode gateway agreement before selecting this model.');
  const accepted = await prompter.select(`Uncensored models · agreement ${consent.version}\n\n${consent.terms}\n\nAccepting records this choice for your ClikDeploy account.`, [
    { label: 'I accept — continue', value: true },
    { label: 'Cancel', value: false },
  ]);
  if (accepted !== true) return false;
  const saved = await acceptGatewayUncensoredTerms(consent.version);
  if (!saved.accepted) throw new Error('The current agreement was not recorded. Review the current version and try again.');
  return true;
}
