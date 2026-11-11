import { inspectMa2SequenceXml } from './ma2-timecode-xml';
import { readFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import { readMa2Catalog } from './ma2-catalog';
import { Ma2OnpcBridge } from './ma2-onpc-bridge';
import { SHOW_WAIT_CLOCK_MOVING, isShowWait, type ShowState } from '@tb/core/link';
import { idleShow, runningShow, showPaused, showReader, showRunning, showStopped } from './fixtures/show-gates';

const tc = readFileSync(new URL('./fixtures/ma2-timecode-fractional-3.3.xml', import.meta.url), 'utf8');
const seq = readFileSync(new URL('./fixtures/ma2-sequence-fractional-3.3.xml', import.meta.url), 'utf8').match(/<Sequ\s[\s\S]*?<\/Sequ>/)?.[0];
if (!seq) throw new Error('测试 Sequence 缺失');
const snapshot = tc.replace('</MA>', `${seq}</MA>`);
const directory = { show: '现场', generation: 'session', version: '3.3.4.3', entries: [{ target: 9902, name: '小数 Cue' }] };

it('补读前校验来源，换 Show 不覆盖已有检查点；落盘失败不报告已保存', async () => {
  const checkpoint = vi.fn().mockRejectedValue(new Error('磁盘已满'));
  const request = vi.fn<Ma2OnpcBridge['request']>().mockResolvedValue(JSON.stringify(directory));
  await expect(readMa2Catalog({ request }, showStopped, undefined, undefined, undefined, { checkpoint, expectedSource: { ...directory, show: '其他 Show' } })).rejects.toThrow('Show');
  expect(checkpoint).not.toHaveBeenCalled();
  const progress = vi.fn();
  await expect(readMa2Catalog({ request }, showStopped, undefined, progress, undefined, { checkpoint })).rejects.toThrow('磁盘已满');
  expect(progress).not.toHaveBeenCalled();
});

it('目录扫描解析实际小数 Cue 编号，保留原始时间和执行器，只读且前后核对目录', async () => {
  const request = vi.fn<Ma2OnpcBridge['request']>().mockResolvedValueOnce(JSON.stringify(directory)).mockResolvedValueOnce(tc).mockResolvedValueOnce(snapshot).mockResolvedValueOnce(JSON.stringify(directory));
  const result = await readMa2Catalog({ request }, showStopped);
  expect(result.entries[0]).toMatchObject({ target: 9902, eventCount: 2, error: null });
  expect(result.entries[0]?.events.map(event => event.cue)).toEqual(['9901 / 1.250', '9901 / 7.500']);
  expect(request.mock.calls.map(call => call[0])).toEqual(['LIST', 'READ', 'SNAPSHOT', 'LIST']);
  expect(result.entries[0]?.length).toBeNull();
});
it('读取控台节目长度（MA2 属性 lenght，30 Hz）', async () => {
  const sized = tc.replace('<Timecode index="9901"', '<Timecode lenght="6000" index="9901"');
  const request = vi.fn<Ma2OnpcBridge['request']>().mockResolvedValueOnce(JSON.stringify(directory)).mockResolvedValueOnce(sized).mockResolvedValueOnce(sized.replace('</MA>', `${seq}</MA>`)).mockResolvedValueOnce(JSON.stringify(directory));
  expect((await readMa2Catalog({ request }, showStopped)).entries[0]?.length).toBe('6000');
});
it('对象读取失败仍列出，不把部分结果冒充完整成功，不自动重试', async () => {
  const request = vi.fn().mockResolvedValueOnce(JSON.stringify(directory)).mockRejectedValueOnce(new Error('对象被删除')).mockResolvedValueOnce(JSON.stringify(directory));
  const result = await readMa2Catalog({ request }, showStopped);
  expect(result.entries[0]).toMatchObject({ eventCount: null, error: '对象被删除' });
  expect(request).toHaveBeenCalledTimes(3);
});
it('换 Show 或开始播放使扫描失败，重复目录编号被拒绝', async () => {
  const request = vi.fn().mockResolvedValueOnce(JSON.stringify(directory)).mockResolvedValueOnce(tc).mockResolvedValueOnce(snapshot).mockResolvedValueOnce(JSON.stringify({ ...directory, show: '其他 Show' }));
  const partial = await readMa2Catalog({ request }, showStopped);
  expect(partial.incomplete).toContain('Show'); expect(partial.entries[0]?.sourceXml).toBe(tc);
  request.mockReset().mockResolvedValue(JSON.stringify(directory));
  await expect(readMa2Catalog({ request }, showRunning)).rejects.toThrow(SHOW_WAIT_CLOCK_MOVING);
  expect(request).not.toHaveBeenCalled();
  request.mockResolvedValue(JSON.stringify({ ...directory, entries: [...directory.entries, ...directory.entries] }));
  await expect(readMa2Catalog({ request }, showStopped)).rejects.toThrow('重复');
});
it.skipIf(!process.env.MA2_ONPC_CATALOG_ACCEPTANCE)('真实 onPC 扫描目录及已录制小数 Cue', async () => {
  const bridge = new Ma2OnpcBridge(process.env.MA2_ONPC_DATA_DIRECTORY ?? '', showStopped);
  const result = await readMa2Catalog(bridge, showStopped);
  const owned = result.entries.find(entry => entry.target === 9902);
  expect(owned?.name).toBe('TBLINK_FRACTIONAL_TIMECODE');
  expect(owned?.error).toBeNull();
  expect(owned?.events.map(event => event.cue)).toEqual(['9901 / 1.250', '9901 / 7.500']);
  expect(result.entries.find(entry => entry.target === 9903)?.eventCount).toBe(0);
}, 180000);

it('网络扫描复用已核对的 Cue 目录，不下载完整灯具快照', async () => {
  const request = vi.fn<Ma2OnpcBridge['request']>().mockResolvedValueOnce(JSON.stringify(directory)).mockResolvedValueOnce(tc).mockResolvedValueOnce(tc).mockResolvedValueOnce(JSON.stringify(directory));
  const metadata = inspectMa2SequenceXml(snapshot);
  const result = await readMa2Catalog({ request }, showStopped, metadata);
  expect(result.entries[0]?.events.map(event => event.cue)).toEqual(['9901 / 1.250', '9901 / 7.500']);
  expect(result.entries[0]?.error).toBeNull();
  expect(request.mock.calls.map(call => call[0])).toEqual(['LIST', 'READ', 'READ', 'LIST']);
});
it('时间线扫描只按真实对象完成数推进，目录复核后才到终点', async () => {
  const progress: { completed: number; total: number; detail: string }[] = [];
  const request = vi.fn<Ma2OnpcBridge['request']>().mockResolvedValueOnce(JSON.stringify(directory)).mockResolvedValueOnce(tc).mockResolvedValueOnce(tc).mockResolvedValueOnce(JSON.stringify(directory));
  await readMa2Catalog({ request }, showStopped, inspectMa2SequenceXml(snapshot), update => progress.push(update));
  expect(progress.map(value => [value.completed, value.total])).toEqual([[0, 2], [1, 2], [1, 2], [2, 2]]);
  expect(progress.at(-1)?.detail).toBe('时间线目录检查完毕');
});

it('暂停时照常读完控台（2026-11-10 第 3 题）', async () => {
  const request = vi.fn<Ma2OnpcBridge['request']>().mockResolvedValueOnce(JSON.stringify(directory)).mockResolvedValueOnce(tc).mockResolvedValueOnce(snapshot).mockResolvedValueOnce(JSON.stringify(directory));
  const result = await readMa2Catalog({ request }, showPaused);
  expect(result.incomplete).toBeUndefined();
  expect(result.entries[0]).toMatchObject({ target: 9902, error: null });
  expect(request.mock.calls.map(call => call[0])).toEqual(['LIST', 'READ', 'SNAPSHOT', 'LIST']);
});

it('读到一半节目开始走：读完的留在检查点，下一条之前停住，抛等待并写明做到哪了（02 §4.4）', async () => {
  const two = { ...directory, entries: [{ target: 9902, name: '小数 Cue' }, { target: 9903, name: '下一首' }] };
  let show: ShowState = idleShow;
  const request = vi.fn<Ma2OnpcBridge['request']>().mockResolvedValueOnce(JSON.stringify(two)).mockResolvedValueOnce(tc).mockResolvedValueOnce(snapshot);
  const saved: number[] = [];
  const checkpoint = vi.fn((_catalog: unknown, entry?: { target: number }) => { if (entry) { saved.push(entry.target); show = runningShow; } return Promise.resolve(); });
  const reading = readMa2Catalog({ request }, showReader(() => show), undefined, undefined, undefined, { checkpoint });
  await expect(reading).rejects.toThrow(`${SHOW_WAIT_CLOCK_MOVING}暂停或停止后再读取控台。已读完 1/2 条时间线，接着读会从没读的开始。`);
  await reading.catch((error: unknown) => expect(isShowWait(error)).toBe(true));
  expect(saved).toEqual([9902]);
  expect(request.mock.calls.map(call => [call[0], call[1]])).toEqual([['LIST', 1], ['READ', 9902], ['SNAPSHOT', 9902]]);
});

it('时间线都读完、核对目录之前节目开始走：保留结果，标成没确认，不再发目录读取', async () => {
  let show: ShowState = idleShow;
  const request = vi.fn<Ma2OnpcBridge['request']>().mockResolvedValueOnce(JSON.stringify(directory)).mockResolvedValueOnce(tc).mockImplementationOnce(() => { show = runningShow; return Promise.resolve(snapshot); });
  const result = await readMa2Catalog({ request }, showReader(() => show));
  expect(result.sourceUnverified).toBe(true);
  expect(result.incomplete?.startsWith(SHOW_WAIT_CLOCK_MOVING)).toBe(true);
  expect(result.entries[0]).toMatchObject({ target: 9902, error: null });
  expect(request).toHaveBeenCalledTimes(3);
});
