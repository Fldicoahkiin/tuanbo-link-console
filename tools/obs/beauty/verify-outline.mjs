import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fixtureMesh } from './fixture-mesh.mjs';

export async function verifyOutline({ call, screenshot, directory, PNG }) {
  const sourceName = 'Outline fixture', filterName = 'Outline probe';
  const positions = { 1: [.5,.51], 98: [.46,.52], 327: [.54,.52], 61: [.43,.66], 291: [.57,.66],
    0: [.5,.64], 17: [.5,.68], 13: [.5,.655], 14: [.5,.665], 152: [.5,.85], 10: [.5,.15],
    172: [.25,.7], 397: [.75,.7] };
  const markers = [[.25,.7],[.75,.7],[.2,.5],[.8,.5],[.5,.85],[.5,.15]];
  const image = new PNG({ width: 800, height: 800 });
  for (let y=0;y<800;y++) for(let x=0;x<800;x++) {
    const marked = markers.some(([u,v]) => Math.abs(x/800-u)<.009 && Math.abs(y/800-v)<.009);
    image.data.set(marked ? [255,0,255,255] : [160+(x%13),120+(y%11),90,255],(y*800+x)*4);
  }
  const path=join(directory,'outline-markers.png');
  await writeFile(path,PNG.sync.write(image));
  const face={cx:.5,cy:.5,rx:.4,ry:.4,lx:.4,ly:.4,ex:.6,ey:.4,smooth:0,white:0,slim:0,eye:0,
    ...fixtureMesh(positions,[.5,.5],[.4,.4,.6,.4])};
  const target={sourceName,filterName};
  await call('CreateInput',{sceneName:'Beauty',inputName:sourceName,inputKind:'image_source',inputSettings:{file:path},sceneItemEnabled:false});
  await call('CreateSourceFilter',{...target,filterKind:'tblink_beauty_prototype',filterSettings:{fixture_json:JSON.stringify({version:3,mode:'static-fixture',faces:[face]})}});
  const measure=pixels=>markers.map(([u,v])=>{
    let count=0,sx=0,sy=0;
    for(let y=Math.floor((v-.08)*800);y<(v+.08)*800;y++) for(let x=Math.floor((u-.08)*800);x<(u+.08)*800;x++) {
      const i=(y*800+x)*4;
      if(pixels.data[i]>220 && pixels.data[i+1]<35 && pixels.data[i+2]>220){count++;sx+=x;sy+=y;}
    }
    assert(count>0,'Outline marker disappeared');return [sx/count,sy/count];
  });
  const baseline=await screenshot('outline-neutral',sourceName), initial=measure(baseline), reports={};
  const neutral={jaw:0,cheek:0,chin:0,forehead:0};
  for(const key of Object.keys(neutral)) for(const value of (key==='jaw'||key==='cheek'?[1]:[-1,1])) {
    await call('SetSourceFilterSettings',{...target,filterSettings:{...neutral,[key]:value}});
    const pixels=await screenshot(`outline-${key}-${value}`,sourceName), points=measure(pixels);
    if(key==='jaw'||key==='cheek') {
      const i=key==='jaw'?0:2;
      assert(points[i+1][0]-points[i][0]<initial[i+1][0]-initial[i][0]-1,`${key} did not narrow`);
    } else {
      const i=key==='chin'?4:5, direction=value*(key==='chin'?1:-1);
      assert((points[i][1]-initial[i][1])*direction>.5,`${key} direction incorrect`);
    }
    for(let y=0;y<800;y++) for(let x=0;x<800;x++) {
      const u=x/800,v=y/800;
      const protectedArea=(u>.35&&u<.65&&v>.3&&v<.7)||((u-.5)**2+(v-.5)**2>.4**2*1.05);
      const i=(y*800+x)*4;
      assert.equal(pixels.data[i+3],baseline.data[i+3],'Outline changed alpha');
      if(protectedArea) for(let c=0;c<3;c++) assert.equal(pixels.data[i+c],baseline.data[i+c],`${key} affected protected pixel ${x},${y}`);
    }
    reports[`${key}:${value}`]=points;
  }
  await call('SetSourceFilterSettings',{...target,filterSettings:neutral});
  assert.deepEqual((await screenshot('outline-reset',sourceName)).data,baseline.data,'Outline reset differs');
  return reports;
}
