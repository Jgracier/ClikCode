// Check the resource group this worker actually belongs to, not only host-wide spare RAM.
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { parsePressure } from './connector-loop.js';

export function cgroupDirectories(text: string): string[] {
  const relative = text.split('\n').find(line => line.startsWith('0::'))?.slice(3);
  if (!relative?.startsWith('/') || relative.split('/').includes('..')) return [];
  const paths: string[] = [];
  let path = join('/sys/fs/cgroup', relative);
  while (path.startsWith('/sys/fs/cgroup')) {
    paths.push(path);
    if (path === '/sys/fs/cgroup') break;
    path = dirname(path);
  }
  return paths;
}

export async function memoryPressure(read: (path: string) => Promise<string | undefined> = path => readFile(path, 'utf8').catch(() => undefined)): Promise<number | undefined> {
  const groups = cgroupDirectories(await read('/proc/self/cgroup') ?? '');
  const values = await Promise.all(['/proc/pressure/memory', ...groups.map(path => `${path}/memory.pressure`)].map(async path => parsePressure(await read(path)).full));
  const present = values.filter((v): v is number => v !== undefined);
  return present.length ? Math.max(...present) : undefined;
}
