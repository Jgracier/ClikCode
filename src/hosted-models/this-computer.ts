/** Hosted AI on this computer: ClikCode Local's models that fit the machine (local-models/), by the same ranking. */
import { localModelChoices } from '../local-models/index.js';
import { formatBytes } from '../local-models/download.js';
import type { HostedAdapter, HostedPlan, HostedRow, HostedSelection } from './types.js';

export const thisComputer: HostedAdapter = {
  target: 'this-computer',

  async list(query) {
    const needle = query.trim().toLowerCase();
    const choices = await localModelChoices();
    return choices
      .filter((choice) => !needle || `${choice.label} ${choice.id}`.toLowerCase().includes(needle))
      .map((choice): HostedRow => ({
        target: 'this-computer', id: choice.id, label: choice.label, detail: choice.detail,
        downloadBytes: choice.downloadBytes, recommended: choice.recommended,
      }));
  },

  async plan(row): Promise<HostedPlan> {
    const onDisk = !row.downloadBytes;
    return {
      title: `${row.label} on this computer`,
      lines: [
        onDisk ? 'Already downloaded.' : `Downloads ${formatBytes(row.downloadBytes ?? 0)} once.`,
        'Runs on this computer: free, and works with no internet or sign-in afterwards.',
        row.detail,
      ],
      confirm: onDisk ? 'Use it' : `Download ${formatBytes(row.downloadBytes ?? 0)} and use it`,
      costly: false,
    };
  },

  async start(row): Promise<HostedSelection> {
    return { route: 'clikcode-local', model: row.id, ...(row.downloadBytes ? { download: true as const } : {}) };
  },
};
