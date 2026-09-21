/** `/capabilities`: what the active harness can actually do. */

import { commonControlFor } from '../../harness/options.js';
import type { HarnessSession } from '../../harness/types.js';
import { localHarnessCapabilityManifest } from '../../runtime/lazy-bridge.js';
import { sessionHarness } from './context.js';

export function capabilitiesText(session: HarnessSession): string {
  if (session.route === 'gateway') {
    return [
      'ClikDeploy Gateway capabilities',
      'Inference routing: platform managed',
      'Streaming: live SSE token deltas with bounded fallback chunking',
      'Tools: ClikDeploy capability registry and MCP bridge',
      'Permissions: authenticated server policy and confirmation gates',
      'Sessions: durable ClikCode transcript replay',
      'Models and effort: selected by Gateway routing policy',
    ].join('\n');
  }
  const harness = sessionHarness(session);
  if (!harness) throw new Error('Choose a provider first.');
  const manifest = localHarnessCapabilityManifest(harness);
  return [
    `${harness.displayName} capabilities`,
    ...manifest.options.map((option) => {
      const control = commonControlFor(option.id);
      return `${option.label}: ${option.description}${control ? ` (${control})` : ''}`;
    }),
    ...Object.entries(manifest.managers ?? {}).map(([name, manager]) => `${manager?.label ?? name}: available`),
    ...(manifest.features ?? []).map((feature) => `${feature}: native`),
  ].join('\n');
}
