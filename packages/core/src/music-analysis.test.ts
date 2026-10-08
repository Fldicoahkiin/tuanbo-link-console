import { expect, it } from 'vitest';
import { analyzeMusicEnvelope } from './music-analysis';
it('辅助找点只产生待确认候选；静音、规律拍点和滚奏分开标记', () => {
  const silence = analyzeMusicEnvelope(Array(500).fill(0),10000);
  expect(silence.bpm).toBeNull();expect(silence.candidates).toEqual([{id:'silence:0',kind:'silence',startMs:0,endMs:10000,strength:1}]);
  const pulse = Array.from({length:500},(_,index)=>index%25===0?.8:.01);
  const beats=analyzeMusicEnvelope(pulse,10000);expect(beats.bpm).toBe(120);expect(beats.candidates.filter(value=>value.kind==='beat')).toHaveLength(20);
  const roll=analyzeMusicEnvelope(Array.from({length:100},(_,index)=>index%5===0?.8:.01),2000);
  expect(roll.candidates.some(value=>value.kind==='roll'&&value.endMs!==null)).toBe(true);
  expect(new Set(roll.candidates.map(value=>value.id)).size).toBe(roll.candidates.length);
  expect(roll.candidates.every(value=>value.startMs>=0&&(value.endMs===null||value.endMs<=2000))).toBe(true);
});
