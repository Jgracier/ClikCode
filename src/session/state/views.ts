/** Redacted projections of state, safe to print. */

import type { AiHarnessAccount } from '../../harness/definition.js';

export function accountView(account: AiHarnessAccount): Omit<AiHarnessAccount, 'credentialRef'> {
  const { credentialRef: _credentialRef, ...safe } = account;
  return safe;
}

