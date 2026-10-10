/** How a harness installs on an OS, decided from its catalog declaration
 * alone -- pure, so the decision is testable without installing anything.
 * install.ts carries it out. */

import type { AiHarnessInstallStep, AiHarnessInstaller } from '../../definition.js';
import type { NativeHarnessSpec } from './binary.js';
import { installStepFor } from './install-locations.js';

export type InstallSpec = Pick<NativeHarnessSpec, 'command' | 'binary' | 'displayName' | 'npmPackage'> & {
  installer?: AiHarnessInstaller;
  acp?: { binary?: string; npmPackage?: string };
};

export type HarnessInstallRoute =
  | { kind: 'npm'; package: string }
  | { kind: 'script'; step: Extract<AiHarnessInstallStep, { kind: 'script' }> }
  | { kind: 'uv-tool'; step: Extract<AiHarnessInstallStep, { kind: 'uv-tool' }> }
  | { kind: 'none'; reason: string };

/** How this harness installs on this OS -- decided from the catalog alone. */
export function harnessInstallRoute(spec: InstallSpec, platform: NodeJS.Platform = process.platform): HarnessInstallRoute {
  if (spec.npmPackage) return { kind: 'npm', package: spec.npmPackage };
  const step = installStepFor(spec.installer, platform);
  if (step?.kind === 'script') return { kind: 'script', step };
  if (step?.kind === 'uv-tool') return { kind: 'uv-tool', step };
  if (spec.installer) {
    return { kind: 'none', reason: `${spec.displayName} publishes no installer for ${platformName(platform)}; see ${spec.installer.docs}.` };
  }
  return { kind: 'none', reason: `ClikCode has no installer for ${spec.displayName}; install it so a \`${spec.binary}\` command is on PATH.` };
}

function platformName(platform: NodeJS.Platform): string {
  return platform === 'win32' ? 'Windows' : platform === 'darwin' ? 'macOS' : platform === 'linux' ? 'Linux' : platform;
}

/** The same install, as a line someone could run themselves -- the fallback
 * shown when the automatic one fails. */
export function manualInstallCommand(route: HarnessInstallRoute, platform: NodeJS.Platform = process.platform): string | undefined {
  switch (route.kind) {
    case 'npm': return `npm install -g ${route.package}`;
    case 'uv-tool': return `uv tool install ${route.step.python ? `--python ${route.step.python} ` : ''}${route.step.package}${(route.step.with ?? []).map((name) => ` --with ${name}`).join('')}`;
    case 'script': {
      const args = route.step.args ?? [];
      if (platform === 'win32') {
        const env = Object.entries(route.step.env ?? {}).map(([name, value]) => `$env:${name}='${value}'; `).join('');
        return args.length
          ? `${env}& ([scriptblock]::Create((irm '${route.step.url}'))) ${args.join(' ')}`
          : `${env}irm '${route.step.url}' | iex`;
      }
      const env = Object.entries(route.step.env ?? {}).map(([name, value]) => `${name}=${value} `).join('');
      return `curl -fsSL '${route.step.url}' | ${env}bash${args.length ? ` -s -- ${args.join(' ')}` : ''}`;
    }
    default: return undefined;
  }
}
