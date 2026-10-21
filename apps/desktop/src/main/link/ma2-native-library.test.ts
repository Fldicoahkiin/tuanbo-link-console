import { expect, it, vi } from 'vitest';
import { readMa2NativeLibrary, readNativeCueChunks } from './ma2-native-library';
import type { Ma2OnpcBridge } from './ma2-onpc-bridge';
import type { Ma2Telnet } from './ma2-telnet';
import type { Ma2ReadProgressUpdate } from '@tb/schema';

const directory = { show: '实机工程', generation: '1', version: '3.3.4.3', entries: [{ target: 7, name: '灯光序列 7 7' }] };
function connection(replies: string[]): Pick<Ma2Telnet, 'command'> {
  return { command: vi.fn<Ma2Telnet['command']>((line, match) => {
    const prefix = /TBLINK_CUES_[a-f0-9]{32}:/.exec(line)?.[0];
    const reply = replies.shift();
    if (!reply) throw new Error('缺少测试响应');
    const lines = reply.match(/.{1,700}/g)?.map((chunk, index) => `${prefix}${index * 700 + 1}:${chunk}\n`).join('');
    const response = match(`${lines}${prefix}END:${reply.length}\n`);
    if (response === null) throw new Error('测试响应无效');
    return Promise.resolve(response);
  }) };
}
it('轻量读取保留真实索引、小数 Cue 和中文名，明确灯具详情未读取', async () => {
  const row = `3;${Buffer.from('灯光序列 7').toString('hex')};1,1.25,${Buffer.from('开场').toString('hex')};2,7.5,${Buffer.from('收尾').toString('hex')}`;
  const request = vi.fn<Ma2OnpcBridge['request']>().mockResolvedValue(JSON.stringify(directory));
  const library = await readMa2NativeLibrary(connection([row, row]), { request }, () => false);
  expect(library.sequences[0]?.cues).toEqual([{ index: 1, number: '1.250', name: '开场' }, { index: 2, number: '7.500', name: '收尾' }]);
  expect(library.sequences[0]?.name).toBe('灯光序列 7');
  expect(library.fixtureDetails).toBe('unavailable');
  expect(request.mock.calls.map(call => call[0])).toEqual(['LISTSEQ', 'LISTSEQ']);
});

it('分段读取超过控台单行长度的中文名称，保留全部 100 个 Cue', async () => {
  const replies: string[] = [];
  for (let offset = 0; offset < 101; offset += 32) {
    const rows = Array.from({ length: Math.min(32, 101 - offset) }, (_, index) => offset + index)
      .filter(index => index > 0).map(index => `${index},${index},${Buffer.from(`${index} 暖场灯光测试`).toString('hex')}`);
    const reply = `101;;${rows.join(';')}`;
    replies.push(reply, reply);
  }
  const result = await readMa2NativeLibrary(connection(replies), { request: vi.fn<Ma2OnpcBridge['request']>().mockResolvedValue(JSON.stringify({ ...directory, version: '3.7.0.5' })) }, () => false);
  expect(result.errors).toEqual([]);
  expect(result.sequences[0]?.cues).toHaveLength(100);
  expect(result.sequences[0]?.cues.at(-1)).toEqual({ index: 100, number: '100.000', name: '100 暖场灯光测试' });
});

