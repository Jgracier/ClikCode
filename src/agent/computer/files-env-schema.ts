/** The files-and-environment half of browser_use: its action names, arguments and help text. Kept apart from
 * computer-web.ts so that file only wires them in. */
export const FILES_ENV_ACTIONS = ['downloads', 'dialog', 'auth', 'permissions'] as const;
export type FilesEnvAction = typeof FILES_ENV_ACTIONS[number];

export type FilesEnvArgs = { http_auth?: boolean | string; clear?: boolean; grant?: string[] | string; deny?: string[] | string; pages?: string };

export const FILES_ENV_PARAMETERS: Record<string, object> = {
  http_auth: { type: ['boolean', 'string'], description: 'open: the site asks for HTTP sign-in (the browser\'s own username/password box, a 401): answer it with the saved login for the site (true), or the saved login whose username or email is this text. Credentials are never shown; https sites only.' },
  clear: { type: 'boolean', description: 'auth: turn HTTP sign-in off for this tab.' },
  pages: { type: 'string', description: 'observe, on a PDF: which pages to read ("3", "2-5", "1,4-6"). By default the first pages up to a size limit.' },
  grant: { type: ['array', 'string'], items: { type: 'string', enum: ['camera', 'microphone', 'geolocation', 'notifications', 'clipboard'] }, description: 'permissions: what the site may use (camera, microphone, geolocation, notifications, clipboard). https sites only.' },
  deny: { type: ['array', 'string'], items: { type: 'string', enum: ['camera', 'microphone', 'geolocation', 'notifications', 'clipboard'] }, description: 'permissions: what the site may not use (this is the default for everything not granted).' },
};

export const FILES_ENV_HELP = [
  'Files: every file the browser downloads is saved (not deleted) in a folder of this chat\'s own and reported with its name, size and path as soon as the click or open that started it returns; downloads lists them again. Upload takes an absolute path inside the workspace or the downloads folder (symlinks followed; dotfiles, key files, other chats\' downloads, ClikCode state and files over 50 MB are refused). Only a key being captured with capture_secret is read and deleted instead.',
  'Dialogs: a page\'s alert/confirm/prompt/"leave this page?" box never goes unseen. During a click it is declined and reported (click again with accept_dialog true to accept). A box that arrives at any other time (a timer, Enter in a form) is held: the page waits, the result shows the question, and the dialog action answers it (accept_dialog true to accept, text for a prompt\'s answer; leave accept_dialog out to dismiss). An unanswered box is dismissed after two minutes. open accepts a "leave this page?" box, since leaving was the request.',
  'HTTP sign-in: when a site shows the browser\'s own username/password box (HTTP Basic or Digest), open with http_auth true, or call auth (url = the site, default the open page; label = which saved login) and the saved login for that origin answers it, for that origin only. With no saved login the user is asked once, privately, and it is kept. You never see it. auth with clear true turns it off for the tab.',
  'Permissions: a site that asks for the camera, microphone, location, notifications or clipboard is denied by default (so no prompt blocks the page). To allow one, call permissions with grant (url = the site, default the open page), then reload or open the page again; deny takes it back; with neither it lists the state. A grant lasts while this session runs.',
  'Documents: when a tab shows a PDF, observe and open return its text with page markers (--- page 3 of 40 ---), capped; ask for other pages with pages. Plain text, JSON, XML and CSV tabs return their text; an image or other document says what it is. PDFs behind a sign-in work (the tab\'s cookies are used). A scan with no text layer says so: take a screenshot.',
].join(' ');

/** Plan-text label of one of these actions, or undefined for any other. */
export function filesEnvLabel(args: { action: string; url?: string; label?: string; clear?: boolean; grant?: string[] | string; deny?: string[] | string }): string | undefined {
  switch (args.action) {
    case 'downloads': return 'List downloads';
    case 'dialog': return 'Answer the page\'s dialog';
    case 'auth': return args.clear ? 'Turn off HTTP sign-in' : 'HTTP sign-in with the saved login';
    case 'permissions': return args.grant?.length ? `Allow ${[args.grant].flat().join(', ')} for the site` : args.deny?.length ? `Deny ${[args.deny].flat().join(', ')} for the site` : 'Show site permissions';
    default: return undefined;
  }
}
