import { claimedTask } from './connector-loop-live.js';
import { expect, it } from 'vitest';


it('preserves an explicitly assigned official-docs task instead of starting unrelated onboarding', () => {
 const claim = { id: 'vendor', lane: 'needs-spec', task: 'docs-to-spec: Read https://vendor.example/docs and build the full API.' };
 expect(claimedTask(claim)?.next).toEqual({ kind: 'agent', task: claim.task });
 expect(claimedTask({ id: 'vendor', lane: 'auto', task: claim.task })).toBeUndefined();
 expect(claimedTask(null)).toBeUndefined();
});

it('paginates past excluded work instead of starving eligible tasks beyond the first page', async () => {
  const seen: unknown[] = [];
  const client = { tool: async (name: string, args: Record<string, unknown>) => {
    seen.push([name, args]);
    if (name === 'connector_work_claim') return { id: 'fresh', lane: 'needs-spec', task: 'docs-to-spec: official docs', scratchpad: { text: 'reference already found' } };
    return args.cursor ? { rows: [{ id: 'fresh', stage: 'needs-agent', status: 'pending' }], nextCursor: null } : { rows: [{ id: 'cooling', stage: 'needs-agent', status: 'pending' }], nextCursor: '100' };
  } } as unknown as import('./connector-runner.js').DeployClient;
  const { livePorts } = await import('./connector-loop-live.js');
  expect(await livePorts(client, '/tmp/unused', { stopRequested: () => false }).next(1, new Set(['cooling']))).toEqual([{ id: 'fresh' }]);
  expect(seen).toContainEqual(['connector_work_overview', { stage: 'needs-agent', limit: 100, cursor: '100' }]);
});
