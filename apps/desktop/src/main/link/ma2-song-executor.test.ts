import { expect, it, vi } from 'vitest';
import type { Ma2OnpcBridge } from './ma2-onpc-bridge';
import type { Ma2Telnet } from './ma2-telnet';
import { assignMa2SongExecutor, planMa2SongExecutor } from './ma2-song-executor';
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
it('creates a song executor at 1000.101 where the plan read the page, and verifies the assignment by reading that page once', async () => {
  const f = fixture(false);
  const destination = await planMa2SongExecutor(f.bridge, source, 9907, 1000, undefined, () => false);
  expect(await assignMa2SongExecutor(f.connection, f.bridge, source, 9907, destination, () => false)).toBe('1000.101');
  const script = f.connection.command.mock.calls.map(([command]) => command.match(/\[#\w+\+1\]=unhex\('([a-f0-9]+)'\)/)?.[1]).filter((value): value is string => !!value).map(value => Buffer.from(value, 'hex').toString()).join('') || f.connection.command.mock.calls[0]?.[0];
  expect(script).toContain('Store Page 1000 /nc'); expect(script).toContain('Assign Sequence 9907 At Executor 1000.101');
  expect(f.bridge.request.mock.calls.map(call => call.slice(0, 2))).toEqual([['PAGES', 1], ['PAGE', 1000]]);
});
it('keeps an existing song at its exact address without reassigning it or reading the page again', async () => {
  const f = fixture(true);
  const destination = await planMa2SongExecutor(f.bridge, source, 9001, 1000, '1000.201', () => false);
  expect(destination.assigned).toBe(true);
  f.bridge.request.mockClear();
  expect(await assignMa2SongExecutor(f.connection, f.bridge, source, 9001, destination, () => false)).toBe('1000.201');
  expect(f.connection.command).not.toHaveBeenCalled(); expect(f.bridge.request).not.toHaveBeenCalled();
});
it('原位置被别的序列占用时换到下一个空格，不覆盖；原位置空着时放回原位；本曲在同页挪过位置时跟到新位置', async () => {
  const f = fixture(true);
  expect(await planMa2SongExecutor(f.bridge, source, 9908, 1000, '1000.101', () => false)).toEqual({ address: '1000.102', slot: 102, pageExists: true, assigned: false });
  expect(await planMa2SongExecutor(f.bridge, source, 9908, 1000, '1000.150', () => false)).toEqual({ address: '1000.150', slot: 150, pageExists: true, assigned: false });
  expect(await planMa2SongExecutor(f.bridge, source, 9001, 1000, '1000.150', () => false)).toEqual({ address: '1000.201', slot: 201, pageExists: true, assigned: true });
  expect(f.connection.command).not.toHaveBeenCalled();
});
it('does not allocate anything after playback starts', async () => {
  const f = fixture(false);
  await expect(planMa2SongExecutor(f.bridge, source, 9907, 1000, undefined, () => true)).rejects.toThrow('播放');
  expect(f.bridge.request).not.toHaveBeenCalled();
  await expect(assignMa2SongExecutor(f.connection, f.bridge, source, 9907, { address: '1000.101', slot: 101, pageExists: false, assigned: false }, () => true)).rejects.toThrow('播放');
  expect(f.bridge.request).not.toHaveBeenCalled(); expect(f.connection.command).not.toHaveBeenCalled();
});
const pageXml = (page: number, filled: number): string => `<?xml version="1.0" encoding="utf-8"?><MA tblink_show="test-show" tblink_generation="test-session" tblink_version="3.7.0.5" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns="http://schemas.malighting.de/grandma2/xml/MA" major_vers="3" minor_vers="7" stream_vers="0"><Page index="${page - 1}">${Array.from({ length: 190 }, (_, index) => index >= 100 && index < 100 + filled ? `<Exec offset_from_first="0"><Assignment name="song ${index}"><No>25</No><No>1</No><No>${9000 + index}</No></Assignment></Exec>` : '<Exec xsi:nil="true" />').join('')}</Page></MA>`;
it('第 1000 页 101–190 放满时放到 1001 页，原有内容不覆盖（2026-10-26）', async () => {
  let created = false;
  const bridge = { request: vi.fn<Ma2OnpcBridge['request']>().mockImplementation((op, target) => {
    if (op === 'PAGES') return Promise.resolve(JSON.stringify({ ...source.expectedSource, buttonPage: 4, faderPage: 100, pages: [{ page: 1000, name: 'song' }, ...created ? [{ page: 1001, name: '' }] : []] }));
    if (op === 'PAGE' && target === 1000) return Promise.resolve(pageXml(1000, 90));
    if (op === 'PAGE' && target === 1001) return Promise.resolve(pageXml(1001, created ? 1 : 0).replace('<No>9100</No>', '<No>9300</No>'));
    throw new Error(`Unexpected ${op} ${target}`);
  }) };
  const command = vi.fn<Ma2Telnet['command']>().mockImplementation(text => { created = true; return Promise.resolve(text.includes("READY'") ? 'READY' : 'OK:assigned'); });
  const destination = await planMa2SongExecutor(bridge, source, 9300, 1000, undefined, () => false);
  expect(destination).toEqual({ address: '1001.101', slot: 101, pageExists: false, assigned: false });
  expect(await assignMa2SongExecutor({ command }, bridge, source, 9300, destination, () => false)).toBe('1001.101');
  const script = command.mock.calls.map(([text]) => text.match(/\[#\w+\+1\]=unhex\('([a-f0-9]+)'\)/)?.[1]).filter((value): value is string => !!value).map(value => Buffer.from(value, 'hex').toString()).join('') || command.mock.calls[0]?.[0];
  expect(script).toContain('Store Page 1001 /nc'); expect(script).toContain('Assign Sequence 9300 At Executor 1001.101');
  expect(script).not.toContain('1000.');
});
