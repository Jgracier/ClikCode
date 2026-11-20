import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { backgroundEnvironment, probeCommand, probeEnvironment, probeFetch, runVendorCommand, type GateHarness } from './vendor-probe.js';
import { probeOnce } from './account-usage.js';

/** A fake vendor CLI: a shell script, never a real one. */
async function fakeVendor(body: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'fake-vendor-'));
  const file = join(directory, 'vendor');
  await writeFile(file, `#!/bin/sh\n${body}\n`);
  await chmod(file, 0o755);
  return file;
}

/** A harness entry for a fake vendor, signed in by FAKE_VENDOR_KEY. */
function gate(binary: string): GateHarness {
  return { command: 'fake-vendor', binary, authEnv: ['FAKE_VENDOR_KEY'] };
}
const SIGNED_IN = { FAKE_VENDOR_KEY: 'k' };

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

describe.skipIf(process.platform === 'win32')('vendor probes', () => {
  it('ends a vendor that never answers at the deadline, with what it started', async () => {
    const pids = join(await mkdtemp(join(tmpdir(), 'probe-pids-')), 'pids');
    const vendor = await fakeVendor(`sleep 60 & echo $$ $! > ${pids}; wait`);
    const started = Date.now();
    expect(await probeCommand(gate(vendor), [], SIGNED_IN, 300)).toBeUndefined();
    expect(Date.now() - started).toBeLessThan(2_000);
    const [leader, grandchild] = (await readFile(pids, 'utf8')).trim().split(' ').map(Number);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(alive(leader!)).toBe(false);
    expect(alive(grandchild!)).toBe(false);
  });

  it('gives the vendor no stdin and a browser opener that does nothing', async () => {
    const vendor = await fakeVendor('read line || echo "eof"; echo "$BROWSER"; xdg-open https://example.com/login && echo opened-nothing');
    const output = await probeCommand(gate(vendor), [], SIGNED_IN, 5_000);
    const [stdin, browser, opened] = output!.trim().split('\n');
    expect(stdin).toBe('eof');
    expect(browser).toMatch(/probe-no-browser\/xdg-open$/);
    expect(opened).toBe('opened-nothing');
    expect(probeEnvironment({ PATH: '/x' }).PATH).toMatch(/probe-no-browser:\/x$/);
  });

  it('a fetch that never answers gives up', async () => {
    const { createServer } = await import('node:http');
    const server = createServer(() => undefined).listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    try {
      const port = (server.address() as { port: number }).port;
      await expect(probeFetch(`http://127.0.0.1:${port}/`, {}, 100)).rejects.toThrow();
    } finally { server.closeAllConnections(); server.close(); }
  });
});

describe('usage probes in flight', () => {
  it('a probe that never settles frees its slot at the deadline, so the next ask runs', async () => {
    let calls = 0;
    const hung = probeOnce('hung-account', () => { calls += 1; return new Promise(() => undefined); }, 50);
    expect(await hung).toBeUndefined();
    const next = await probeOnce('hung-account', async () => { calls += 1; return { windows: [], label: 'ok' }; }, 50);
    expect(next).toEqual({ windows: [], label: 'ok' });
    expect(calls).toBe(2);
  });
});

/** A fake vendor written in node, on PATH under `name` for one test. */
async function fakeNodeVendor(name: string, source: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'fake-node-vendor-'));
  const file = join(directory, name);
  await writeFile(file, `#!${process.execPath}\n${source}\n`);
  await chmod(file, 0o755);
  return directory;
}

