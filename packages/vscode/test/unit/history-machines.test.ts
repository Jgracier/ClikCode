// Other machines' chats in the editor's history list: a section per machine, in its own hue, so a chat moved to another machine
// is still in the list and is told apart from this machine's.
import { describe, expect, it } from 'vitest';
import { MACHINE_HUE_CLASSES, machineHueClass, otherMachineSections } from '../../src/webview/machine-text';

const machine = (id: string, name: string, state: string) => ({ id, name, state } as { id: string; name: string; state: 'connected' });
const chat = (id: string, title = id) => ({ id, title });

describe('machine hues', () => {
  it('are one of three classes, the same for a machine every time', () => {
    expect(MACHINE_HUE_CLASSES).toHaveLength(3);
    for (const id of ['a', 'b', 'c', 'cmsno83c9002h1fkobd3qxpo2']) {
      expect(MACHINE_HUE_CLASSES).toContain(machineHueClass(id));
      expect(machineHueClass(id)).toBe(machineHueClass(id));
    }
  });
});

describe('other machines in the history list', () => {
  const machines = [machine('local', 'This machine', 'local'), machine('m1', 'macbook', 'connected'), machine('m2', 'imac', 'offline'), machine('tailscale:n1', 'winbox', 'available')];
  const chats: Record<string, ReturnType<typeof chat>[]> = { local: [chat('l1')], m1: [chat('c1', 'Graciergcx website'), chat('c2')], m2: [chat('c3')], 'tailscale:n1': [chat('x')] };

  it('lists every machine but the one showing, in order, each under its name, hue and offline state', () => {
    const sections = otherMachineSections(machines, 'local', (id) => chats[id], () => true);
    expect(sections.map((section) => section.title)).toEqual(['macbook', 'imac']);
    expect(sections[0]!.rows.map((row) => row.title)).toEqual(['Graciergcx website', 'c2']);
    expect(sections[0]!.hue).toBe(machineHueClass('m1'));
    expect(sections.map((section) => section.offline)).toEqual([false, true]);
  });

  it('includes this machine\'s chats when a remote machine is the one showing, and never a tailnet machine that is not added', () => {
    const sections = otherMachineSections(machines, 'm1', (id) => chats[id], () => true);
    expect(sections.map((section) => section.machineId)).toEqual(['local', 'm2']);
  });

  it('adds no section for a machine with no chats or none matching the search', () => {
    const none = otherMachineSections(machines, 'local', (id) => (id === 'm1' ? [] : chats[id]), () => true);
    expect(none.map((section) => section.title)).toEqual(['imac']);
    const search = otherMachineSections(machines, 'local', (id) => chats[id], (row) => row.title.includes('Gracier'));
    expect(search.map((section) => section.title)).toEqual(['macbook']);
    expect(search[0]!.rows).toHaveLength(1);
  });

  it('adds nothing while a machine\'s chats have not loaded', () => {
    expect(otherMachineSections(machines, 'local', () => undefined, () => true)).toEqual([]);
  });
});
