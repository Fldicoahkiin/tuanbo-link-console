import { readFile } from 'node:fs/promises';
import { expect, it, vi } from 'vitest';
import type { Ma2OnpcBridge } from './ma2-onpc-bridge';
import { editMa2Timeline } from './ma2-timeline-edit';
import { inspectMa2TimecodeXml } from './ma2-timecode-xml';

const native = (await readFile(new URL('./fixtures/ma2-timecode-3.7.xml', import.meta.url), 'utf8')).replace('name="AI 舞蹈参考片 STAGING"', 'name="Original"');
const source = { show: 'Show', generation: 'session', version: '3.7.0.5' };
const input = { dataDirectory: '', network: { host: '192.0.2.1', port: 30000, monitorPort: 30001, username: 'test' }, target: 904, name: 'Updated', startMs: 900000, expectedName: 'Original', expectedOffset: 0, expectedSource: source };
function fixture() {
  const request = vi.fn<Ma2OnpcBridge['request']>().mockImplementation(operation => Promise.resolve(operation === 'LIST' ? JSON.stringify({ ...source, entries: [{ target: 904, name: 'Original' }] }) : native));
  const exchange = vi.fn<Ma2OnpcBridge['exchange']>().mockImplementation((_operation, _target, _expected, desired) => Promise.resolve({ requestId: 'test', response: desired! }));
  return { request, exchange };
}
it('修改名称和 MTC 只改根属性，保留所有控台原生事件、轨道、时间，并确认回读', async () => {
  const bridge = fixture(); const result = await editMa2Timeline(bridge, input);
  const [operation, target, expected, desired] = bridge.exchange.mock.calls[0]!;
  expect([operation, target, expected]).toEqual(['APPLY', 904, native]);
  const before = inspectMa2TimecodeXml(native).timecodes[0]!;
  const after = inspectMa2TimecodeXml(desired!).timecodes[0]!;
  expect(after.tracks).toEqual(before.tracks);
  expect(after.attributes).toEqual({ ...before.attributes, name: 'Updated', offset: '27000' });
  expect(result).toEqual({ name: 'Updated', startMs: 900000, backupFile: 'tblink_backup_test' });
});
it.each([{ expectedName: 'Stale' }, { expectedOffset: 1 }, { expectedSource: { ...source, generation: 'other' } }])('来源、名称或 MTC 变化不写入：%j', async change => {
  const bridge = fixture(); await expect(editMa2Timeline(bridge, { ...input, ...change })).rejects.toThrow(/变化|改变/);
  expect(bridge.exchange).not.toHaveBeenCalled();
});
it('回读内容不一致不报告成功；写入前发生并发修改也不覆盖', async () => {
  const bridge = fixture(); bridge.exchange.mockResolvedValueOnce({ requestId: 'test', response: native });
  await expect(editMa2Timeline(bridge, input)).rejects.toThrow('尚未确认');
  bridge.exchange.mockRejectedValueOnce(new Error('Timecode changed after preview'));
  await expect(editMa2Timeline(bridge, input)).rejects.toThrow('changed after preview');
});
