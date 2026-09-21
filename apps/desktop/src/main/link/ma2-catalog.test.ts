import { readFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import { readMa2Catalog } from './ma2-catalog';
import { Ma2OnpcBridge } from './ma2-onpc-bridge';

const tc = readFileSync(new URL('./fixtures/ma2-timecode-fractional-3.3.xml', import.meta.url), 'utf8');
const seq = readFileSync(new URL('./fixtures/ma2-sequence-fractional-3.3.xml', import.meta.url), 'utf8').match(/<Sequ\s[\s\S]*?<\/Sequ>/)?.[0];
if (!seq) throw new Error('测试 Sequence 缺失');
const snapshot = tc.replace('</MA>', `${seq}</MA>`);
const directory = { show: '现场', generation: 'session', version: '3.3.4.3', entries: [{ target: 9902, name: '小数 Cue' }] };

it('目录扫描解析实际小数 Cue 编号，保留原始时间和执行器，只读且前后核对目录', async () => {
  const request = vi.fn<Ma2OnpcBridge['request']>().mockResolvedValueOnce(JSON.stringify(directory)).mockResolvedValueOnce(tc).mockResolvedValueOnce(snapshot).mockResolvedValueOnce(JSON.stringify(directory));
  const result = await readMa2Catalog({ request }, () => false);
  expect(result.entries[0]).toMatchObject({ target: 9902, eventCount: 2, error: null });
  expect(result.entries[0]?.events.map(event => event.cue)).toEqual(['9901 / 1.250', '9901 / 7.500']);
  expect(request.mock.calls.map(call => call[0])).toEqual(['LIST', 'READ', 'SNAPSHOT', 'LIST']);
});
it('对象读取失败仍列出，不把部分结果冒充完整成功，不自动重试', async () => {
  const request = vi.fn().mockResolvedValueOnce(JSON.stringify(directory)).mockRejectedValueOnce(new Error('对象被删除')).mockResolvedValueOnce(JSON.stringify(directory));
  const result = await readMa2Catalog({ request }, () => false);
  expect(result.entries[0]).toMatchObject({ eventCount: null, error: '对象被删除' });
  expect(request).toHaveBeenCalledTimes(3);
});
it('换 Show 或开始播放使扫描失败，重复目录编号被拒绝', async () => {
  const request = vi.fn().mockResolvedValueOnce(JSON.stringify(directory)).mockResolvedValueOnce(tc).mockResolvedValueOnce(snapshot).mockResolvedValueOnce(JSON.stringify({ ...directory, show: '其他 Show' }));
  await expect(readMa2Catalog({ request }, () => false)).rejects.toThrow('Show');
  request.mockReset().mockResolvedValue(JSON.stringify(directory));
  await expect(readMa2Catalog({ request }, () => true)).rejects.toThrow('播放');
  expect(request).toHaveBeenCalledTimes(1);
  request.mockResolvedValue(JSON.stringify({ ...directory, entries: [...directory.entries, ...directory.entries] }));
  await expect(readMa2Catalog({ request }, () => false)).rejects.toThrow('重复');
});
it.skipIf(!process.env.MA2_ONPC_CATALOG_ACCEPTANCE)('真实 onPC 扫描目录及已录制小数 Cue', async () => {
  const bridge = new Ma2OnpcBridge(process.env.MA2_ONPC_DATA_DIRECTORY ?? '', () => false);
  const result = await readMa2Catalog(bridge, () => false);
  const owned = result.entries.find(entry => entry.target === 9902);
  expect(owned?.name).toBe('TBLINK_FRACTIONAL_TIMECODE');
  expect(owned?.error).toBeNull();
  expect(owned?.events.map(event => event.cue)).toEqual(['9901 / 1.250', '9901 / 7.500']);
  expect(result.entries.find(entry => entry.target === 9903)?.eventCount).toBe(0);
}, 180000);
