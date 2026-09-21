import { ma2EffectLibrarySchema, ma2ObjectDirectorySchema, type Ma2EffectLibrary } from '@tb/schema';
import type { Ma2OnpcBridge } from './ma2-onpc-bridge';
import { inspectMa2CueFixtures, inspectMa2SequenceXml } from './ma2-timecode-xml';

export async function readMa2EffectLibrary(bridge: Pick<Ma2OnpcBridge, 'request'>, isPlaying: () => boolean): Promise<Ma2EffectLibrary> {
  if (isPlaying()) throw new Error('请停止播放后读取效果库');
  const directory = ma2ObjectDirectorySchema.parse(JSON.parse(await bridge.request('LISTSEQ', 1)));
  const sequences: Ma2EffectLibrary['sequences'] = [];
  const errors: Ma2EffectLibrary['errors'] = [];
  const fixtureUsage: Ma2EffectLibrary['fixtureUsage'] = [];
  let count = 0;
  for (const entry of directory.entries) {
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
    if (count > 100000) throw new Error('Cue 超过十万个，扫描已停止');
  }
  const verified = ma2ObjectDirectorySchema.parse(JSON.parse(await bridge.request('LISTSEQ', 1)));
  if (isPlaying() || JSON.stringify(directory) !== JSON.stringify(verified)) throw new Error('播放、Show 或序列目录发生变化，请重新读取');
  return ma2EffectLibrarySchema.parse({ directory, sequences, fixtureUsage, errors, readAt: new Date().toISOString() });
}
