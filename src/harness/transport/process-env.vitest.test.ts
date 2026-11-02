import { afterEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ read: vi.fn(), stat: vi.fn(), quiet: vi.fn() }));
vi.mock('node:fs/promises', () => ({
  readdir: async () => ['100', '200', '300'], readFile: mocks.read, stat: mocks.stat, readlink: vi.fn(),
}));
vi.mock('../../runtime/lifecycle-log.js', () => ({ quiet: () => mocks.quiet }));
import { processesWithEnvironment } from './process-group.js';
afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); });
it('skips other users before reading environments and tolerates permission boundaries', async () => {
  vi.spyOn(process, 'getuid').mockReturnValue(1000);
  mocks.stat.mockImplementation(async (path: string) => ({ uid: path.endsWith('/100') ? 0 : 1000 }));
  mocks.read.mockImplementation(async (path: string) => {
    if (path.includes('/200/')) throw Object.assign(new Error('denied'), { code: 'EACCES' });
    return 'TAG=owned\0';
  });
  expect(await processesWithEnvironment('TAG', 'owned', 'linux')).toEqual([300]);
  expect(mocks.read.mock.calls.map(([path]) => path)).toEqual(['/proc/200/environ', '/proc/300/environ']);
  expect(mocks.quiet).not.toHaveBeenCalled();
});
it('retains cross-user discovery when running as root', async () => {
  vi.spyOn(process, 'getuid').mockReturnValue(0);
  mocks.stat.mockResolvedValue({ uid: 1000 });
  mocks.read.mockResolvedValue('TAG=owned\0');
  expect(await processesWithEnvironment('TAG', 'owned', 'linux')).toEqual([100, 200, 300]);
});
