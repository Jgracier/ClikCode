// Other machines' chats in the main conversation list: among this machine's own by when each last changed, in the machine's
// colour with its name on the row, so a chat moved to another machine is still in the list and told apart at a glance.
import { describe, expect, it } from 'vitest';
import chalk from 'chalk';
import type { IdeConversation } from '../ide/protocol.js';
import type { MachineView } from './connection.js';
import type { PickerOption } from '../harness/prompter.js';
import { machineHue, mergeMachineRows, otherMachineRows, type RankedRow } from './board-rows.js';

const NOW = Date.parse('2026-10-31T21:30:00Z');
const chat = (id: string, title: string): IdeConversation => ({ id, title, updatedAt: '2026-10-31T21:20:00Z', messages: 4, preview: 'last ask' });
const view = (id: string, name: string, state: MachineView['state'], chats: IdeConversation[]): MachineView => (
  { machine: { id, name, sshTarget: `${name}.ts.net`, addedAt: '2026-10-22T00:00:00Z' } as MachineView['machine'], state, needsUpdate: false, chats });
const plain = (text: string | undefined): string => (text ?? '').replace(/\u001b\[[0-9;]*m/g, '');

const own = (title: string, updatedAt: string, section: RankedRow['section'] = 'active', needsYou = false): RankedRow => (
  { option: { label: title, value: title } as PickerOption<string>, section, needsYou, updatedAtMs: Date.parse(updatedAt) });

describe('other machines in the conversation list', () => {
  it('draws a chat on another machine in that machine\'s colour, with its name on the row', () => {
    const previous = chalk.level;
    chalk.level = 1;
    try {
      const rows = otherMachineRows([view('m-1', 'macbook', 'ready', [chat('c1', 'Graciergcx website')])], NOW);
      expect(rows).toHaveLength(1);
      const hue = machineHue('m-1');
      expect(rows[0]!.option.label).toBe(hue('Graciergcx website'));
      expect(rows[0]!.option.detail).toContain(hue('macbook'));
      expect(rows[0]!.option.value).toContain('c1');
      expect(rows[0]!.section).toBe('active');
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

  it('keeps an offline machine\'s rows as last seen, dimmed, and says offline on the row', () => {
    const rows = otherMachineRows([view('m-2', 'imac', 'offline', [chat('c2', 'Old chat')])], NOW);
    expect(rows).toHaveLength(1);
    expect(plain(rows[0]!.option.detail)).toContain('imac · offline');
  });

  it('puts a chat in Working, Recent or Older by the rules of this machine\'s own, and adds nothing for a machine with no chats', () => {
    const old: IdeConversation = { ...chat('c9', 'Older one'), updatedAt: '2026-10-20T00:00:00Z' };
    const working: IdeConversation = { ...chat('c8', 'Busy'), activity: 'working', turn: { startedAt: '2026-10-31T21:00:00Z', lastActivityAt: '2026-10-31T21:29:00Z' } } as IdeConversation;
    const rows = otherMachineRows([view('m-1', 'macbook', 'ready', [chat('c1', 'One'), old, working]), view('m-3', 'extra', 'ready', [])], NOW);
    expect(rows.map((row) => [plain(row.option.label), row.section])).toEqual([['One', 'active'], ['Older one', 'past'], ['Busy', 'working']]);
  });

  it('merges them with this machine\'s own by when each last changed, a chat that needs you first, each under its section\'s title', () => {
    const others = otherMachineRows([view('m-1', 'macbook', 'ready', [chat('remote', 'On the macbook')])], NOW);
    const merged = mergeMachineRows([
      own('newer here', '2026-10-31T21:25:00Z'), own('older here', '2026-10-31T10:00:00Z'), own('needs me', '2026-10-31T05:00:00Z', 'active', true), own('way back', '2026-10-01T00:00:00Z', 'past'),
    ], others);
    expect(merged.map((row) => plain(row.label))).toEqual(['needs me', 'newer here', 'On the macbook', 'older here', 'way back']);
    expect(merged.map((row) => row.group)).toEqual(['Recent', 'Recent', 'Recent', 'Recent', 'Older']);
  });
});
