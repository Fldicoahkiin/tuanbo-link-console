import type { Ma2EffectLibrary, Ma2TimecodePreview } from '@tb/schema';
import { referencedMa2Sequences, sameMa2XmlObjects } from './ma2-timecode-xml';
import { convertMa2TimecodeReferences } from './ma2-timecode-conversion';

/** Reading Cue references must not transfer complete fixture/programmer data. */
export async function readMa2NetworkPreview(target: number, timeOriginMs: number, read: () => Promise<string>, library: (targets: readonly number[]) => Promise<Ma2EffectLibrary>): Promise<Ma2TimecodePreview> {
  const xml = await read();
  const metadata = await library(referencedMa2Sequences(xml));
  if (!sameMa2XmlObjects(xml, await read())) throw new Error('读取期间时间线发生变化，请重新读取');
  return convertMa2TimecodeReferences(xml, [{ version: metadata.directory.version, sequences: metadata.sequences.map(sequence => ({ number: sequence.sequence, name: sequence.name, cues: sequence.cues })) }], target, timeOriginMs);
}
