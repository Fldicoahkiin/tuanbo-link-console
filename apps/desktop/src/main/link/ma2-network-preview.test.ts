import { readFile } from 'node:fs/promises';
import { expect, it, vi } from 'vitest';
import type { Ma2EffectLibrary } from '@tb/schema';
import { readMa2NetworkPreview, readMa2PreviewInShow } from './ma2-network-preview';
import { inspectMa2SequenceXml } from './ma2-timecode-xml';

it('网络预览仅请求引用序列的目录，保留小数 Cue，并拒绝读取期间改变的时间线', async () => {
  const xml = await readFile(new URL('./fixtures/ma2-timecode-fractional-3.3.xml', import.meta.url), 'utf8');
  const sequence = inspectMa2SequenceXml(await readFile(new URL('./fixtures/ma2-sequence-fractional-3.3.xml', import.meta.url), 'utf8'));
  const metadata: Ma2EffectLibrary = { directory: { show: 'test', version: '3.3.4.3', generation: '1', entries: [{ target: 9901, name: 'test' }] }, readAt: new Date().toISOString(), sequences: sequence.sequences.map(entry => ({ sequence: entry.number, name: entry.name ?? '', cues: entry.cues })), fixtureUsage: [], fixtureDetails: 'unavailable', errors: [] };
  const library = vi.fn(() => Promise.resolve(metadata));
  const read = vi.fn(() => Promise.resolve(xml));
  const result = await readMa2NetworkPreview(9902, 0, read, library);
  expect(library).toHaveBeenCalledWith([9901]); expect(read).toHaveBeenCalledTimes(2);
  expect(result.unconverted).toEqual([]);
  expect(result.document.tracks.flatMap(track => track.clips.flatMap(clip => clip.events.map(event => event.kind === 'ma2' ? event.cue : '')))).toEqual(['1.250', '7.500']);
  library.mockResolvedValueOnce({ ...metadata, errors: [{ sequence: 9901, message: '步骤数量已改变' }], sequences: [] });
  await expect(readMa2NetworkPreview(9902, 0, read, library)).rejects.toThrow('序列 9901 的 Cue 没有读全');
  read.mockResolvedValueOnce(xml).mockResolvedValueOnce(xml.replace('time="45"', 'time="46"'));
  await expect(readMa2NetworkPreview(9902, 0, read, library)).rejects.toThrow('发生变化');
});

it('原生时间线内容相同，已换 Show 的读回不能确认之前的修改', async () => {
  const source = { show: '原节目', generation: '1', version: '3.7.0.5' };
  const directory = (show: string) => JSON.stringify({ ...source, show, entries: [] });
  const request = vi.fn().mockResolvedValueOnce(directory('另一个 Show'));
  const read = vi.fn(() => Promise.resolve('相同的时间线'));
  await expect(readMa2PreviewInShow({ request }, source, read)).rejects.toThrow('另一个 Show');
  expect(read).not.toHaveBeenCalled();
  request.mockResolvedValueOnce(directory(source.show)).mockResolvedValueOnce(directory('读到一半切换'));
  await expect(readMa2PreviewInShow({ request }, source, read)).rejects.toThrow('读到一半切换');
  expect(read).toHaveBeenCalledOnce();
  expect(request.mock.calls).toEqual(Array.from({ length: 3 }, () => ['LISTSEQ', 1, '0']));
});
