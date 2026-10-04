import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TOOL_CATEGORY } from '../../../../src/harness/protocol/tool-category';

const css = readFileSync(join(__dirname, '../../src/webview/styles.css'), 'utf8');

describe('tool colours in the panel', () => {
  it('give every category colour its own theme variable', () => {
    const colours = [...new Set(Object.values(TOOL_CATEGORY).map((entry) => entry.colour))];
    const variables = colours.map((colour) => new RegExp(`\\.tone-${colour} \\{ --tone: var\\((--vscode-[\\w-]+)`).exec(css)?.[1]);
    expect(variables.every(Boolean)).toBe(true);
    expect(new Set(variables).size).toBe(colours.length);
  });

  it('colour a working conversation by its pace, as the terminal does', () => {
    for (const pace of ['slowing', 'stuck']) expect(css).toContain(`.conversation-dot.working.${pace}`);
  });
});