describe.skipIf(process.platform === 'win32')('JSON-RPC probe clients', () => {
  it('Copilot: one request over Content-Length framing', async () => {
    const { copilotUsageReading } = await import('./cli-usage-probes.js');
    const directory = await fakeNodeVendor('copilot', `
      let buffer = Buffer.alloc(0);
      process.stdin.on('data', (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);
        const end = buffer.indexOf('\\r\\n\\r\\n');
        if (end < 0) return;
        const length = Number(/Content-Length: (\\d+)/.exec(buffer.subarray(0, end).toString())[1]);
        if (buffer.length < end + 4 + length) return;
        const request = JSON.parse(buffer.subarray(end + 4, end + 4 + length).toString());
        const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { quotaSnapshots: { chat: { entitlementRequests: 200, remainingPercentage: 75, isUnlimitedEntitlement: false } } } }));
        process.stdout.write(Buffer.concat([Buffer.from('Content-Length: ' + body.length + '\\r\\n\\r\\n'), body]));
      });
    `);
    const path = process.env.PATH;
    process.env.PATH = `${directory}:${path}`;
    try {
      // Copilot's sign-in on disk, or the background gate starts nothing.
      await writeFile(join(directory, 'config.json'), '{\n  "loggedInUsers": [\n    {"login": "someone"}\n  ]\n}\n');
      expect(await copilotUsageReading({ COPILOT_HOME: directory })).toMatchObject({ windows: [{ name: 'chat', usedPct: 25 }], plan: { name: 'Copilot Free' } });
    } finally { process.env.PATH = path; }
  });

  it('Codex: asks for rate limits as soon as initialize is answered and acknowledged', async () => {
    const { NATIVE_USAGE_PROBES } = await import('./usage-probes.js');
    const directory = await fakeNodeVendor('codex', `
      let ready = false;
      require('node:readline').createInterface({ input: process.stdin }).on('line', (line) => {
        const message = JSON.parse(line);
        if (message.method === 'initialize') process.stdout.write(JSON.stringify({ id: message.id, result: {} }) + '\\n');
        else if (message.method === 'initialized') ready = true;
        else if (message.method === 'account/rateLimits/read') process.stdout.write(JSON.stringify(ready
          ? { id: message.id, result: { rateLimits: { primary: { usedPercent: 40, windowDurationMins: 300 } } } }
          : { id: message.id, error: { message: 'not initialized' } }) + '\\n');
      });
    `);
    const path = process.env.PATH;
    process.env.PATH = `${directory}:${path}`;
    try {
      await writeFile(join(directory, 'auth.json'), '{"OPENAI_API_KEY":"k"}');
      const started = Date.now();
      const reading = await NATIVE_USAGE_PROBES.codex!({ CODEX_HOME: directory });
      expect(reading?.windows).toMatchObject([{ usedPct: 40 }]);
      expect(Date.now() - started).toBeLessThan(5_000);
    } finally { process.env.PATH = path; }
  });
});

