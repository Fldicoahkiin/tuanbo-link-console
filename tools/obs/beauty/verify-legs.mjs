import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';

export async function verifyLegs({call,screenshot,target,baseline,occlude}) {
  const neutral={bodySlim:0,waist:0,shoulder:0,legSlim:0,legLength:0};
  const measure=pixels=>[.17,.33,.67,.83].map(center=>{
    let min=800,max=0,sy=0,count=0;
    for(let y=570;y<780;y++)for(let x=Math.floor((center-.065)*800);x<(center+.065)*800;x++){
      const i=(y*800+x)*4;
      if(pixels.data[i]>220&&pixels.data[i+1]<35&&pixels.data[i+2]<35){min=Math.min(min,x);max=Math.max(max,x);sy+=y;count++;}
    }
    assert(count>0,'Leg marker disappeared');return {width:max-min,y:sy/count};
  });
  const original=measure(baseline),reports={};
  for(const key of ['legSlim','legLength']){
    await call('SetSourceFilterSettings',{...target,filterSettings:{...neutral,[key]:1}});
    const pixels=await screenshot(`legs-${key}`,target.sourceName),actual=measure(pixels);
    for(let i=0;i<4;i++){
      if(key==='legSlim')assert(actual[i].width<original[i].width-1,'Leg did not narrow');
      else assert(actual[i].y>original[i].y+2,'Leg did not lengthen away from hip');
    }
    for(let y=0;y<800;y++)for(let x=0;x<800;x++)if(y/800<.58||Math.abs(x/800-.5)<.08){
      const i=(y*800+x)*4;for(let c=0;c<4;c++)assert.equal(pixels.data[i+c],baseline.data[i+c],`${key} moved protected pixel ${x},${y}`);
    }
    reports[key]={original,actual};
  }
  await writeFile(occlude,'occluded');
  await call('SetSourceFilterSettings',{...target,filterSettings:{...neutral,legSlim:1,legLength:1}});
  assert.deepEqual((await screenshot('legs-unavailable',target.sourceName)).data,baseline.data,'Unavailable legs still warped');
  await call('SetSourceFilterSettings',{...target,filterSettings:neutral});
  assert.deepEqual((await screenshot('legs-reset',target.sourceName)).data,baseline.data,'Leg reset differs');
  return reports;
}
