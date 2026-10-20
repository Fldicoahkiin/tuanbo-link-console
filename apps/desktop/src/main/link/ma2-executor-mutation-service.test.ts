import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, expect, it, vi } from 'vitest';
import type { Ma2ExecutorUpdateRequest } from '@tb/schema';
import { Ma2ExecutorMutationService } from './ma2-executor-mutation-service';
import { inspectMa2ExecutorPageXml } from './ma2-timecode-xml';
import { runMa2GuardedLua } from './ma2-lua-command';

vi.mock('./ma2-lua-command', async importOriginal => {
  const original = await importOriginal<typeof import('./ma2-lua-command')>();
  return { ...original, runMa2GuardedLua: vi.fn() };
});
const xml = await readFile(new URL('./fixtures/ma2-page-3.7.xml', import.meta.url), 'utf8');
const page = inspectMa2ExecutorPageXml(xml, 99);
const base = { network: { host: '192.0.2.1', port: 30000, monitorPort: 30001, username: 'test' }, expectedSource: page.source!, page: 99, slot: 101, expectedItem: page.items[0]! };
const connection = { command: vi.fn() };
const invoke = vi.mocked(runMa2GuardedLua);
const blocks = [...xml.matchAll(/<Exec\b[^>]*?(?:\/>|>[\s\S]*?<\/Exec>)/g)].map(value => value[0]);
function moveXml(target: number): string {
  let index = 0;
  return xml.replace(/<Exec\b[^>]*?(?:\/>|>[\s\S]*?<\/Exec>)/g, () => {
    const slot = ++index;
    return slot === 101 ? '<Exec xsi:nil="true" />' : slot === target ? blocks[100]! : blocks[slot - 1]!;
  });
}
async function service(isPlaying = () => false) { return new Ma2ExecutorMutationService(await mkdtemp(join(tmpdir(), 'tblink-executor-')), isPlaying); }
beforeEach(() => { vi.clearAllMocks(); invoke.mockResolvedValue('verified'); });

it('moves the native executor without reconstructing its assignment and returns verified original positions', async () => {
  const bridge = { request: vi.fn().mockResolvedValueOnce(xml).mockResolvedValueOnce(moveXml(102)) };
  const result = await (await service()).update(connection, bridge, { ...base, action: { kind: 'move', page: 99, slot: 102 } });
  expect(result.pages[0]!.items).toMatchObject([{ slot: 102, sequence: 9907 }, { slot: 201, sequence: 9001 }]);
  expect(await readFile(result.backupFile, 'utf8')).toContain('100步灯光测试');
  expect(invoke.mock.calls[0]![1]).toContain('Move Executor 99.101 At Executor 99.102 /nc');
  expect(invoke.mock.calls[0]![1]).toContain('Executor changed before write');
  expect(invoke.mock.calls[0]![1]).not.toContain('Import Page');
});

it('refuses an occupied destination, stale label or changed session before issuing a write', async () => {
  const mutation = await service();
  await expect(mutation.update(connection, { request: vi.fn().mockResolvedValue(xml) }, { ...base, action: { kind: 'move', page: 99, slot: 201 } })).rejects.toThrow('连续空格');
  await expect(mutation.update(connection, { request: vi.fn().mockResolvedValue(xml) }, { ...base, expectedItem: { ...base.expectedItem, name: 'stale' }, action: { kind: 'delete' } })).rejects.toThrow('已变化');
  await expect(mutation.update(connection, { request: vi.fn().mockResolvedValue(xml) }, { ...base, expectedSource: { ...base.expectedSource, generation: 'changed' }, action: { kind: 'delete' } })).rejects.toThrow('会话已变化');
  expect(invoke).not.toHaveBeenCalled();
});

it('only removes the selected executor assignment and retains its Sequence', async () => {
  const removed = xml.replace(blocks[100]!, '<Exec xsi:nil="true" />');
  const result = await (await service()).update(connection, { request: vi.fn().mockResolvedValueOnce(xml).mockResolvedValueOnce(removed) }, { ...base, action: { kind: 'delete' } });
  expect(result.pages[0]!.items).toMatchObject([{ slot: 201, sequence: 9001 }]);
  const lua = invoke.mock.calls[0]![1];
  expect(lua).toContain('Delete Executor 99.101 /nc');
  expect(lua).toContain("getobj.handle('Sequence 9907')==sequence");
  expect(lua).not.toContain('Delete Sequence');
});

it('renames through the original executor and confirms the assigned object name', async () => {
  const renamed = xml.replaceAll('100步灯光测试', 'Renamed');
  const result = await (await service()).update(connection, { request: vi.fn().mockResolvedValueOnce(xml).mockResolvedValueOnce(renamed) }, { ...base, action: { kind: 'rename', name: 'Renamed' } });
  expect(result.pages[0]!.items[0]!.name).toBe('Renamed');
  expect(invoke.mock.calls[0]![1]).toContain(Buffer.from('Label Executor 99.101 "Renamed"').toString('hex'));
});

it('does not mark an unconfirmed move complete or resend it', async () => {
  await expect((await service()).update(connection, { request: vi.fn().mockResolvedValue(xml) }, { ...base, action: { kind: 'move', page: 99, slot: 102 } })).rejects.toThrow('尚未完整回读');
  expect(invoke).toHaveBeenCalledTimes(1);
});

it('stops queued mutations if timeline playback starts, without blocking local editing APIs', async () => {
  await expect((await service(() => true)).update(connection, { request: vi.fn() }, { ...base, action: { kind: 'delete' } })).rejects.toThrow('本地编辑可以继续');
  expect(invoke).not.toHaveBeenCalled();
});

it('validates every occupied slot of a wide executor at the destination', async () => {
  let index = 0;
  const correctWideXml = xml.replace(/<Exec\b[^>]*?(?:\/>|>[\s\S]*?<\/Exec>)/g, value => ++index === 102 ? '<Exec offset_from_first="1" />' : value);
  const wide = inspectMa2ExecutorPageXml(correctWideXml, 99);
  const request: Ma2ExecutorUpdateRequest = { ...base, expectedItem: wide.items[0]!, action: { kind: 'move', page: 99, slot: 200 } };
  await expect((await service()).update(connection, { request: vi.fn().mockResolvedValue(correctWideXml) }, request)).rejects.toThrow('连续空格');
  expect(invoke).not.toHaveBeenCalled();
});
