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
        target: 'this-computer', id: choice.id, label: choice.label, detail: choice.brief || choice.detail,
        downloadBytes: choice.downloadBytes, recommended: choice.recommended, repo: choice.repo,
      }));
  },

  async plan(row): Promise<HostedPlan> {
    // On disk, it is free and offline already: choosing the row is the whole decision, so nothing is asked.
    if (!row.downloadBytes) return { title: row.label, lines: [], confirm: 'Use it', costly: false, consent: false, summary: 'downloaded · free, works offline' };
    const size = formatBytes(row.downloadBytes);
    return {
      title: `Download ${row.label} (${size})?`,
      lines: ['Runs on this computer, free and offline. It downloads in the background; this chat moves to it when it is ready.'],
      confirm: 'Download',
      costly: false,
      consent: true,
      summary: `${size} download · free after, works offline`,
    };
  },

  async start(row): Promise<HostedSelection> {
    // Always the download form, on disk or not: it moves the chat once the model is on this machine (a missing one is fetched on its
    // own meanwhile), so no caller moves the chat first and leaves it on a route with no model.
    return { route: 'clikcode-local', model: row.id, download: true };
  },
};
