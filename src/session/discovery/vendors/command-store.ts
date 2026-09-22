/** Command Code: `<HOME>/.commandcode/projects/<cwd-slug>/<id>.jsonl`.
 *
 * Its own bundled reference states the layout ("Sessions are stored per
 * project, keyed by a slug of the working directory") and, usefully, which of
 * the three sibling files is the conversation:
 *
 *   <id>.jsonl              the transcript itself (header + entries)
 *   <id>.checkpoints.jsonl  checkpoint snapshots for /rewind
 *   <id>.prompts.jsonl      prompt history
 *
 * Confirmed by carrying only the transcript into a second HOME and resuming
 * there: Command Code replayed the whole prior thread to the model. So the
 * checkpoints and prompt history are genuinely not part of resuming, and this
 * stays a one-file carry -- unlike Copilot, whose directory holds the id and
 * cwd its resume matches against.
 *
 * The slug is lowercased, every run of non-alphanumerics becomes one dash, and
 * the leading separator is dropped -- so there is no leading dash, which is
 * exactly where it differs from Claude Code's and Qwen's names. Derived from
 * observed output rather than source (the CLI ships minified), then checked
 * against three cwds chosen to pin the parts that could differ:
 *
 *   /home/justin-gracier/projects/clikcode -> home-justin-gracier-projects-clikcode
 *   /tmp/probe/work.dir_x/A b              -> tmp-probe-work-dir-x-a-b
 *   /tmp/probe/x__y/z--w                   -> tmp-probe-x-y-z-w
 *
 * The second pins case folding and the dot/underscore/space cases; the third
 * pins that runs collapse to a single dash rather than one dash each.
 *
 * Command Code redirects the whole HOME per account rather than taking a
 * dedicated profile variable, so `HOME` here is the profile.
 */

import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { nativeDataRoot, type NativeSessionEnvironment, type NativeSessionFile, type NativeSessionStore } from '../stores.js';

function commandProjectSlug(workspace: string): string {
  return workspace.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

export const commandSessionStore: NativeSessionStore = {
  root(environment: NativeSessionEnvironment): string {
    return join(nativeDataRoot(environment, 'HOME', homedir()), '.commandcode', 'projects');
  },
  async locate(root: string, nativeId: string, workspace: string): Promise<NativeSessionFile | undefined> {
    const path = join(root, commandProjectSlug(workspace), `${nativeId}.jsonl`);
    return await stat(path).then(() => ({ path, root }), () => undefined);
  },
};
