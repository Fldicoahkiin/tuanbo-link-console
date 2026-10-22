import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import type { Ma2OnpcBridge } from './ma2-onpc-bridge';
import { Ma2ConsoleBackups } from './ma2-console-backups';

const name = (index: number, prefix = 'library'): string => `tblink_${prefix}_${index.toString(16).padStart(32, '0')}`;
async function setup(playing = false) {
  const path = join(await mkdtemp(join(tmpdir(), 'tblink-backups-')), 'backups.json');
  const report = vi.fn<(message: string) => Promise<void>>(() => Promise.resolve());
  const request = vi.fn<Ma2OnpcBridge['request']>((_operation, _target, expected) => Promise.resolve(expected ?? ''));
  const ledger = async (): Promise<string[]> => (JSON.parse(await readFile(path, 'utf8')) as { entries: Array<{ file: string }> }).entries.map(entry => entry.file);
  return { backups: new Ma2ConsoleBackups(path, () => playing, report), bridge: { request }, request, report, ledger };
}

it('每个控台对象只留最近 10 份：超出时删除最旧的，回执确认后才从记录里移除', async () => {
  const t = await setup();
  for (let index = 1; index <= 10; index++) await t.backups.record(t.bridge, { console: '192.0.2.1:30000', object: 'Sequence 9000', files: [name(index)] });
  expect(t.request).not.toHaveBeenCalled();
  await t.backups.record(t.bridge, { console: '192.0.2.1:30000', object: 'Sequence 9000', files: [`${name(11)}.xml`, name(12, 'label')] });
  expect(t.request).toHaveBeenCalledWith('DISCARD', 1, `${name(1)},${name(2)}`);
  expect(await t.ledger()).toEqual([3, 4, 5, 6, 7, 8, 9, 10, 11].map(index => name(index)).concat(name(12, 'label')));
  expect(t.report).not.toHaveBeenCalled();
});

it('不同对象、不同控台各自计数，互不清理', async () => {
  const t = await setup();
  for (let index = 1; index <= 10; index++) await t.backups.record(t.bridge, { console: 'a:30000', object: 'Sequence 9000', files: [name(index)] });
  await t.backups.record(t.bridge, { console: 'a:30000', object: 'Timecode 9906', files: [name(100, 'backup')] });
  await t.backups.record(t.bridge, { console: 'b:30000', object: 'Sequence 9000', files: [name(101)] });
  expect(t.request).not.toHaveBeenCalled();
});

it('控台没删掉的文件留在记录里并报告，下次写入后再试；播放期间只记账不删除', async () => {
  const t = await setup();
  t.request.mockImplementation((_operation, _target, expected) => Promise.resolve(expected!.split(',').slice(1).join(',')));
  for (let index = 1; index <= 12; index++) await t.backups.record(t.bridge, { console: 'a:30000', object: 'Sequence 9000', files: [name(index)] });
  expect(t.report).toHaveBeenCalledWith(expect.stringContaining(name(1)));
  expect(await t.ledger()).toContain(name(1));
  const playing = await setup(true);
  for (let index = 1; index <= 12; index++) await playing.backups.record(playing.bridge, { console: 'a:30000', object: 'Sequence 9000', files: [name(index)] });
  expect(playing.request).not.toHaveBeenCalled();
  expect(await playing.ledger()).toHaveLength(12);
});

it('清理失败只报告，不让已成功的写入失败；备份文件全部保留在记录里', async () => {
  const t = await setup();
  t.request.mockRejectedValue(new Error('控台断开'));
  for (let index = 1; index <= 11; index++) await expect(t.backups.record(t.bridge, { console: 'a:30000', object: 'Sequence 9000', files: [name(index)] })).resolves.toBeUndefined();
  expect(t.report).toHaveBeenCalledWith(expect.stringContaining('控台断开'));
  expect(await t.ledger()).toHaveLength(11);
});