describe.skipIf(process.platform === 'win32')('the background vendor runner', () => {
  it('gives a vendor no display, no session bus and a no-op browser', () => {
    const saved = { DISPLAY: process.env.DISPLAY, WAYLAND_DISPLAY: process.env.WAYLAND_DISPLAY, DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS };
    Object.assign(process.env, { DISPLAY: ':0', WAYLAND_DISPLAY: 'wayland-0', DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus' });
    try {
      const environment = backgroundEnvironment({ PATH: '/x', XAUTHORITY: '/home/u/.Xauthority' });
      expect(environment.DISPLAY).toBeUndefined();
      expect(environment.WAYLAND_DISPLAY).toBeUndefined();
      expect(environment.XAUTHORITY).toBeUndefined();
      expect(environment.DBUS_SESSION_BUS_ADDRESS).toBe('unix:path=/nonexistent');
      expect(environment.BROWSER).toMatch(/probe-no-browser\/xdg-open$/);
      expect(environment.PATH).toMatch(/probe-no-browser:\/x$/);
      // A vendor whose token is in the keyring keeps the bus, and still no display.
      const keyring = backgroundEnvironment({}, { keyring: true });
      expect(keyring.DBUS_SESSION_BUS_ADDRESS).toBe('unix:path=/run/user/1000/bus');
      expect(keyring.DISPLAY).toBeUndefined();
    } finally {
      for (const [name, value] of Object.entries(saved)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
    }
  });

  it('refuses a profile with no sign-in, as signed-out, starting nothing', async () => {
    const marker = join(await mkdtemp(join(tmpdir(), 'gate-')), 'ran');
    const vendor = await fakeVendor(`touch ${marker}`);
    expect(await runVendorCommand({ gate: gate(vendor), argv: [], environment: {}, deadlineMs: 5_000 })).toEqual({ status: 'signed-out' });
    // A vendor declaring nothing to look for is never started either.
    expect(await runVendorCommand({ gate: { command: 'bare', binary: vendor }, argv: [], environment: SIGNED_IN, deadlineMs: 5_000 })).toEqual({ status: 'signed-out' });
    await expect(readFile(marker)).rejects.toThrow();
    // A credential file the catalog names is evidence; so is running signed out by contract.
    const profile = await mkdtemp(join(tmpdir(), 'gate-profile-'));
    await writeFile(join(profile, 'auth.json'), '{"token":"t"}');
    const filed = { command: 'filed', binary: vendor, authFiles: [{ path: '${FAKE_PROFILE}/auth.json' }] };
    expect((await runVendorCommand({ gate: filed, argv: [], environment: { FAKE_PROFILE: profile }, deadlineMs: 5_000 })).status).toBe('ok');
    expect((await runVendorCommand({ gate: { command: 'free', binary: vendor, signInOptional: true }, argv: [], environment: {}, deadlineMs: 5_000 })).status).toBe('ok');
  });

  it('a signed-out CLI that tries to open its sign-in in a browser never can', async () => {
    // Real openers later on PATH: anything that reaches one leaves a mark.
    const real = await mkdtemp(join(tmpdir(), 'real-openers-'));
    const opened = join(real, 'opened');
    for (const name of ['xdg-open', 'firefox', 'sensible-browser', 'gio']) {
      await writeFile(join(real, name), `#!/bin/sh\necho "${name} $*" >> ${opened}\n`);
      await chmod(join(real, name), 0o755);
    }
    const vendor = await fakeVendor([
      'echo "display=${DISPLAY:-none} wayland=${WAYLAND_DISPLAY:-none}"',
      '"$BROWSER" https://app.example.dev/signin',
      'xdg-open https://app.example.dev/signin',
      'firefox https://app.example.dev/signin',
      'sensible-browser https://app.example.dev/signin',
      'gio open https://app.example.dev/signin',
      'read answer || echo "no terminal to ask"',
    ].join('\n'));
    const path = process.env.PATH;
    const display = process.env.DISPLAY;
    process.env.PATH = `${real}:${path}`;
    process.env.DISPLAY = ':0';
    try {
      // Signed out: refused before it starts.
      expect(await runVendorCommand({ gate: gate(vendor), argv: [], environment: {}, deadlineMs: 5_000 })).toEqual({ status: 'signed-out' });
      // Even signed in (a sign-in it might still try to refresh in the browser), nothing opens.
      const outcome = await runVendorCommand({ gate: gate(vendor), argv: [], environment: { ...SIGNED_IN, PATH: `${real}:${path}` }, deadlineMs: 5_000 });
      expect(outcome.status).toBe('ok');
      const stdout = outcome.status === 'ok' ? outcome.value.stdout : '';
      expect(stdout).toContain('display=none wayland=none');
      expect(stdout).toContain('no terminal to ask');
      await expect(readFile(opened, 'utf8')).rejects.toThrow();
    } finally {
      process.env.PATH = path;
      if (display === undefined) delete process.env.DISPLAY; else process.env.DISPLAY = display;
    }
  });

  it('says a vendor that never answers timed out, and ends its group', async () => {
    const pids = join(await mkdtemp(join(tmpdir(), 'runner-pids-')), 'pids');
    const vendor = await fakeVendor(`sleep 60 & echo $! > ${pids}; wait`);
    const outcome = await runVendorCommand({ gate: gate(vendor), argv: [], environment: SIGNED_IN, deadlineMs: 300 });
    expect(outcome).toMatchObject({ status: 'failed', reason: 'timeout' });
    const grandchild = Number((await readFile(pids, 'utf8')).trim());
    for (let wait = 0; wait < 40 && alive(grandchild); wait += 1) await new Promise((resolve) => setTimeout(resolve, 100));
    expect(alive(grandchild)).toBe(false);
  });

  it('says what a vendor that exits non-zero printed on stderr', async () => {
    const vendor = await fakeVendor('echo "Not logged in" >&2; exit 1');
    const outcome = await runVendorCommand({ gate: gate(vendor), argv: [], environment: SIGNED_IN, deadlineMs: 5_000 });
    expect(outcome).toMatchObject({ status: 'failed', reason: 'error' });
    expect(outcome.status === 'failed' ? outcome.detail : '').toMatch(/exited 1: Not logged in/);
  });
});
