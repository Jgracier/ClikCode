import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BridgeClient } from '../../src/bridge-client';
import {
  bridgeCommandMissing, bridgeCompatibility, IDE_PROTOCOL, INSTALL_COMMAND, INSTALL_FALLBACK_COMMAND, tooOldToStartMessage,
} from '../../src/compat';
import pkg from '../../package.json';

describe('ClikCode compatibility', () => {
  it('installs and updates from npm, with the GitHub release as the fallback', () => {
    expect(INSTALL_COMMAND).toBe('npm install -g clikcode@latest');
    expect(INSTALL_FALLBACK_COMMAND).toBe('npm install -g https://github.com/Jgracier/ClikCode/releases/latest/download/clikcode.tgz');
    // The setting's description tells users the same command.
    expect(pkg.contributes.configuration.properties['clikcode.path'].markdownDescription).toContain(INSTALL_COMMAND);
  });

  it('accepts the bridge protocol this extension was built against', () => {
    expect(bridgeCompatibility({ version: '1.2.3', protocol: IDE_PROTOCOL.version, revision: IDE_PROTOCOL.revision })).toEqual({ ok: true });
    expect(bridgeCompatibility({ version: '1.2.3', protocol: IDE_PROTOCOL.oldestSupported, revision: IDE_PROTOCOL.oldestRevision })).toEqual({ ok: true });
  });

  it('asks for a ClikCode update when the bridge is too old or predates the protocol field', () => {
    const revision = IDE_PROTOCOL.revision;
    for (const ready of [
      { version: '1.0.0' }, { version: '1.0.0', protocol: 'x', revision }, { version: '1.0.0', protocol: IDE_PROTOCOL.oldestSupported - 1, revision },
      // A bridge from before the structured queries (no revision, or 1): the panel has no screens for it.
      { version: '1.0.0', protocol: IDE_PROTOCOL.version }, { version: '1.0.0', protocol: IDE_PROTOCOL.version, revision: IDE_PROTOCOL.oldestRevision - 1 },
    ]) {
      const verdict = bridgeCompatibility(ready);
      expect(verdict.ok).toBe(false);
      if (verdict.ok) continue;
      expect(verdict.remedy).toBe('update-clikcode');
      expect(verdict.message).toContain('Update ClikCode');
      expect(verdict.message).toContain(INSTALL_COMMAND);
      expect(verdict.message).toContain(INSTALL_FALLBACK_COMMAND);
    }
    // Against a range that has moved on.
    const verdict = bridgeCompatibility({ version: '1.0.0', protocol: 2 }, { version: 4, oldestSupported: 3 });
    expect(verdict).toMatchObject({ ok: false, remedy: 'update-clikcode' });
  });

  it('asks for an extension update when the bridge speaks a newer protocol', () => {
    const verdict = bridgeCompatibility({ version: '9.0.0', protocol: IDE_PROTOCOL.version + 1, revision: IDE_PROTOCOL.revision });
    expect(verdict).toMatchObject({ ok: false, remedy: 'update-extension' });
    if (!verdict.ok) expect(verdict.message).toContain('Update the ClikCode extension');
  });

  it('recognizes a ClikCode from before ide-bridge from what it prints as it exits', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'clikcode-old-'));
    const entry = join(dir, 'index.js');
    // What commander prints for an unknown subcommand.
    writeFileSync(entry, `process.stderr.write("error: unknown command 'ide-bridge'\\n"); process.exit(1);`);
    const client = BridgeClient.start({ node: process.execPath, env: {}, entry, nodeSource: 'path' }, dir);
    const log: string[] = [];
    client.on('log', (line) => log.push(line));
    await new Promise((resolve) => client.once('exit', resolve));
    await client.logDrained(2_000);
    expect(bridgeCommandMissing(log)).toBe(true);
    expect(bridgeCommandMissing(['some other failure'])).toBe(false);
    expect(tooOldToStartMessage()).toContain(INSTALL_COMMAND);
  });
});
