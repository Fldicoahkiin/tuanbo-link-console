import type { MidiEvent } from 'midi-file';
import { z } from 'zod';
import { lightingTempoSchema, type LightingTempo } from '@tb/schema';
import { LightingTempoMap } from './lighting-edit';

type Timed = { tick: number; event: MidiEvent };
const prefix = [0x7d, ...new TextEncoder().encode('TBLINK:TEMPO:')];
const metadataSchema = z.object({ version: z.literal(1), tempos: z.array(lightingTempoSchema).min(1), standard: z.string() }).strict();
// SMF stores whole microseconds. Preserve the original model in metadata
// whenever nearest-integer encoding cannot represent its BPM exactly.
function encodeTempo(bpm: number): number {
  return Math.round(60000000 / bpm);
}

export function isLightingTempoMetadata(event: MidiEvent): boolean {
  return event.type === 'sequencerSpecific' && prefix.every((byte, index) => event.data[index] === byte);
}
function signature(events: Array<{ beat: number; event: MidiEvent }>): string {
  return JSON.stringify(events.flatMap(({ beat, event }) => event.type === 'setTempo' ? [[beat, 't', event.microsecondsPerBeat]] : event.type === 'timeSignature' ? [[beat, 's', event.numerator, event.denominator]] : []));
}
export function restoreLightingMidiTempo(events: Array<{ beat: number; event: MidiEvent }>, standard: LightingTempo[], warnings: Set<string>): LightingTempo[] {
  const metadata = events.filter(({ event }) => isLightingTempoMetadata(event));
  if (!metadata.length) return standard;
  if (metadata.length !== 1 || metadata[0]?.beat !== 0) throw new Error('MIDI 连续变速扩展重复或位置无效');
  const event = metadata[0].event;
  if (event.type !== 'sequencerSpecific') throw new Error('MIDI 连续变速扩展类型无效');
  let decoded: z.infer<typeof metadataSchema>;
  try { decoded = metadataSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(Array.from(event.data).slice(prefix.length))))); }
  catch { throw new Error('MIDI 连续变速扩展损坏或版本不支持'); }
  // A DAW may edit the standard tempo events while retaining unknown metadata.
  // Never overwrite those edits with our now-stale original ramp model.
  if (decoded.standard !== signature(events)) { warnings.add('标准 MIDI 节拍图已被修改，按文件中的新节拍图导入'); return standard; }
  new LightingTempoMap(decoded.tempos);
  return decoded.tempos;
}

export function lightingMidiConductor(tempos: LightingTempo[], ppq: number): Timed[] {
  const map = new LightingTempoMap(tempos);
  const hasRamps = tempos.some((tempo, index) => tempo.transition === 'linear' && tempos[index + 1] && tempos[index + 1]!.bpm !== tempo.bpm);
  const result: Timed[] = [];
  if (!hasRamps) {
    for (const tempo of tempos) result.push({ tick: Math.round(tempo.beat * ppq), event: { deltaTime: 0, type: 'setTempo', microsecondsPerBeat: encodeTempo(tempo.bpm) } });
  } else {
    const ticks = [...new Set(tempos.map((tempo) => Math.round(tempo.beat * ppq)))];
    let renderedMs = 0;
    const appendInterval = (left: number, right: number): void => {
      const startMs = map.beatToMs(left / ppq); const endMs = map.beatToMs(right / ppq);
      const width = right - left;
      // Bound interpolation on the integer tick grid; one tick is the smallest
      // interval SMF can express. Sample each quarter to catch tempo boundaries.
      const error = Math.max(...[0.25, 0.5, 0.75].map((t) => Math.abs(map.beatToMs((left + width * t) / ppq) - (startMs + (endMs - startMs) * t))));
      if (width > 1 && error > 0.01) {
        const middle = Math.floor((left + right) / 2);
        appendInterval(left, middle); appendInterval(middle, right); return;
      }
      if (result.length >= 200000) throw new Error('连续变速 MIDI 超过 20 万变速事件，请缩短节目后导出');
      // Compensate previous microsecond rounding at each boundary, preventing
      // a long ramp from accumulating error across thousands of tempo events.
      const microsecondsPerBeat = Math.round((endMs - renderedMs) * 1000 * ppq / width);
      if (microsecondsPerBeat < 1 || microsecondsPerBeat > 0xffffff) throw new Error('连续变速超出 MIDI 节拍表示范围');
      result.push({ tick: left, event: { deltaTime: 0, type: 'setTempo', microsecondsPerBeat } });
      renderedMs += width * microsecondsPerBeat / ppq / 1000;
    };
    for (let index = 0; index + 1 < ticks.length; index += 1) appendInterval(ticks[index]!, ticks[index + 1]!);
    const last = ticks.at(-1) ?? 0;
    result.push({ tick: last, event: { deltaTime: 0, type: 'setTempo', microsecondsPerBeat: encodeTempo(tempos.at(-1)!.bpm) } });
  }
  for (const tempo of tempos) result.push({ tick: Math.round(tempo.beat * ppq), event: { deltaTime: 0, type: 'timeSignature', numerator: tempo.numerator, denominator: tempo.denominator, metronome: 24, thirtyseconds: 8 } });
  result.sort((a, b) => a.tick - b.tick);
  const needsMetadata = hasRamps || tempos.some((tempo) =>
    60000000 / encodeTempo(tempo.bpm) !== tempo.bpm ||
    Math.round(tempo.beat * ppq) / ppq !== tempo.beat || tempo.transition !== undefined);
  if (needsMetadata) {
    const standard = signature(result.map(({ tick, event }) => ({ beat: tick / ppq, event })));
    result.push({ tick: 0, event: { deltaTime: 0, type: 'sequencerSpecific', data: [...prefix, ...new TextEncoder().encode(JSON.stringify({ version: 1, tempos, standard }))] } });
  }
  return result;
}
