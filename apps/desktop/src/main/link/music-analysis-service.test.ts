import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile, unlink, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import type { MusicAnalysisProgress } from '@tb/schema';
import { MusicAnalysisService } from './music-analysis-service';

it('真实 FFmpeg 分析可取消、拒绝变更音源，重新启动只返回本次候选', async () => {
  const directory=join(process.env.TBLINK_TEST_OUTPUT ?? tmpdir(),`music-analysis-${randomUUID()}`);await mkdir(directory,{recursive:true});
  const path=join(directory,'pulses.wav');const rate=22050;const seconds=12;const wav=Buffer.alloc(44+rate*seconds*2);
  wav.write('RIFF');wav.writeUInt32LE(wav.length-8,4);wav.write('WAVEfmt ',8);wav.writeUInt32LE(16,16);wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22);wav.writeUInt32LE(rate,24);wav.writeUInt32LE(rate*2,28);wav.writeUInt16LE(2,32);wav.writeUInt16LE(16,34);wav.write('data',36);wav.writeUInt32LE(wav.length-44,40);
  for(let frame=0;frame<rate*seconds;frame++){const time=frame/rate;const phase=time%.5;const amplitude=time>=2 && time<10 && phase<.04 ? Math.sin(time*2*Math.PI*800)*.8:0;wav.writeInt16LE(Math.round(amplitude*32767),44+frame*2);}
  await writeFile(path,wav);const source={assetId:'test',relativePath:'pulses.wav',durationMs:seconds*1000,sha256:createHash('sha256').update(wav).digest('hex')};
  const progress:MusicAnalysisProgress[]=[];let cancelAtDecode=true;
  const service=new MusicAnalysisService({resolveReferenceAudio:()=>path},value=>{progress.push(value);if(value.phase==='decoding' && value.progress>.05 && cancelAtDecode){cancelAtDecode=false;service.cancel(value.taskId);}});
  try {
    const cancelled=randomUUID();await expect(service.analyze(cancelled,join(directory,'test.tblink'),source)).rejects.toThrow('取消');
    expect(progress.filter(value=>value.taskId===cancelled).at(-1)?.phase).toBe('cancelled');
    await expect(service.analyze(randomUUID(),join(directory,'test.tblink'),{...source,sha256:'0'.repeat(64)})).rejects.toThrow('音源已改变');
    const taskId=randomUUID();const result=await service.analyze(taskId,join(directory,'test.tblink'),source);
    expect(result.taskId).toBe(taskId);expect(result.sourceSha256).toBe(source.sha256);expect(result.bpm).toBeCloseTo(120,0);
    expect(result.candidates.some(value=>value.kind==='silence')).toBe(true);expect(progress.at(-1)?.phase).toBe('complete');
  } finally {service.close();await unlink(path);await rmdir(directory);}
},15000);
