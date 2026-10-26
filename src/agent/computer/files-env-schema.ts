/** The files-and-environment half of browser_use: its action names, arguments and help text. Kept apart from
 * computer-web.ts so that file only wires them in. */
export const FILES_ENV_ACTIONS = ['downloads', 'dialog'] as const;
export type FilesEnvAction = typeof FILES_ENV_ACTIONS[number];

export type FilesEnvArgs = Record<never, never>;

export const FILES_ENV_PARAMETERS: Record<string, object> = {};

export const FILES_ENV_HELP = [
  'Files: every file the browser downloads is saved (not deleted) in a folder of this chat\'s own and reported with its name, size and path as soon as the click or open that started it returns; downloads lists them again. Only a key being captured with capture_secret is read and deleted instead.',
  'Dialogs: a page\'s alert/confirm/prompt/"leave this page?" box never goes unseen. During a click it is declined and reported (click again with accept_dialog true to accept). A box that arrives at any other time (a timer, Enter in a form) is held: the page waits, the result shows the question, and the dialog action answers it (accept_dialog true to accept, text for a prompt\'s answer; leave accept_dialog out to dismiss). An unanswered box is dismissed after two minutes. open accepts a "leave this page?" box, since leaving was the request.',
].join(' ');
