/** The rows the message box suggests for the token at the caret: commands for `/`, files for `@`. */
import { commandPaletteMatches, type PaletteEntry } from '../../../../src/tui/command-palette';
import type { IdeSlashCommand } from '../protocol';
import type { Mention } from '../webview-protocol';
import { request } from './bus';
import { Icon, type ListRow } from './ui';
import { paletteEntry } from './composer-text';

/** The command list, for the conversation on the provider and model it had
 * when read: another provider has other commands (its own skills, its own
 * built-ins). */
let slashCache: { key: string; at: number; commands: readonly PaletteEntry[] } | undefined;
/** The vendor lists behind the values (models, efforts) load in the
 * background; a list read this long ago is read again for what arrived. */
const SLASH_FRESH_MS = 20_000;

/** What a chosen row does in the message box. */
export interface SuggestionActions {
  /** Put text in place of the token. */
  replace(value: string): void;
  /** Send a whole command line. */
  run(command: string): void;
}

/** The command rows for what has been typed after `/`; `cacheKey` is the
 * conversation, provider and model the list was read for. */
export async function commandRows(query: string, cacheKey: string, actions: SuggestionActions): Promise<ListRow[]> {
  const cached = slashCache;
  const commands = cached?.key === cacheKey && Date.now() - cached.at < SLASH_FRESH_MS ? cached.commands
    : await request<IdeSlashCommand[]>({ method: 'query', query: 'slash-commands' }).then((found) => {
      const entries = found.map(paletteEntry);
      slashCache = { key: cacheKey, at: Date.now(), commands: entries };
      return entries;
    });
  const line = `/${query}`;
  const rows: ListRow[] = [];
  let group: string | undefined;
  for (const item of commandPaletteMatches(line, commands).slice(0, 80)) {
    if (!item.completes && item.group && item.group !== group) { group = item.group; const heading = group; rows.push({ key: `h:${heading}`, heading: true, render: () => <>{heading}</> }); }
    // A value row runs its whole command line; a command that takes
    // values or a required argument is filled in so they can be chosen.
    const fill = Boolean(!item.completes && ((item.argHint && !/^\[/.test(item.argHint)) || item.argValues));
    rows.push({
      key: item.value,
      onSelect: () => {
        if (item.completes) actions.run(item.value);
        // The command's own free-text argument, as typed.
        else if (line.includes(' ')) actions.run(line.trim());
        else if (fill) actions.replace(`${item.value} `);
        else actions.run(item.value);
      },
      render: () => (
        <div class="row">
          <span class="row-main">
            <span class={`row-label${item.completes ? '' : ' mono'}`}>{item.completes ? item.label : item.value}{!item.completes && item.argHint ? <span class="muted"> {item.argHint}</span> : null}</span>
            {item.detail ? <span class="row-detail">{item.detail}</span> : null}
          </span>
        </div>
      ),
    });
  }
  return rows;
}

/** The workspace files matching what has been typed after `@`. */
export async function fileRows(query: string, actions: Pick<SuggestionActions, 'replace'>): Promise<ListRow[]> {
  const files = await request<Mention[]>({ method: 'files', text: query });
  return files.map((file) => ({
    key: file.path,
    onSelect: () => actions.replace(`@${file.label} `),
    render: () => {
      const slash = file.label.lastIndexOf('/');
      return (
        <div class="row">
          <span class="row-check"><Icon name="file" /></span>
          <span class="row-main"><span class="row-label">{file.label.slice(slash + 1)}</span><span class="row-detail">{slash > 0 ? file.label.slice(0, slash) : ''}</span></span>
        </div>
      );
    },
  }));
}
