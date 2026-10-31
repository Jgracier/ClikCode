// Other machines' chats in the main conversation list: a section per machine in its own colour, so a chat moved to another
// machine is still in the list, and told apart from this machine's by its colour and heading.
import { describe, expect, it } from 'vitest';
import chalk from 'chalk';
import type { IdeConversation } from '../ide/protocol.js';
import type { MachineView } from './connection.js';
import { machineHue, otherMachineRows } from './board-rows.js';

const NOW = Date.parse('2026-10-31T21:30:00Z');
const chat = (id: string, title: string): IdeConversation => ({ id, title, updatedAt: '2026-10-31T21:20:00Z', messages: 4, preview: 'last ask' });
const view = (id: string, name: string, state: MachineView['state'], chats: IdeConversation[]): MachineView => (
  { machine: { id, name, sshTarget: `${name}.ts.net`, addedAt: '2026-10-22T00:00:00Z' } as MachineView['machine'], state, needsUpdate: false, chats });
const plain = (text: string | undefined): string => (text ?? '').replace(/\u001b\[[0-9;]*m/g, '');

describe('other machines in the conversation list', () => {
  it('lists each machine\'s chats under a heading of its name, the heading and the row title in the machine\'s colour', () => {
    const previous = chalk.level;
    chalk.level = 1;
    try {
      const rows = otherMachineRows([view('m-1', 'macbook', 'ready', [chat('c1', 'Graciergcx website')])], NOW);
      expect(rows).toHaveLength(1);
      expect(plain(rows[0]!.group)).toBe('macbook');
      expect(plain(rows[0]!.label)).toBe('Graciergcx website');
      const hue = machineHue('m-1');
      expect(rows[0]!.group).toBe(hue('macbook'));
      expect(rows[0]!.label).toBe(hue('Graciergcx website'));
      expect(rows[0]!.value).toContain('c1');
    } finally { chalk.level = previous; }
  });

  it('gives a machine the same colour every time, whatever else is added, and never a state colour', () => {
    const previous = chalk.level;
    chalk.level = 1;
    try {
      const once = machineHue('m-1')('x');
      expect(machineHue('m-1')('x')).toBe(once);
      for (const id of ['a', 'b', 'c', 'd', 'e', 'f', 'g']) {
        const coloured = machineHue(id)('x');
        for (const stateColour of [chalk.green('x'), chalk.yellow('x'), chalk.red('x')]) expect(coloured).not.toBe(stateColour);
      }
    } finally { chalk.level = previous; }
  });

  it('keeps an offline machine\'s rows as last seen, dimmed, and says so in its heading', () => {
    const rows = otherMachineRows([view('m-2', 'imac', 'offline', [chat('c2', 'Old chat')])], NOW);
    expect(rows).toHaveLength(1);
    expect(plain(rows[0]!.group)).toBe('imac · offline, as last seen');
  });

  it('lists nothing for a machine with no chats, and a section per machine in order otherwise', () => {
    const rows = otherMachineRows([
      view('m-1', 'macbook', 'ready', [chat('c1', 'One'), chat('c2', 'Two')]),
      view('m-3', 'extra', 'ready', []),
      view('m-2', 'imac', 'ready', [chat('c3', 'Three')]),
    ], NOW);
    expect(rows.map((row) => plain(row.group))).toEqual(['macbook', 'macbook', 'imac']);
    expect(rows.map((row) => plain(row.label))).toEqual(['One', 'Two', 'Three']);
  });
});
