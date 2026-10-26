/** The files-and-environment half of browser_use: its action names, arguments and help text. Kept apart from
 * computer-web.ts so that file only wires them in. */
export const FILES_ENV_ACTIONS = ['downloads', 'dialog', 'auth'] as const;
export type FilesEnvAction = typeof FILES_ENV_ACTIONS[number];

export type FilesEnvArgs = { http_auth?: boolean | string; clear?: boolean };

export const FILES_ENV_PARAMETERS: Record<string, object> = {
  http_auth: { type: ['boolean', 'string'], description: 'open: the site asks for HTTP sign-in (the browser\'s own username/password box, a 401): answer it with the saved login for the site (true), or the saved login whose username or email is this text. Credentials are never shown; https sites only.' },
  clear: { type: 'boolean', description: 'auth: turn HTTP sign-in off for this tab.' },
};

export const FILES_ENV_HELP = [
  'Files: every file the browser downloads is saved (not deleted) in a folder of this chat\'s own and reported with its name, size and path as soon as the click or open that started it returns; downloads lists them again. Upload takes an absolute path inside the workspace or the downloads folder (symlinks followed; dotfiles, key files, other chats\' downloads, ClikCode state and files over 50 MB are refused). Only a key being captured with capture_secret is read and deleted instead.',
  'Dialogs: a page\'s alert/confirm/prompt/"leave this page?" box never goes unseen. During a click it is declined and reported (click again with accept_dialog true to accept). A box that arrives at any other time (a timer, Enter in a form) is held: the page waits, the result shows the question, and the dialog action answers it (accept_dialog true to accept, text for a prompt\'s answer; leave accept_dialog out to dismiss). An unanswered box is dismissed after two minutes. open accepts a "leave this page?" box, since leaving was the request.',
  'HTTP sign-in: when a site shows the browser\'s own username/password box (HTTP Basic or Digest), open with http_auth true, or call auth (url = the site, default the open page; label = which saved login) and the saved login for that origin answers it, for that origin only. With no saved login the user is asked once, privately, and it is kept. You never see it. auth with clear true turns it off for the tab.',
].join(' ');

/** Plan-text label of one of these actions, or undefined for any other. */
export function filesEnvLabel(args: { action: string; url?: string; label?: string; clear?: boolean }): string | undefined {
  switch (args.action) {
    case 'downloads': return 'List downloads';
    case 'dialog': return 'Answer the page\'s dialog';
    case 'auth': return args.clear ? 'Turn off HTTP sign-in' : 'HTTP sign-in with the saved login';
    default: return undefined;
  }
}
