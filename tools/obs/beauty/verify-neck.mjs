import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';

export async function verifyNeck({call,screenshot,target,baseline,occlude}) {
  const measure=pixels=>[0,1].map(half=>{
    let sum=0,count=0;
    for(let y=0;y<180;y++)for(let x=half*400;x<(half+1)*400;x++){
      const i=(y*800+x)*4;
      if(pixels.data[i]<35&&pixels.data[i+1]>220&&pixels.data[i+2]<35){sum+=y;count++;}
    }
    assert(count>0,'Head marker disappeared');return sum/count;
  });
  await call('SetSourceFilterSettings',{...target,filterSettings:{neck:1}});
  const pixels=await screenshot('neck-extended',target.sourceName),original=measure(baseline),actual=measure(pixels);
  for(let i=0;i<2;i++)assert(actual[i]<original[i]-2,'Neck did not move head away from shoulders');
  for(let y=0;y<800;y++)for(let x=0;x<800;x++)if(y/800>.26||Math.abs(x/800-.5)<.08){
    const i=(y*800+x)*4;for(let c=0;c<4;c++)assert.equal(pixels.data[i+c],baseline.data[i+c],`Neck changed body/background ${x},${y}`);
  }
  await writeFile(occlude,'occluded');
  assert.deepEqual((await screenshot('neck-unavailable',target.sourceName)).data,baseline.data,'Unavailable head still warped');
  await call('SetSourceFilterSettings',{...target,filterSettings:{neck:0}});
  assert.deepEqual((await screenshot('neck-reset',target.sourceName)).data,baseline.data,'Neck reset differs');
  return {original,actual};
}
