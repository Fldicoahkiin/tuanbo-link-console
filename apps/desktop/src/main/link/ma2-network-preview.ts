import { MA2_SONG_COLLISION } from '@tb/core/link';
import type { Ma2EffectLibrary, Ma2TimecodePreview } from '@tb/schema';
import { readMa2BridgeSource, type Ma2ShowSource } from './ma2-show-probe';
import type { Ma2OnpcBridge } from './ma2-onpc-bridge';
import { referencedMa2Sequences, sameMa2XmlObjects, type Ma2SequenceReport } from './ma2-timecode-xml';
import { convertMa2TimecodeReferences } from './ma2-timecode-conversion';

function verifyPreviewSource(actual: Ma2ShowSource, expected: Ma2ShowSource): void {
  if (actual.show !== expected.show || actual.generation !== expected.generation || actual.version !== expected.version) {
    throw new Error(`控台当前是「${actual.show}」，Show 或连接已变化，请核对当前节目`);
  }
}

/** Check the desk around a multi-step preview, including a Timecode with no Sequence references. */
export async function readMa2PreviewInShow<T>(bridge: Pick<Ma2OnpcBridge, 'request'>, expected: Ma2ShowSource, read: () => Promise<T>): Promise<T> {
  const verify = async (): Promise<void> => {
    verifyPreviewSource(await readMa2BridgeSource(bridge), expected);
  };
  await verify();
  const result = await read();
  if (result !== null) await verify();
  return result;
}

/** Reading Cue references must not transfer complete fixture/programmer data. */
export async function readMa2NetworkPreview(target: number, timeOriginMs: number, read: () => Promise<string>, library: (targets: readonly number[]) => Promise<Ma2EffectLibrary>, expectedSource?: Ma2ShowSource): Promise<Ma2TimecodePreview> {
  const xml = await read();
  const references = referencedMa2Sequences(xml);
  const reports: Ma2SequenceReport[] = [];
  if (references.length) {
    const metadata = await library(references);
    if (expectedSource) verifyPreviewSource(metadata.directory, expectedSource);
    const failure = metadata.errors[0];
    if (failure) throw new Error(`序列 ${failure.sequence} 的 Cue 没有读全：${failure.message}`);
    if (metadata.incomplete || metadata.sourceUnverified || references.some(number => !metadata.sequences.some(sequence => sequence.sequence === number))) {
      throw new Error('控台引用的 Cue 没有读全，请重新读取');
    }
    reports.push({ version: metadata.directory.version, sequences: metadata.sequences.map(sequence => ({ number: sequence.sequence, name: sequence.name, cues: sequence.cues })) });
  }
  if (!sameMa2XmlObjects(xml, await read())) throw new Error(`${MA2_SONG_COLLISION}：读取期间时间线发生变化，请重新读取`);
  return convertMa2TimecodeReferences(xml, reports, target, timeOriginMs);
}
