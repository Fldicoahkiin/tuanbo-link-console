import { expect, it, vi } from 'vitest';
import { readMa2NativeLibrary } from './ma2-native-library';
import type { Ma2OnpcBridge } from './ma2-onpc-bridge';
import type { Ma2Telnet } from './ma2-telnet';
import type { Ma2ReadProgressUpdate } from '@tb/schema';

const directory = { show: '实机工程', generation: '1', version: '3.3.4.3', entries: [{ target: 7, name: '灯光序列' }] };
function connection(replies: string[]): Pick<Ma2Telnet, 'command'> {
  return { command: vi.fn<Ma2Telnet['command']>((line, match) => {
    const prefix = /TBLINK_CUES_[a-f0-9]{32}:/.exec(line)?.[0];
    const response = match(`${prefix}${replies.shift()}\n`);
    if (response === null) throw new Error('测试响应无效');
    return Promise.resolve(response);
  }) };
}
it('轻量读取保留真实索引、小数 Cue 和中文名，明确灯具详情未读取', async () => {
  const row = `3;1,1.25,${Buffer.from('开场').toString('hex')};2,7.5,${Buffer.from('收尾').toString('hex')}`;
  const request = vi.fn<Ma2OnpcBridge['request']>().mockResolvedValue(JSON.stringify(directory));
  const library = await readMa2NativeLibrary(connection([row, row]), { request }, () => false);
  expect(library.sequences[0]?.cues).toEqual([{ index: 1, number: '1.250', name: '开场' }, { index: 2, number: '7.500', name: '收尾' }]);
  expect(library.fixtureDetails).toBe('unavailable');
  expect(request.mock.calls.map(call => call[0])).toEqual(['LISTSEQ', 'LISTSEQ']);
});
it('读取期间 Cue 改变时拒绝不一致列表', async () => {
  await expect(readMa2NativeLibrary(connection(['2;1,1,61', '2;1,2,61']), { request: vi.fn<Ma2OnpcBridge['request']>().mockResolvedValue(JSON.stringify(directory)) }, () => false)).rejects.toThrow('发生变化');
});
it('播放状态阻止发送任何素材读取命令', async () => {
  const peer = connection([]);
  await expect(readMa2NativeLibrary(peer, { request: vi.fn<Ma2OnpcBridge['request']>().mockResolvedValue(JSON.stringify(directory)) }, () => true)).rejects.toThrow('播放');
  expect(peer.command).not.toHaveBeenCalled();
});
it('每条序列经双读核对后立即报告，取消后不再读取下一条', async () => {
  const two = { ...directory, entries: [{ target: 7, name: '第一条' }, { target: 8, name: '第二条' }] };
  const request = vi.fn<Ma2OnpcBridge['request']>().mockResolvedValue(JSON.stringify(two));
  const peer = connection(['2;1,1,61', '2;1,1,61']);
  const controller = new AbortController();
  const updates: Ma2ReadProgressUpdate[] = [];
  await expect(readMa2NativeLibrary(peer, { request }, () => false, update => {
    updates.push(update);
    if (update.sequences?.length) controller.abort();
  }, 'library', controller.signal)).rejects.toThrow('已取消');
  expect(updates.find(update => update.sequences?.length)?.sequences?.[0]?.cues[0]?.name).toBe('a');
  expect(peer.command).toHaveBeenCalledTimes(2);
  expect(updates[0]).toMatchObject({ completed: 0, total: 3, show: '实机工程' });
});
