import { afterEach, expect, it } from 'vitest';
import { unwrapTool } from './connector-runner-live.js';
import { forgetSecrets, registerSecret } from './secret-scrubber.js';

afterEach(() => forgetSecrets());

it('an error from a ClikDeploy tool is shown in full, over several lines and with its code, never cut at the first line', () => {
  const long = `Worker cc-runner does not hold the lease for pipedeals.\nClaim it first with connector_work_claim.\n${'Detail line. '.repeat(40)}`;
  const text = JSON.stringify({ status: 'error', error: { message: long, code: 'LEASE_REQUIRED' } });
  let message = '';
  try { unwrapTool(text); } catch (error) { message = (error as Error).message; }
  expect(message).toContain('Claim it first with connector_work_claim.');
  expect(message.length).toBeGreaterThan(400);
  expect(message).toContain('[LEASE_REQUIRED]');
});

it('a non-JSON failure keeps all its lines, and a secret in either is hidden', () => {
  registerSecret('sk_live_abcdef123456');
  let message = '';
  try { unwrapTool('line one\nline two sk_live_abcdef123456\nline three\nline four'); } catch (error) { message = (error as Error).message; }
  expect(message).toBe('line one line two [secret hidden] line three line four');
});
