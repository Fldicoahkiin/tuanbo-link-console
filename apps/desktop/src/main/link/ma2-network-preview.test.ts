import { readFile } from 'node:fs/promises';
import { expect, it, vi } from 'vitest';
import type { Ma2EffectLibrary } from '@tb/schema';
import { readMa2NetworkPreview } from './ma2-network-preview';
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
  read.mockResolvedValueOnce(xml).mockResolvedValueOnce(xml.replace('time="45"', 'time="46"'));
  await expect(readMa2NetworkPreview(9902, 0, read, library)).rejects.toThrow('发生变化');
});