it('收到结束标记前等待，截断或缺失分段不能冒充完整目录', () => {
  expect(readNativeCueChunks('TBLINK_TEST:1:abc\n', 'TBLINK_TEST:')).toBeNull();
  expect(() => readNativeCueChunks('TBLINK_TEST:1:abc\nTBLINK_TEST:END:4\n', 'TBLINK_TEST:')).toThrow('传输不完整');
  expect(() => readNativeCueChunks('TBLINK_TEST:END:701\n', 'TBLINK_TEST:')).toThrow('传输不完整');
});
it('读取期间 Cue 改变时拒绝不一致列表', async () => {
  const result = await readMa2NativeLibrary(connection(['2;;1,1,61', '2;;1,2,61']), { request: vi.fn<Ma2OnpcBridge['request']>().mockResolvedValue(JSON.stringify(directory)) }, () => false);
  expect(result.sequences).toEqual([]);
  expect(result.errors).toHaveLength(1);
  expect(result.errors[0]?.sequence).toBe(7);
  expect(result.errors[0]?.message).toContain('发生变化');
});
it('播放状态阻止发送任何素材读取命令', async () => {
  const peer = connection([]);
  await expect(readMa2NativeLibrary(peer, { request: vi.fn<Ma2OnpcBridge['request']>().mockResolvedValue(JSON.stringify(directory)) }, () => true)).rejects.toThrow('播放');
  expect(peer.command).not.toHaveBeenCalled();
});
it('一条序列损坏保留错误并继续其他序列，不把整个素材库清空', async () => {
  const two = { ...directory, entries: [...directory.entries, { target: 8, name: '可用序列' }] };
  const updates: Ma2ReadProgressUpdate[] = [];
  const result = await readMa2NativeLibrary(connection(['missing', 'missing', '2;;1,1.1,61', '2;;1,1.1,61']), { request: vi.fn<Ma2OnpcBridge['request']>().mockResolvedValue(JSON.stringify(two)) }, () => false, update => { updates.push(update); });
  expect(result.sequences[0]?.sequence).toBe(8);
  expect(result.sequences[0]?.cues[0]?.number).toBe('1.100');
  expect(result.errors[0]?.sequence).toBe(7);
  expect(updates.find(update => update.libraryError)?.libraryError?.sequence).toBe(7);
});
it('读取指定引用时不查询其他序列，不传输灯具数据', async () => {
  const request = vi.fn<Ma2OnpcBridge['request']>().mockResolvedValue(JSON.stringify({ ...directory, entries: [...directory.entries, { target: 8, name: '无关序列' }] }));
  const peer = connection(['2;;1,1,61', '2;;1,1,61']);
  const result = await readMa2NativeLibrary(peer, { request }, () => false, undefined, 'library', undefined, [7]);
  expect(result.sequences.map(entry => entry.sequence)).toEqual([7]); expect(peer.command).toHaveBeenCalledTimes(2);
  expect(request.mock.calls.every(call => call[0] === 'LISTSEQ')).toBe(true);
});
it('每条序列经双读核对后立即报告，取消后不再读取下一条', async () => {
  const two = { ...directory, entries: [{ target: 7, name: '第一条' }, { target: 8, name: '第二条' }] };
  const request = vi.fn<Ma2OnpcBridge['request']>().mockResolvedValue(JSON.stringify(two));
  const peer = connection(['2;;1,1,61', '2;;1,1,61']);
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

it('序列标签跨分页改变时拒绝混合快照，不截掉名称本身的数字', async () => {
  const oldPage = `33;${Buffer.from('灯光 2026').toString('hex')};1,1,61`;
  const changedPage = `33;${Buffer.from('灯光 2027').toString('hex')};32,32,62`;
  const result = await readMa2NativeLibrary(connection([oldPage, oldPage, changedPage, changedPage]), { request: vi.fn<Ma2OnpcBridge['request']>().mockResolvedValue(JSON.stringify(directory)) }, () => false);
  expect(result.sequences).toEqual([]);
  expect(result.errors[0]?.message).toContain('序列名称发生变化');
});

it('最终复核时开始播放与目录真的变化分别报告，不把播放误报成控台改动', async () => {
  const row = `1;${Buffer.from('灯光序列 7').toString('hex')};1,1,${Buffer.from('开场').toString('hex')}`;
  let playing = false;
  const request = vi.fn<Ma2OnpcBridge['request']>().mockImplementation(() => Promise.resolve(JSON.stringify(directory)));
  request.mockImplementationOnce(() => Promise.resolve(JSON.stringify(directory))).mockImplementationOnce(() => { playing = true; return Promise.resolve(JSON.stringify(directory)); });
  await expect(readMa2NativeLibrary(connection([row, row]), { request }, () => playing)).rejects.toThrow('播放已开始，素材核对已停止');
  const changed = vi.fn<Ma2OnpcBridge['request']>().mockResolvedValueOnce(JSON.stringify(directory)).mockResolvedValueOnce(JSON.stringify({ ...directory, entries: [...directory.entries, { target: 8, name: '新序列' }] }));
  await expect(readMa2NativeLibrary(connection([row, row]), { request: changed }, () => false)).rejects.toThrow('控台工程或序列目录发生变化');
});
