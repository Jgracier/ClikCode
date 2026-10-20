import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';

const loaded = vi.hoisted(() => [] as string[]);
vi.mock('playwright-core', () => { loaded.push('playwright-core'); return { chromium: {} }; });
vi.mock('@huggingface/gguf', () => { loaded.push('@huggingface/gguf'); return { gguf: async () => ({}) }; });

const cache = (): string[] => Object.keys(createRequire(import.meta.url).cache).filter((file) => /node_modules[\\/]yaml[\\/]/.test(file));

describe('start-up loads the heavy dependencies at first use', () => {
  it('importing the command surface, the computer browser and local-model discovery loads none of them', async () => {
    await import('./register.js');
    await import('./structured-output.js');
    await import('../agent/skills.js');
    await import('../agent/computer/browser.js');
    await import('../agent/computer/browser-host.js');
    await import('../local-models/discover.js');
    expect(loaded).toEqual([]);
    expect(cache()).toEqual([]);
  });

  it('yaml loads when frontmatter is first parsed', async () => {
    const { parseFrontmatter } = await import('../agent/skills.js');
    expect(parseFrontmatter('---\nname: a\ndescription: b\n---\nbody')).toMatchObject({ fields: { name: 'a' } });
    expect(cache().length).toBeGreaterThan(0);
  });
});
