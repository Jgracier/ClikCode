import { expect, it } from 'vitest';
import { classifyAccountFailure } from './failover.js';

// Kimi words a missing plan as "Authentication required"; read as a sign-out
// it would reopen the login on every turn of an account that is signed in.
it('reads a Kimi account without a Kimi Code plan as not eligible, not signed out', () => {
  const error = new Error('Authentication required: 403 Your current subscription does not have access to Kimi Code right now. Upgrade your plan to keep coding with Kimi Code: https://www.kimi.com/code/#pricing');
  expect(classifyAccountFailure(error)).toBe('account-ineligible');
});
