import { expect, it } from 'vitest';
import { cgroupDirectories, memoryPressure } from './connector-resource-pressure.js';
it('uses the stalled parent resource group even when the host has spare memory', async () => {
  const values: Record<string, string> = { '/proc/self/cgroup': '0::/workers.slice/job.service', '/proc/pressure/memory': 'full avg10=0.00', '/sys/fs/cgroup/workers.slice/memory.pressure': 'full avg10=78.00' };
  expect(await memoryPressure(async path => values[path])).toBe(78);
  expect(cgroupDirectories('0::/../unsafe')).toEqual([]);
});
