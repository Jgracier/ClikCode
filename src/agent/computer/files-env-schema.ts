/** The files-and-environment half of browser_use: its action names, arguments and help text. Kept apart from
 * computer-web.ts so that file only wires them in. */
export const FILES_ENV_ACTIONS = ['downloads', 'dialog', 'auth', 'permissions', 'viewport', 'pdf', 'cookies'] as const;
export type FilesEnvAction = typeof FILES_ENV_ACTIONS[number];

export type FilesEnvArgs = { http_auth?: boolean | string; clear?: boolean; grant?: string[] | string; deny?: string[] | string; pages?: string;
  width?: number; height?: number; scale?: number; mobile?: boolean; device?: string; reset?: boolean; geolocation?: { latitude: number; longitude: number; accuracy?: number } | string; timezone?: string; locale?: string; landscape?: boolean; file_name?: string };

export const FILES_ENV_PARAMETERS: Record<string, object> = {
  http_auth: { type: ['boolean', 'string'], description: 'open: the site asks for HTTP sign-in (the browser\'s own username/password box, a 401): answer it with the saved login for the site (true), or the saved login whose username or email is this text. Credentials are never shown; https sites only.' },
  clear: { type: 'boolean', description: 'auth: turn HTTP sign-in off for this tab. cookies: remove the site\'s cookies.' },
  width: { type: 'number', description: 'viewport: window width in CSS pixels.' },
  height: { type: 'number', description: 'viewport: window height in CSS pixels.' },
  scale: { type: 'number', description: 'viewport: device pixel ratio (1, 2, 3).' },
  mobile: { type: 'boolean', description: 'viewport: act as a phone/tablet (mobile viewport, touch events).' },
  device: { type: 'string', description: 'viewport: a device by name, e.g. "iPhone 15", "Pixel 7", "iPad Pro 11": size, scale, user agent and touch together.' },
  reset: { type: 'boolean', description: 'viewport: undo all emulation (size, device, location, time zone, language).' },
  geolocation: { type: ['object', 'string'], properties: { latitude: { type: 'number' }, longitude: { type: 'number' }, accuracy: { type: 'number' } }, description: 'viewport: where the tab thinks it is, {latitude, longitude} or "48.85,2.35". A site can read it once permissions grants geolocation.' },
  timezone: { type: 'string', description: 'viewport: time zone, e.g. Europe/Paris.' },
  locale: { type: 'string', description: 'viewport: language, e.g. fr-FR (JavaScript and the Accept-Language header).' },
  landscape: { type: 'boolean', description: 'pdf: landscape pages.' },
  file_name: { type: 'string', description: 'pdf: name for the file (default: the page title).' },
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
  'No Chrome: if open answers that ClikCode is downloading Chromium, wait a minute or two and open the page again; if it says the download failed, tell the user what it says to install.',
  'Environment: viewport sets the tab\'s size and device (width, height, scale, mobile, or device: "iPhone 15"), where it thinks it is (geolocation), its time zone and language (timezone, locale); reset undoes it. It lasts while the tab does; reload for a new user agent or language to reach the site. pdf prints the page to a PDF in the downloads folder (landscape, file_name). cookies lists the site\'s cookie names, domains and expiry (never values); cookies with clear true removes them for the site (url = another site).',
].join(' ');

/** Plan-text label of one of these actions, or undefined for any other. */
export function filesEnvLabel(args: { action: string; url?: string; label?: string; clear?: boolean; grant?: string[] | string; deny?: string[] | string; device?: string; reset?: boolean }): string | undefined {
  switch (args.action) {
    case 'downloads': return 'List downloads';
    case 'dialog': return 'Answer the page\'s dialog';
    case 'auth': return args.clear ? 'Turn off HTTP sign-in' : 'HTTP sign-in with the saved login';
    case 'permissions': return args.grant?.length ? `Allow ${[args.grant].flat().join(', ')} for the site` : args.deny?.length ? `Deny ${[args.deny].flat().join(', ')} for the site` : 'Show site permissions';
    case 'viewport': return args.reset ? 'Reset the browser emulation' : args.device ? `Emulate ${args.device}` : 'Set the browser size and environment';
    case 'pdf': return 'Save the page as a PDF';
    case 'cookies': return args.clear ? 'Clear the site\'s cookies' : 'List the site\'s cookies';
    default: return undefined;
  }
}
