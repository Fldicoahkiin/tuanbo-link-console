import { expect, it, vi } from 'vitest';
import type { Ma2OnpcBridge } from './ma2-onpc-bridge';
import type { Ma2Telnet } from './ma2-telnet';
import { assignMa2SongExecutor } from './ma2-song-executor';
import { readFile } from 'node:fs/promises';

const source = { network: { host: '192.0.2.1', port: 30000, monitorPort: 30001, username: 'test' }, expectedSource: { show: 'test-show', generation: 'test-session', version: '3.7.0.5' } };
const native = await readFile(new URL('./fixtures/ma2-page-3.7.xml', import.meta.url), 'utf8');
const page = native.replace(/tblink_show="[^"]*"/, 'tblink_show="test-show"').replace(/tblink_generation="[^"]*"/, 'tblink_generation="test-session"').replace(/(<Page[^>]*index=")98"/, (_match, prefix: string) => `${prefix}999"`);
function fixture(exists: boolean) {
  const bridge = { request: vi.fn<Ma2OnpcBridge['request']>().mockImplementation(op => {
    if (op === 'PAGES') return Promise.resolve(JSON.stringify({ ...source.expectedSource, buttonPage: 4, faderPage: 100, pages: exists ? [{ page: 1000, name: 'song' }] : [] }));
    if (op === 'PAGE') return Promise.resolve(page);
    throw new Error(`Unexpected ${op}`);
  }) };
  const command = vi.fn<Ma2Telnet['command']>().mockImplementation(text => Promise.resolve(text.includes("READY'") ? 'READY' : 'OK:assigned'));
  return { bridge, connection: { command } };
}
it('creates a song executor at 1000.101 and verifies the assignment by reading that page', async () => {
  const f = fixture(false);
  expect(await assignMa2SongExecutor(f.connection, f.bridge, source, 9907, 1000, undefined, () => false)).toBe('1000.101');
  const script = f.connection.command.mock.calls.map(([command]) => command.match(/\[#\w+\+1\]=unhex\('([a-f0-9]+)'\)/)?.[1]).filter((value): value is string => !!value).map(value => Buffer.from(value, 'hex').toString()).join('') || f.connection.command.mock.calls[0]?.[0];
  expect(script).toContain('Store Page 1000 /nc'); expect(script).toContain('Assign Sequence 9907 At Executor 1000.101');
  expect(f.bridge.request.mock.calls.map(call => call.slice(0, 2))).toEqual([['PAGES', 1], ['PAGE', 1000]]);
});
it('keeps an existing song at its exact address without reassigning it', async () => {
  const f = fixture(true);
  expect(await assignMa2SongExecutor(f.connection, f.bridge, source, 9907, 1000, '1000.101', () => false)).toBe('1000.101');
  expect(f.connection.command).not.toHaveBeenCalled();
  await expect(assignMa2SongExecutor(f.connection, f.bridge, source, 9908, 1000, '1000.101', () => false)).rejects.toThrow('已改变');
  expect(f.connection.command).not.toHaveBeenCalled();
});
it('does not allocate anything after playback starts', async () => {
  const f = fixture(false);
  await expect(assignMa2SongExecutor(f.connection, f.bridge, source, 9907, 1000, undefined, () => true)).rejects.toThrow('播放');
  expect(f.bridge.request).not.toHaveBeenCalled(); expect(f.connection.command).not.toHaveBeenCalled();
});
