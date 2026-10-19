import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { addSiteNote, readSiteNotes } from './site-notes.js';

it('keeps notes per host, newest last, and refuses a note that holds a key', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'clikcode-notes-'));
  try {
    expect(await readSiteNotes(dir, 'www.Asana.com')).toBe('');
    await addSiteNote(dir, 'app.asana.com', 'My apps lives at /0/my-apps; tick the API terms box first');
    await addSiteNote(dir, 'app.asana.com', 'Full permissions switch needs Save changes');
    expect(await readSiteNotes(dir, 'app.asana.com')).toBe('- My apps lives at /0/my-apps; tick the API terms box first\n- Full permissions switch needs Save changes');
    expect(await readSiteNotes(dir, 'airtable.com')).toBe('');
    await expect(addSiteNote(dir, 'app.asana.com', 'secret is 3pV9kQ2mZx8LrT5wYb7NcA1dHf4GjEs6')).rejects.toThrow('shaped like a key');
    await expect(addSiteNote(dir, '../etc', 'x')).rejects.toThrow('site name');
    await expect(addSiteNote(dir, '', 'x')).rejects.toThrow('site name');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
