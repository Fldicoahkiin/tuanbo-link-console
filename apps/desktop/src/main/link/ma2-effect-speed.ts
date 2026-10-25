/**
 * Sets the effect speed of whole Cue steps in a song Sequence export: afterwards every effect in each
 * listed Cue runs at that Cue's BPM, and nothing else in the export changes.
 *
 * Where a console export keeps effect speeds has not been checked against a real export with
 * effects yet, so a request that sets a speed is refused instead of written from a guess. The
 * refusal comes while the sync composes the Sequence, before anything is sent to the console.
 */
export function setMa2CueEffectSpeeds(sequenceXml: string, speeds: ReadonlyMap<string, number>): string {
  if (!speeds.size) return sequenceXml;
  throw new Error(`效果速度还不能写入控台：控台导出里效果速度的写法尚未用真实数据核实（Cue ${[...speeds.keys()].map(Number).join('、')}）；本曲未写入`);
}
