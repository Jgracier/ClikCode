import { claimedTask } from './connector-loop-live.js';
import { expect, it } from 'vitest';


it('preserves an explicitly assigned official-docs task instead of starting unrelated onboarding', () => {
 const claim = { id: 'vendor', lane: 'needs-spec', task: 'docs-to-spec: Read https://vendor.example/docs and build the full API.' };
 expect(claimedTask(claim)?.next).toEqual({ kind: 'agent', task: claim.task });
 expect(claimedTask({ id: 'vendor', lane: 'auto', task: claim.task })).toBeUndefined();
 expect(claimedTask(null)).toBeUndefined();
});
