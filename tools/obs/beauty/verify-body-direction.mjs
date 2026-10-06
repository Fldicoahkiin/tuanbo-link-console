import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { verifyLegs } from './verify-legs.mjs';
import { verifyNeck } from './verify-neck.mjs';

export async function verifyBodyDirection({work,root,directory,call,screenshot,PNG}) {
  const sourceName='Body direction fixture',filterName='Body direction probe',target={sourceName,filterName};
  const image=new PNG({width:800,height:800});
  for(let y=0;y<800;y++)for(let x=0;x<800;x++){
    const u=x/800,v=y/800;let color=[100+x%17,100+y%19,100,255];
    for(const center of [.25,.75])if(Math.abs(u-center)<.08){
      if(Math.abs(v-.46)<.007)color=[255,0,255,255];
      if(Math.abs(v-.49)<.007)color=[0,255,255,255];
      if(Math.abs(v-.25)<.007)color=[255,255,0,255];
    }
    if([.17,.33,.67,.83].some(center=>Math.abs(u-center)<.025)&&Math.abs(v-.8)<.012)color=[255,0,0,255];
    if([.25,.75].some(center=>Math.abs(u-center)<.025)&&Math.abs(v-.13)<.012)color=[0,255,0,255];
    image.data.set(color,(y*800+x)*4);
  }
  const path=join(directory,'body-direction.png');await writeFile(path,PNG.sync.write(image));
  await call('CreateInput',{sceneName:'Beauty',inputName:sourceName,inputKind:'image_source',inputSettings:{file:path},sceneItemEnabled:true});
  await call('CreateSourceFilter',{...target,filterKind:'tblink_beauty_prototype',filterSettings:{live_mode:true}});
  const settings=await call('GetSourceFilter',target),stop=join(directory,'stop-body-directions');
  const occlude=join(directory,'occlude-body-legs');
  const headOcclude=join(directory,'occlude-body-head');
  const child=spawn(join(work,'python/Scripts/python.exe'),[join(root,'tools/obs/beauty/feed-body.py'),'--channel',settings.filterSettings.transport_name,'--stop-file',stop,'--occlude-file',occlude,'--head-occlude-file',headOcclude],{windowsHide:true,stdio:['pipe','pipe','pipe']});
  let stderr='',stdout='',timer;
  child.stderr.on('data',chunk=>{stderr+=chunk;});child.stdout.on('data',chunk=>{stdout+=chunk;});
  const exit=new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve);});
  try {
    await Promise.race([new Promise(resolve=>child.stdout.on('data',()=>{if(stdout.includes('"ready": true'))resolve();})),
      exit.then(code=>{throw new Error(`Geometry writer ended: ${code} ${stderr}`);}),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Geometry writer not ready')),10000);})]);
    clearTimeout(timer);
    const baseline=await screenshot('body-direction-neutral',sourceName),reports={};
    const measure=(pixels,color,half)=>{
      let min=800,max=0,count=0;
      for(let y=0;y<800;y++)for(let x=half*400;x<(half+1)*400;x++){
        const i=(y*800+x)*4;
        if(color.every((value,c)=>value?pixels.data[i+c]>220:pixels.data[i+c]<35)){min=Math.min(min,x);max=Math.max(max,x);count++;}
      }
      assert(count>0,'Body marker disappeared');return max-min;
    };
    for(const [key,color] of [['bodySlim',[1,0,1]],['waist',[0,1,1]],['shoulder',[1,1,0]]])for(const strength of(key==='shoulder'?[-1,1]:[1])){
      await call('SetSourceFilterSettings',{...target,filterSettings:{bodySlim:0,waist:0,shoulder:0,[key]:strength}});
      const result=await screenshot(`body-direction-${key}-${strength}`,sourceName),widths=[];
      for(let person=0;person<2;person++){
        const original=measure(baseline,color,person),actual=measure(result,color,person);widths.push({original,actual});
        if(key==='shoulder'&&strength>0)assert(actual>original+1,'Shoulder expansion reversed');
        else assert(actual<original-1,`${key} did not narrow both people`);
      }
      for(let y=0;y<800;y++)for(let x=0;x<800;x++){
        if(y/800>.72||y/800<.12||Math.abs(x/800-.5)<.08){
          const i=(y*800+x)*4;for(let c=0;c<4;c++)assert.equal(result.data[i+c],baseline.data[i+c],`${key} moved protected pixel ${x},${y}`);
        }
      }
      reports[`${key}:${strength}`]=widths;
    }
    await call('SetSourceFilterSettings',{...target,filterSettings:{bodySlim:0,waist:0,shoulder:0}});
    assert.deepEqual((await screenshot('body-direction-reset',sourceName)).data,baseline.data,'Body reset differs');
    reports.legs=await verifyLegs({call,screenshot,target,baseline,occlude});
    reports.neck=await verifyNeck({call,screenshot,target,baseline,occlude:headOcclude});
    await call('SetSourceFilterSettings',{...target,filterSettings:{bodySlim:1,waist:1,shoulder:-1}});
    await writeFile(stop,'stop');assert.equal(await exit,0,stderr);
    await new Promise(resolve=>setTimeout(resolve,300));
    assert.deepEqual((await screenshot('body-direction-expired',sourceName)).data,baseline.data,'Expired body still warped');
    return reports;
  } finally {
    clearTimeout(timer);child.stdin.end();await writeFile(stop,'stop');
    await writeFile(join(directory,'body-direction-stderr.txt'),stderr);
  }
}
