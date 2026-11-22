import { describe, expect, it, vi } from 'vitest';

const clients: Array<{ closed: boolean; killNow: ReturnType<typeof vi.fn>; callTool: () => Promise<unknown> }> = [];
vi.mock('../mcp/client.js', () => ({
  McpClient: { connect: async () => { const client = { closed: false, killNow: vi.fn(), callTool: async () => ({ content: [] }) }; clients.push(client); return client; } },
}));
vi.mock('./driver-macos-session.js', () => ({ ensureDesktopDriverService: async () => undefined }));

describe('the desktop driver connection', () => {
  it('adds one process-exit hook however often the driver restarts, and it kills the one connected', async () => {
    const { callComputerDriver } = await import('./driver.js');
    const before = process.listenerCount('exit');
    for (let i = 0; i < 4; i++) {
      await callComputerDriver('list_windows', {});
      clients.at(-1)!.closed = true; // the driver died: the next call starts another
    }
    expect(clients).toHaveLength(4);
    expect(process.listenerCount('exit') - before).toBeLessThanOrEqual(1);
    const hook = process.listeners('exit').at(-1)!;
    clients.at(-1)!.closed = false;
    hook.call(process, 0);
    expect(clients.at(-1)!.killNow).toHaveBeenCalled();
    expect(clients[0]!.killNow).not.toHaveBeenCalled();
  });
});
