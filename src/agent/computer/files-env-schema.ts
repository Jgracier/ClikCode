/** The files-and-environment half of browser_use: its action names, arguments and help text. Kept apart from
 * computer-web.ts so that file only wires them in. */
export const FILES_ENV_ACTIONS = ['downloads'] as const;
export type FilesEnvAction = typeof FILES_ENV_ACTIONS[number];

export type FilesEnvArgs = Record<never, never>;

export const FILES_ENV_PARAMETERS: Record<string, object> = {};

export const FILES_ENV_HELP = [
  'Files: every file the browser downloads is saved (not deleted) in a folder of this chat\'s own and reported with its name, size and path as soon as the click or open that started it returns; downloads lists them again. Only a key being captured with capture_secret is read and deleted instead.',
].join(' ');
