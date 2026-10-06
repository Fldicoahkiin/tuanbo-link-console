import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fixtureMesh } from './fixture-mesh.mjs';

export async function verifyRetouch({ call, screenshot, directory, PNG }) {
  const sourceName='Retouch fixture',filterName='Retouch probe',target={sourceName,filterName};
  const positions={1:[.5,.51],98:[.46,.52],327:[.54,.52],61:[.43,.66],291:[.57,.66],
    0:[.5,.64],17:[.5,.68],13:[.5,.655],14:[.5,.665],152:[.5,.85],10:[.5,.15]};
  const face={cx:.5,cy:.5,rx:.4,ry:.4,lx:.4,ly:.4,ex:.6,ey:.4,smooth:0,white:0,slim:0,eye:0,
    ...fixtureMesh(positions,[.5,.5],[.4,.4,.6,.4])};
  const image=new PNG({width:800,height:800});
  for(let y=0;y<800;y++) for(let x=0;x<800;x++) {
    const u=x/800,v=y/800;
    const under=(Math.abs(u-.4)<.06||Math.abs(u-.6)<.06)&&Math.abs(v-.4455)<.012;
    const t=(v-.52)/.15365,foldX=.46+(.402-.46)*t;
    const fold=t>0&&t<1&&(Math.abs(u-foldX)<.006||Math.abs(u-(1-foldX))<.006);
    const shade=under||fold?35:0,texture=(x%3===0?2:0);
    image.data.set([195-shade+texture,145-shade+texture,110-shade+texture,255],(y*800+x)*4);
  }
  const path=join(directory,'retouch-markers.png');await writeFile(path,PNG.sync.write(image));
  await call('CreateInput',{sceneName:'Beauty',inputName:sourceName,inputKind:'image_source',inputSettings:{file:path},sceneItemEnabled:false});
  await call('CreateSourceFilter',{...target,filterKind:'tblink_beauty_prototype',filterSettings:{fixture_json:JSON.stringify({version:3,mode:'static-fixture',faces:[face]})}});
  const baseline=await screenshot('retouch-neutral',sourceName),reports={};
  for(const key of ['darkCircles','nasolabial']) {
    await call('SetSourceFilterSettings',{...target,filterSettings:{darkCircles:0,nasolabial:0,[key]:1}});
    const pixels=await screenshot(`retouch-${key}`,sourceName);let lifted=0,total=0,protectedCount=0;
    for(let y=0;y<800;y++) for(let x=0;x<800;x++) {
      const i=(y*800+x)*4,u=x/800,v=y/800;
      const delta=pixels.data[i]-baseline.data[i];assert(delta>=0,'Repair darkened source');
      if(delta>0){lifted++;total+=delta;}
      assert.equal(pixels.data[i+3],baseline.data[i+3],'Repair changed alpha');
      const eyes=(Math.abs(u-.4)<.02||Math.abs(u-.6)<.02)&&Math.abs(v-.4)<.012;
      const mouth=Math.abs(u-.5)<.07&&Math.abs(v-.66)<.02;
      const outside=(u-.5)**2+(v-.5)**2>.4**2;
      if(eyes||mouth||outside){protectedCount++;for(let c=0;c<3;c++)assert.equal(pixels.data[i+c],baseline.data[i+c],`${key} changed protected pixel ${x},${y}`);}
      if(delta>0) assert(Math.abs((pixels.data[i]-pixels.data[i+1])-(baseline.data[i]-baseline.data[i+1]))<=1,'Repair changed chroma');
    }
    assert(lifted>100 && total>100,`${key} did not lift marked shadows`);
    reports[key]={lifted,total,protectedCount};
  }
  await call('SetSourceFilterSettings',{...target,filterSettings:{darkCircles:0,nasolabial:0}});
  assert.deepEqual((await screenshot('retouch-reset',sourceName)).data,baseline.data,'Repair reset differs');
  return reports;
}
