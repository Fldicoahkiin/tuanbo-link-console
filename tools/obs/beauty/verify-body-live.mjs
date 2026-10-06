import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export async function verifyBodyLive({ work, resources = work, root, directory, call, screenshot, difference }) {
  const durationArgument=process.argv.find(argument=>argument.startsWith('--body-seconds='));
  const seconds=durationArgument?Number(durationArgument.slice('--body-seconds='.length)):8;
  assert(Number.isInteger(seconds)&&seconds>=8&&seconds<=600,'Body duration must be an integer from 8 to 600 seconds');
  const observations=[];
  const inputName='Body fixture',filterName='Body probe';
  await call('CreateInput',{sceneName:'Beauty',inputName,inputKind:'image_source',
    inputSettings:{file:join(work,'body-probe-lite/6-people.png')},sceneItemEnabled:true});
  await call('CreateSourceFilter',{sourceName:inputName,filterName,filterKind:'tblink_beauty_prototype',filterSettings:{live_mode:true}});
  const settings=await call('GetSourceFilter',{sourceName:inputName,filterName});
  const baseline=await screenshot('body-live-neutral',inputName);
  const channel=settings.filterSettings.transport_name;
  assert.match(channel,/^Local\\tblink-beauty-\d+-\d+$/);
  const frozen=process.argv.includes('--frozen');
  const onDemand=process.argv.includes('--body-demand');
  const output=join(directory,'body-worker.json'),stop=join(directory,'stop-body-worker');
  const child=spawn(join(resources,frozen?'runtime/tblink-beauty-worker/tblink-beauty-worker.exe':'python/Scripts/python.exe'),
    [...(frozen?[]:[join(root,'tools/obs/beauty/worker.py')]),'--channel',channel,'--model',join(resources,'face_landmarker.task'),
      '--body-model',join(resources,'pose_landmarker_lite.task'),...(onDemand?['--body-on-demand']:[]),'--managed','--seconds',String(seconds),'--diagnostic-history','10000','--report',output,'--stop-file',stop],
    {windowsHide:true,stdio:['pipe','pipe','pipe']});
  let stderr='',stdout='',pending='',latestBody,protocolError;
  child.stderr.on('data',chunk=>{stderr+=chunk.toString();});
  child.stdout.on('data',chunk=>{
    const text=chunk.toString(); stdout+=text; pending+=text;
    const lines=pending.split('\n'); pending=lines.pop()??'';
    for(const line of lines) {
      if(!line.trim()) continue;
      try { const packet=JSON.parse(line); if('body_status' in packet) latestBody=packet; }
      catch(error) { protocolError=error; }
    }
  });
  const exit=new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve);});
  let timeout,ownerStop;
  const demandObservations=[];
  const waitInactive=async()=>{
    const deadline=Date.now()+12000;
    while(!(latestBody?.sequence>0&&latestBody.bodies===0&&latestBody.body_status===2)) {
      if(protocolError) throw protocolError;
      assert(Date.now()<deadline,'Zero body controls did not clear native body results');
      await Promise.race([new Promise(resolve=>setTimeout(resolve,50)),exit.then(code=>{throw new Error(`Worker exited while waiting for inactive demand: ${code}`);})]);
    }
    demandObservations.push({...latestBody});
  };
  try {
    if(onDemand) {
      await waitInactive();
      await call('SetSourceFilterSettings',{sourceName:inputName,filterName,filterSettings:{bodySlim:.1}});
    }
    let readyTimeout;
    try {
      await Promise.race([new Promise((resolve,reject)=>child.stdout.on('data',()=>{
        if(protocolError) { reject(protocolError); return; }
        if(latestBody?.bodies===6 && latestBody.body_status===1 && latestBody.body_accepted>0 &&
          latestBody.sequence>=latestBody.body_accepted && latestBody.sequence-latestBody.body_accepted<32 &&
          latestBody.body_accepted_age_ms!==null && latestBody.body_accepted_age_ms<=250) resolve();
      })),
        exit.then(code=>{throw new Error(`Body worker ended before ready: ${code} ${stderr}`);}),
        new Promise((_,reject)=>{readyTimeout=setTimeout(()=>reject(new Error('OBS did not acknowledge timely six-body geometry')),12000);})]);
    } finally { clearTimeout(readyTimeout); }
    const started=performance.now();
    ownerStop=setTimeout(()=>child.stdin.end(),seconds*1000);
    const effects={};
    for(const key of ['bodySlim','waist','shoulder','legSlim','legLength','neck']) {
      await call('SetSourceFilterSettings',{sourceName:inputName,filterName,filterSettings:{bodySlim:0,waist:0,shoulder:0,legSlim:0,legLength:0,neck:0,[key]:key==='shoulder'?-1:1}});
      const pixels=await screenshot(`body-live-${key}`,inputName);
      effects[key]=Array.from({length:6},(_,index)=>difference(baseline,pixels,(x,y)=>Math.floor(x*3)===index%3&&Math.floor(y*2)===Math.floor(index/3)));
      assert(effects[key].every(value=>value>.001),`${key} did not change all six bodies`);
    }
    await call('SetSourceFilterSettings',{sourceName:inputName,filterName,filterSettings:{bodySlim:0,waist:0,shoulder:0,legSlim:0,legLength:0,neck:0}});
    assert.equal(difference(baseline,await screenshot('body-live-reset',inputName)),0,'Body zero did not restore image');
    if(onDemand) await waitInactive();
    if(seconds>8) {
      await call('SetSourceFilterSettings',{sourceName:inputName,filterName,filterSettings:{bodySlim:.5,waist:.4,shoulder:-.15,legSlim:.25,legLength:.15,neck:.1}});
      while(performance.now()-started<(seconds-3)*1000) {
        const pixels=await screenshot(`body-sustained-${observations.length}`,inputName);
        const changes=Array.from({length:6},(_,index)=>difference(baseline,pixels,(x,y)=>Math.floor(x*3)===index%3&&Math.floor(y*2)===Math.floor(index/3)));
        observations.push({elapsedMs:performance.now()-started,changes,stats:await call('GetStats')});
        assert(changes.every(value=>value>.001),'Sustained body effects disappeared');
        await new Promise(resolve=>setTimeout(resolve,2000));
      }
    }
    const code=await Promise.race([exit,new Promise((_,reject)=>{timeout=setTimeout(()=>reject(new Error('Body worker timeout; process retained')),20000);})]);
    assert.equal(code,0,`Body worker failed: ${stderr}`);
    assert.equal(protocolError,undefined,'Body worker returned invalid protocol');
    const report=JSON.parse(await readFile(output,'utf8'));
    if(onDemand) assert.equal(report.body_on_demand,true);
    const packets=stdout.trim().split('\n').map(line=>JSON.parse(line));
    assert(packets.some(packet=>packet.bodies===6&&packet.body_status===1&&packet.body_accepted>0&&packet.body_age_ms<=250),'Managed body status never reported accepted geometry');
    const samples=report.samples;
    assert(samples.length>=Math.max(20,seconds*10),'Insufficient concurrent face/body frames for requested duration');
    const accepted=samples.filter(sample=>sample.bodies===6&&sample.body_accepted_sequence>0&&sample.body_status===1);
    assert(accepted.length>=10,'Six-person body geometry never reliably accepted');
    const sequences=new Set(accepted.map(sample=>sample.body_accepted_sequence));
    assert(sequences.size>=10,'Body results were not updated');
    const settled=samples.slice(samples.findIndex(sample=>sample.body_status===1)+3).filter(sample=>!onDemand||sample.body_requested);
    assert(settled.length>=10,'Insufficient samples while body effects were enabled');
    const continuity=settled.filter(sample=>sample.body_status===1).length/settled.length;
    assert(continuity>=.95,`Body results flickered: ${(continuity*100).toFixed(1)}% continuity`);
    assert.equal(new Set(samples.map(sample=>sample.raw_sha256)).size,1,'Body input feedback or unstable fixture');
    const ages=accepted.map(sample=>sample.body_age_ms).sort((a,b)=>a-b);
    return {frozen,onDemand,demandObservations,seconds,observations:observations.length,frames:samples.length,acceptedFrames:accepted.length,acceptedResults:sequences.size,effects,continuity,
      bodyAgeP95Ms:ages[Math.floor(ages.length*.95)],scope:'OBS six-body geometry and torso effects; synthetic repeat photo, not production acceptance'};
  } finally {
    clearTimeout(timeout);clearTimeout(ownerStop);child.stdin.end();await writeFile(stop,'stop');
    let stopTimeout;
    try { await Promise.race([exit,new Promise((_,reject)=>{stopTimeout=setTimeout(()=>reject(new Error('Body worker did not stop; process retained')),8000);})]); }
    finally {
      clearTimeout(stopTimeout);
      await writeFile(join(directory,'body-worker-stderr.txt'),stderr);
      await writeFile(join(directory,'body-worker-stdout.txt'),stdout);
      await writeFile(join(directory,'body-observations.json'),JSON.stringify(observations,null,2));
    }
  }
}
