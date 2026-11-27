/** Public ClikDeploy OAuth adapter. Connector orchestration and publication live in ClikDeploy. */
import { spawn } from 'node:child_process';
import type { ConnectStart, ConsentPlatform } from '../../agent/computer/oauth-platform.js';
import { authorizationUrl, startFailure } from '../../agent/computer/oauth-authorization.js';
import { scrubSecrets } from '../../agent/computer/secret-scrubber.js';
import { connectionState } from '../../agent/computer/secret-destinations.js';

/** ClikDeploy's own callback: an https origin on clikdeploy.com. */
export const ownsClikDeployCallback = (url: URL): boolean => url.protocol === 'https:' && /(^|\.)clikdeploy\.com$/i.test(url.hostname);

/** Runs the clikdeploy CLI (the saved admin key is its own sign-in) and waits for it to print the authorization URL. */
export function startViaCli(connector: string, signal?: AbortSignal, values: Record<string, string> = {}): Promise<ConnectStart> {
  if (signal?.aborted) return Promise.reject(signal.reason ?? new Error('OAuth connection cancelled'));
  const bad = Object.entries(values).find(([name, value]) => !/^[A-Za-z_][\w-]{0,63}$/.test(name) || !value || /[\r\n]/.test(value));
  if (bad) return Promise.reject(new Error(`oauth_connect values: "${bad[0]}" is not a usable name=value (a plain name and a one-line value).`));
  const valueArgs = Object.entries(values).flatMap(([name, value]) => ['--value', `${name}=${value}`]);
  return new Promise((resolve, reject) => {
    const child = spawn('clikdeploy', ['integrations', 'connect', connector, '--no-browser', ...valueArgs], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let text = '';
    let settled = false;
    const detach = (): void => signal?.removeEventListener('abort', stop);
    const stop = (): void => {
      detach(); child.kill();
      if (!settled) { settled = true; clearTimeout(timer); reject(signal?.reason ?? new Error('OAuth connection cancelled')); }
    };
    child.once('close', detach);
    const timer = setTimeout(() => { if (!settled) { settled = true; stop(); reject(new Error('ClikDeploy did not return an authorization URL within a minute.')); } }, 60_000);
    const look = (final: boolean): void => {
      if (settled) return;
      const url = authorizationUrl(text, ownsClikDeployCallback);
      if (url) { settled = true; clearTimeout(timer); resolve({ url, stop }); return; }
      if (final) {
        settled = true; clearTimeout(timer);
        const said = startFailure(text);
        reject(new Error(`ClikDeploy would not start the connection for ${connector}: ${scrubSecrets(said) || 'no answer'}`));
      }
    };
    const feed = (chunk: unknown): void => { text = (text + String(chunk)).slice(-20_000); look(false); };
    child.stdout!.on('data', feed); child.stderr!.on('data', feed);
    child.once('error', error => { if (settled) return; settled = true; clearTimeout(timer); detach(); reject(new Error((error as NodeJS.ErrnoException).code === 'ENOENT' ? 'The clikdeploy command is not installed on this computer.' : error.message)); });
    child.once('close', () => look(true));
    signal?.addEventListener('abort', stop, { once: true });
    if (signal?.aborted) stop();
  });
}

/** The default platform: ClikDeploy's CLI starts the connection and reads it back; its callback is on clikdeploy.com. */
export const CLIKDEPLOY_PLATFORM: ConsentPlatform = {
  appNames: ['ClikDeploy'], ownsCallback: ownsClikDeployCallback, start: startViaCli, status: (id, signal) => connectionState(id, signal),
};

