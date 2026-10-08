import { describe,expect,it } from 'vitest';
import { createLightingDocument,createLightingMusic } from '@tb/schema';
import { musicGridOptions } from './music-grid-options';
describe('music grid option labels',()=>{
  it('shows all eight requested durations at 128 BPM and 4/4',()=>{
    const doc=createLightingDocument();
    expect(musicGridOptions(doc,0).map(value=>value.label)).toEqual(['每四分之一拍 · 0.117 秒','每半拍 · 0.234 秒','每拍 · 0.469 秒','每两拍 · 0.938 秒','每四拍 · 1 小节 · 1.875 秒','每八拍 · 2 小节 · 3.750 秒','每十六拍 · 4 小节 · 7.500 秒','每三十二拍 · 8 小节 · 15.000 秒']);
  });
  it('uses the actual meter, tempo and first-beat origin',()=>{
    const doc=createLightingDocument();doc.tempos[0]!.bpm=120;doc.tempos[0]!.numerator=3;doc.tempos[0]!.denominator=8;doc.music={...createLightingMusic(),firstBeatMs:10000};
    expect(musicGridOptions(doc,10000)[4]!.label).toBe('每四拍 · 2.000 秒');
    doc.music.triplet=true;expect(musicGridOptions(doc,10000)[2]!.label).toBe('每拍三连音 · 0.167 秒');
    expect(doc.music.firstBeatMs).toBe(10000);
  });
});
