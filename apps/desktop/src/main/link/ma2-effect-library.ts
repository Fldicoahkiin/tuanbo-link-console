import { ma2EffectLibrarySchema, ma2ObjectDirectorySchema, type Ma2EffectLibrary, type Ma2ReadProgressUpdate } from '@tb/schema';
import type { Ma2OnpcBridge } from './ma2-onpc-bridge';
import { inspectMa2CueFixtures, inspectMa2SequenceXml } from './ma2-timecode-xml';

export async function readMa2EffectLibrary(bridge: Pick<Ma2OnpcBridge, 'request'>, isPlaying: () => boolean, onProgress?: (progress: Ma2ReadProgressUpdate) => void, signal?: AbortSignal): Promise<Ma2EffectLibrary> {
  if (signal?.aborted) throw new Error('素材读取已取消');
  if (isPlaying()) throw new Error('请停止播放后读取效果库');
  const directory = ma2ObjectDirectorySchema.parse(JSON.parse(await bridge.request('LISTSEQ', 1)));
  if (signal?.aborted) throw new Error('素材读取已取消');
  onProgress?.({ phase: 'library', completed: 0, total: directory.entries.length + 1, detail: '读取序列与 Cue', show: directory.show });
  const sequences: Ma2EffectLibrary['sequences'] = [];
  const errors: Ma2EffectLibrary['errors'] = [];
  const fixtureUsage: Ma2EffectLibrary['fixtureUsage'] = [];
  let count = 0;
  for (const entry of directory.entries) {
    if (signal?.aborted) throw new Error('素材读取已取消');
    if (isPlaying()) throw new Error('播放已开始，效果库扫描已停止');
    try {
      const xml = await bridge.request('SEQUENCE', entry.target);
      const report = inspectMa2SequenceXml(xml);
      const sequence = report.sequences[0];
      if (!sequence || report.sequences.length !== 1 || sequence.number !== entry.target) throw new Error('Sequence 与扫描目录不一致');
      count += sequence.cues.length;
      sequences.push({ sequence: sequence.number, name: sequence.name, cues: sequence.cues });
      fixtureUsage.push(...inspectMa2CueFixtures(xml));
    } catch (error) { errors.push({ sequence: entry.target, message: error instanceof Error ? error.message : String(error) }); }
    if (signal?.aborted) throw new Error('素材读取已取消');
    onProgress?.({ phase: 'library', completed: sequences.length + errors.length, total: directory.entries.length + 1, detail: `已读取序列 ${entry.target}`, sequences: sequences.at(-1)?.sequence === entry.target ? [sequences.at(-1)!] : [] });
    if (count > 100000) throw new Error('Cue 超过十万个，扫描已停止');
  }
  onProgress?.({ phase: 'library', completed: directory.entries.length, total: directory.entries.length + 1, detail: '核对控台序列目录' });
  const verified = ma2ObjectDirectorySchema.parse(JSON.parse(await bridge.request('LISTSEQ', 1)));
  if (signal?.aborted) throw new Error('素材读取已取消');
  if (isPlaying() || JSON.stringify(directory) !== JSON.stringify(verified)) throw new Error('播放、Show 或序列目录发生变化，请重新读取');
  const result = ma2EffectLibrarySchema.parse({ directory, sequences, fixtureUsage, errors, readAt: new Date().toISOString() });
  onProgress?.({ phase: 'library', completed: directory.entries.length + 1, total: directory.entries.length + 1, detail: '序列目录已核对' });
  return result;
}
