import { LightingTempoMap } from '@tb/core/link';
import type { LightingDocument } from '@tb/schema';
const choices = [[.25,'每四分之一拍'],[.5,'每半拍'],[1,'每拍'],[2,'每两拍'],[4,'每四拍'],[8,'每八拍'],[16,'每十六拍'],[32,'每三十二拍']] as const;
/** The duration describes the interval at the playhead, including tempo ramps. */
export function musicGridOptions(document: LightingDocument, positionMs: number): { value:number; label:string }[] {
  const map = new LightingTempoMap(document.tempos);
  const startMs = Math.max(0,positionMs - (document.music?.firstBeatMs ?? 0));
  const beat = map.msToBeat(startMs);
  const meter = document.tempos.filter(value=>value.beat<=beat).at(-1) ?? document.tempos[0]!;
  const barBeats = meter.numerator * 4 / meter.denominator;
  return choices.map(([value,name])=>{
    const step = value * (document.music?.triplet ? 1/3 : 1);
    const bars = step / barBeats;
    const barLabel = Number.isInteger(bars) && bars>=1 ? ` · ${bars} 小节` : '';
    const seconds = (map.beatToMs(beat + step) - startMs) / 1000;
    return {value,label:`${name}${document.music?.triplet ? '三连音' : ''}${barLabel} · ${seconds.toFixed(3)} 秒`};
  });
}
