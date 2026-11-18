import type Conf from 'conf';
import { gatewayUncensoredConsent, acceptGatewayUncensoredTerms } from '../gateway/models.js';
import { emitResult } from '../cli/structured-output.js';

export async function gatewayAgreement(config: Conf, options: { acceptVersion?: string }): Promise<void> {
  const consent = await gatewayUncensoredConsent({ config });
  if (options.acceptVersion !== undefined && options.acceptVersion !== consent.version) {
    throw new Error('The agreement version has changed. Read `clikcode gateway agreement` and accept its current version.');
  }
  const result = options.acceptVersion === undefined ? consent : await acceptGatewayUncensoredTerms(options.acceptVersion, { config });
  if (options.acceptVersion !== undefined && !result.accepted) throw new Error('The current agreement was not recorded. Review it and try again.');
  emitResult(result);
}
