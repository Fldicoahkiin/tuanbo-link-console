import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fixtureMesh } from './fixture-mesh.mjs';

export async function verifyBlemish({ call, screenshot, directory, PNG }) {
  const sourceName = 'Blemish fixture', filterName = 'Blemish probe', target = { sourceName, filterName };
  const positions = {1:[.5,.51],98:[.46,.52],327:[.54,.52],61:[.43,.66],291:[.57,.66],
    0:[.5,.64],17:[.5,.68],13:[.5,.655],14:[.5,.665],152:[.5,.85],10:[.5,.15]};
  const face = {cx:.5,cy:.5,rx:.4,ry:.4,lx:.4,ly:.4,ex:.6,ey:.4,smooth:0,white:0,slim:0,eye:0,
    ...fixtureMesh(positions,[.5,.5],[.4,.4,.6,.4])};
  const spots = [[280,440],[520,440],[300,490],[500,490]];
  const protectedSpots = [[320,320],[480,320],[400,528],[30,30]];
  const image = new PNG({width:800,height:800});
  for (let y=0;y<800;y++) for (let x=0;x<800;x++) {
    const spot = [...spots,...protectedSpots].some(([sx,sy]) => (x-sx)**2+(y-sy)**2 <= 4);
    const wrinkle = x>=275 && x<=320 && Math.abs(y-470)<=1;
    const edge = x>=485 && x<=535 && y>=460 && y<=475;
    const shade = spot || wrinkle || edge ? 35 : 0;
    const texture = x%3===0 ? 2 : 0;
    image.data.set([195-shade+texture,145-shade+texture,110-shade+texture,255],(y*800+x)*4);
  }
  const path=join(directory,'blemish-markers.png'); await writeFile(path,PNG.sync.write(image));
  await call('CreateInput',{sceneName:'Beauty',inputName:sourceName,inputKind:'image_source',inputSettings:{file:path},sceneItemEnabled:false});
  await call('CreateSourceFilter',{...target,filterKind:'tblink_beauty_prototype',filterSettings:{fixture_json:JSON.stringify({version:3,mode:'static-fixture',faces:[face]})}});
  const baseline=await screenshot('blemish-neutral',sourceName), reports={};
  let previous=0;
  for(const strength of [.5,1]) {
    await call('SetSourceFilterSettings',{...target,filterSettings:{blemish:strength}});
    const pixels=await screenshot(`blemish-${strength}`,sourceName);
    let lifted=0, protectedCount=0, changed=0;
    for(let y=0;y<800;y++) for(let x=0;x<800;x++) {
      const i=(y*800+x)*4;
      assert.equal(pixels.data[i+3],baseline.data[i+3],'Blemish changed alpha');
      const nearSpot=spots.some(([sx,sy])=>(x-sx)**2+(y-sy)**2<=16);
      for(let c=0;c<3;c++) {
        const delta=pixels.data[i+c]-baseline.data[i+c];
        if(nearSpot) { assert(delta>=0,'Blemish darkened spot'); lifted+=delta; }
        else {assert.equal(delta,0,`Blemish changed texture, edge or protected pixel ${x},${y}`);protectedCount++;}
        if(delta!==0) changed++;
      }
    }
    assert(lifted>previous && changed>0,'Blemish strength did not progressively reduce spots');
    for(const [x,y] of spots) assert(pixels.data[(y*800+x)*4]>baseline.data[(y*800+x)*4]+3,'Spot center unchanged');
    previous=lifted;reports[strength]={lifted,changed,protectedCount};
  }
  await call('SetSourceFilterSettings',{...target,filterSettings:{blemish:0}});
  assert.deepEqual((await screenshot('blemish-reset',sourceName)).data,baseline.data,'Blemish reset differs');
  return reports;
}
