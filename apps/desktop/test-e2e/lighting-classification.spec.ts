import { writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { test, expect, _electron as electron } from '@playwright/test';
import { createEmptyLinkProject, createLightingDocument, createLightingUserLibrary, parseLinkProject } from '@tb/schema';
import { closeDiscarding } from './save-questions';

for(const scaled of [false,true]) test(`${scaled ? '规定高负载' : '千条分类'}：分类保存、直接编排、撤销与重开`, async ({}, info) => {
  const project = createEmptyLinkProject('分类编排验收'); project.schemaVersion = 2;
  const lighting = createLightingDocument(); const userLibrary = createLightingUserLibrary();
  userLibrary.entries = Array.from({ length: 1000 }, (_, index) => ({ id:`library-${index}`, name:`前区灯光 ${index}`, originalName:`原Cue ${index}`, revision:1, kind:'single' as const, categoryIds:['front:bright:3:front'],favorite:false,source:{endpoint:'test-console',show:'测试目录',verified:true},track:{id:`track-${index}`,name:'灯光',kind:'ma2' as const,color:'#abcdef',group:'',muted:false,solo:false,locked:false,channel:1,controller:7,portProfileId:'',noteNames:{},clips:[],cueStamp:{mode:'fixed' as const,sequence:index+1,cue:'1.100',executor:''}} }));
  project.ma2MaterialLibrary = {version:2,source:'test-console',userLibrary,library:{directory:{show:'测试目录',version:'3.7.0.5',generation:'fixture',entries:[]},readAt:new Date().toISOString(),fixtureUsage:[],errors:[],sequences:userLibrary.entries.map((entry,index)=>({sequence:index+1,name:entry.originalName,cues:[{index:0,number:'1.100',name:entry.originalName}]}))}};
  const wav = Buffer.alloc(44+48000*30*2); wav.write('RIFF');wav.writeUInt32LE(wav.length-8,4);wav.write('WAVEfmt ',8);wav.writeUInt32LE(16,16);wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22);wav.writeUInt32LE(48000,24);wav.writeUInt32LE(96000,28);wav.writeUInt16LE(2,32);wav.writeUInt16LE(16,34);wav.write('data',36);wav.writeUInt32LE(wav.length-44,40);
  await writeFile(info.outputPath('reference.wav'),wav);
  project.rundown = [{id:'song',title:'分类编排测试歌曲',enabled:true,notes:'',cues:[],visualLayers:[],referenceMediaClips:[],lighting,referenceAudio:{assetId:'audio',relativePath:'reference.wav',durationMs:30000,sha256:createHash('sha256').update(wav).digest('hex')}}];
  const originalCues=scaled ? 250 : 0;
  if(scaled){
    const image=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jZ3sAAAAASUVORK5CYII=','base64');await writeFile(info.outputPath('asset.png'),image);
    project.mediaAssets=Array.from({length:2000},(_,index)=>({id:`asset-${index}`,name:`素材 ${index}`,kind:'image',folderId:null,relativePath:'asset.png',sha256:createHash('sha256').update(image).digest('hex'),byteLength:image.length,width:1,height:1}));
    const first=project.rundown[0]!;
    project.rundown=Array.from({length:200},(_,song)=>{const document=createLightingDocument();document.tracks=[{...userLibrary.entries[0]!.track,id:`track-${song}`,clips:[{id:`clip-${song}`,name:'原编排',start:0,duration:30000,timeLock:'time',muted:false,events:Array.from({length:250},(_,cue)=>({id:`cue-${song}-${cue}`,kind:'ma2',at:cue*100,sequence:1,executor:'',cue:String(cue+1),action:'goto',label:`原 Cue ${cue}`}))}]}];return {...first,id:song ? `song-${song}`:'song',title:`节目 ${song}`,lighting:document};});
  }
  const file = info.outputPath('classification.tblink'); await writeFile(file,JSON.stringify(project));
  const executable=process.env.TBLINK_MA2_PACKAGED_EXE;
  const launch=()=>electron.launch({...(executable ? {executablePath:executable} : {}),args:[`--user-data-dir=${info.outputPath('profile')}`,...executable ? [] : [join(process.cwd(),'out/main/index.cjs')]],env:{...process.env,TBLINK_LOCAL_TEST_ACCESS:'1'}});
  let application = await launch();
  let page = await application.firstWindow(); const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
  const readSaved=async()=>parseLinkProject(JSON.parse(await page.evaluate(async path=>(await window.tbLink.openProjectDocument(path)).content,file)));
  // This test owns the undo history; background music analysis has its own spec and needs the offline runtime.
  const stubDialogAndAnalysis=()=>application.evaluate(({dialog,ipcMain},path)=>{
    dialog.showOpenDialog=()=>Promise.resolve({canceled:false,filePaths:[path]});
    ipcMain.removeHandler('link:automatic-music-status');
    ipcMain.handle('link:automatic-music-status',()=>({version:1,available:false,device:'cpu',devices:['cpu'],reason:'分类编排验收不运行音乐分析',publication:'not-validated',jobs:[]}));
  },file);
  try {
    await stubDialogAndAnalysis();
    await page.getByRole('button',{name:'打开工程',exact:true}).click();
    await page.getByRole('navigation',{name:'主要工作区'}).getByRole('button',{name:'灯光工作台',exact:true}).click();
    await expect(page.locator('.timeline-shell')).toBeVisible();
    expect((await page.locator('.timeline-shell').boundingBox())!.height).toBeGreaterThan(100);
    const tabs=page.getByRole('navigation',{name:'灯光素材主菜单'});await tabs.getByRole('button',{name:'面光',exact:true}).click();
    await expect(tabs.getByRole('button')).toHaveText(['控台素材','面光','轮廓','效果','分类管理','新建分类']);
    await tabs.getByRole('button',{name:'效果',exact:true}).click();
    await expect(page.getByRole('group',{name:'效果分类视图'})).toHaveCount(0);
    await expect(page.getByRole('group',{name:'音乐用途',exact:true}).getByRole('button')).toHaveText(['重击','滚奏','渐强','爆发','停顿','段落切换','结尾','最后一击','自定义']);
    await expect(page.getByRole('group',{name:'节拍灯光',exact:true}).getByRole('button')).toHaveText(['每四分之一拍','每半拍','每拍','每两拍','每四拍','每八拍','每十六拍','每三十二拍']);
    await tabs.getByRole('button',{name:'面光',exact:true}).click();
    expect(await page.locator('.classification-submenu>[role=group]').evaluateAll(elements=>elements.map(element=>element.getAttribute('aria-label')))).toEqual(['面光调性','灯光区域','人数']);
    await tabs.getByRole('button',{name:'轮廓',exact:true}).click();expect(await page.locator('.classification-submenu>[role=group]').evaluateAll(elements=>elements.map(element=>element.getAttribute('aria-label')))).toEqual(['灯光区域','人数']);await tabs.getByRole('button',{name:'面光',exact:true}).click();
    const tones=page.getByRole('group',{name:'面光调性'}), people=page.getByRole('group',{name:'人数',exact:true});
    await expect(people.getByRole('button')).toHaveText(['3人','7人','12人']);await people.getByRole('button',{name:'7人',exact:true}).click();
    await tones.getByRole('button',{name:'中调',exact:true}).click();await expect(people.getByRole('button')).toHaveText(['1人','2人','3人','7人']);await people.getByRole('button',{name:'2人',exact:true}).click();
    await tones.getByRole('button',{name:'暗调',exact:true}).click();await expect(people.getByRole('button')).toHaveText(['1人']);
    await tabs.getByRole('button',{name:'轮廓',exact:true}).click();await expect(people.getByRole('button')).toHaveText(['1人','3人','7人','12人']);await people.getByRole('button',{name:'12人',exact:true}).click();
    await tabs.getByRole('button',{name:'面光',exact:true}).click();await tones.getByRole('button',{name:'中调',exact:true}).click();await expect(people.getByRole('button',{name:'2人',exact:true})).toHaveAttribute('aria-pressed','true');
    await tones.getByRole('button',{name:'亮调',exact:true}).click();await expect(people.getByRole('button',{name:'7人',exact:true})).toHaveAttribute('aria-pressed','true');
    await tabs.getByRole('button',{name:'轮廓',exact:true}).click();await expect(people.getByRole('button',{name:'12人',exact:true})).toHaveAttribute('aria-pressed','true');
    await tabs.getByRole('button',{name:'面光',exact:true}).click();await people.getByRole('button',{name:'3人',exact:true}).click();
    await expect(page.getByLabel('音乐网格间隔')).toHaveCount(0);
    await expect(page.locator('.music-grid-line')).toHaveCount(0);
    await expect(page.getByLabel('音乐分析', {exact:true})).toBeVisible();
    const toolbar=await page.locator('.lighting-topbar-actions').boundingBox();expect(toolbar!.y).toBeLessThan(54);expect(toolbar!.height).toBeLessThanOrEqual(54);
    await expect(page.locator('.lighting-topbar-actions').getByRole('button',{name:'保存',exact:true})).toBeVisible();
    const library=page.getByRole('region',{name:'我的灯光分类'});const pool=library.locator('[aria-label="分类 Cue"]');
    await expect(pool).toHaveAttribute('data-total-cues','1000');
    const painted = await pool.locator('[data-cue-cell]').evaluateAll(elements => {
      const viewport = elements[0]?.parentElement?.parentElement?.getBoundingClientRect();
      if (!viewport) throw new Error('缺少分类视口');
      return { total: elements.length, visible: elements.filter(element => { const rect = element.getBoundingClientRect(); return rect.bottom > viewport.top && rect.top < viewport.bottom; }).length };
    });
    expect(painted.visible).toBeGreaterThan(0); expect(painted.total).toBeLessThanOrEqual(painted.visible * 2);
    await page.evaluate(()=>{
      const input=document.querySelector('input[aria-label="搜索分类 Cue"]');const pool=document.querySelector('[aria-label="分类 Cue"]');if(!input||!pool)throw new Error('缺少分类搜索');
      const samples:number[]=[];Reflect.set(window,'classificationSearchSamples',samples);
      input.addEventListener('input',()=>{const start=performance.now();const observer=new MutationObserver(()=>{observer.disconnect();requestAnimationFrame(()=>requestAnimationFrame(()=>samples.push(performance.now()-start)));});observer.observe(pool,{attributes:true,attributeFilter:['data-total-cues']});});
    });
    for(let run=0;run<20;run++){await library.getByLabel('搜索分类 Cue').fill(run%2 ? '' : '前区灯光 999');await expect(pool).toHaveAttribute('data-total-cues',run%2 ? '1000':'1');await expect.poll(()=>page.evaluate(()=>{const value:unknown=Reflect.get(window,'classificationSearchSamples');return Array.isArray(value)?value.length:0;})).toBe(run+1);}
    const timings=await page.evaluate(()=>{const values:unknown=Reflect.get(window,'classificationSearchSamples');if(!Array.isArray(values)||!values.every((value:unknown)=>typeof value==='number'))throw new Error('搜索测量无效');return values;});
    const p95=[...timings].sort((a,b)=>a-b)[Math.ceil(timings.length*.95)-1]!;
    await writeFile(info.outputPath('ui-performance.json'),JSON.stringify({kind:'真实 Electron 编辑界面；静态构造素材，不代表视频解码负载',programs:scaled?200:1,assets:scaled?2000:0,cues:scaled?50000:0,library:1000,searchP95Ms:p95,timings},null,2));expect(p95).toBeLessThanOrEqual(100);
    await library.getByLabel('搜索分类 Cue').fill('前区灯光 999');await expect(pool).toHaveAttribute('data-total-cues','1');
    await library.locator('.classification-cell>button').first().click({button:'right'});
    const context=page.getByRole('dialog',{name:'Cue 右键菜单'});await context.getByRole('button',{name:'设置分类',exact:true}).click();await context.getByText('面光、轮廓和效果用途',{exact:true}).click();await context.getByRole('button',{name:'效果',exact:true}).click();await context.getByRole('button',{name:'归入 效果 每八拍',exact:true}).click();await context.getByRole('button',{name:'确定',exact:true}).click();
    await library.getByLabel('搜索分类 Cue').fill('前区灯光 999');await expect(pool).toHaveAttribute('data-total-cues','1');
    await tabs.getByRole('button',{name:'效果',exact:true}).click();await page.getByRole('group',{name:'节拍灯光'}).getByRole('button',{name:'每八拍',exact:true}).click();await expect(pool).toHaveAttribute('data-total-cues','1');await page.screenshot({path:info.outputPath('effect-beat-library.png')});await tabs.getByRole('button',{name:'面光',exact:true}).click();
    await expect(page.getByLabel('节拍与音乐标记')).toHaveCount(0);
    await library.locator('.classification-cell').first().hover();
    await page.getByRole('button',{name:'添加 前区灯光 999 到播放头',exact:true}).click();
    await page.keyboard.press('Control+s');
    await expect.poll(async()=>(await readSaved()).rundown[0]?.lighting?.tracks.flatMap(track=>track.clips.flatMap(clip=>clip.events)).length).toBe(originalCues+1);
    const saved=await readSaved();expect(saved.rundown[0]!.lighting!.tracks.at(-1)!.clips[0]!.events.map(event=>event.at)).toEqual([0]);
    expect(saved.rundown[0]!.lighting!.tempos).toEqual(project.rundown[0]!.lighting!.tempos);
    expect(saved.ma2MaterialLibrary!.userLibrary!.entries.find(entry=>entry.id==='library-999')!.name).toBe('前区灯光 999');expect(saved.ma2MaterialLibrary!.userLibrary!.entries.find(entry=>entry.id==='library-999')!.categoryIds).toContain('effect:beat:8');
    await expect(page.getByText(/工程自动保存失败/)).toHaveCount(0);
    await page.screenshot({path:info.outputPath('classification-and-timeline.png')});
    await page.getByRole('button',{name:'撤销',exact:true}).click();await page.keyboard.press('Control+s');
    await expect.poll(async()=>(await readSaved()).rundown[0]?.lighting?.tracks.flatMap(track=>track.clips.flatMap(clip=>clip.events)).length).toBe(originalCues);
    await closeDiscarding(application);application=await launch();page=await application.firstWindow();page.on('pageerror',error=>errors.push(error.message));
    await stubDialogAndAnalysis();
    await page.getByRole('button',{name:'打开工程',exact:true}).click();
    await page.getByRole('navigation',{name:'主要工作区'}).getByRole('button',{name:'灯光工作台',exact:true}).click();
    await page.getByRole('navigation',{name:'灯光素材主菜单'}).getByRole('button',{name:'面光',exact:true}).click();
    await expect(page.getByLabel('搜索分类 Cue')).toHaveValue('前区灯光 999');await expect(page.locator('.classification-cell>button').first()).toHaveText('前区灯光 999');
    await expect(page.getByRole('button',{name:'时间线标记 重鼓点 / 重击',exact:true})).toHaveCount(0);
    if(scaled){
      await page.getByRole('button', { name: '回到时间线开头', exact: true }).click();
      for (let step = 0; step < 5; step++) await page.getByRole('button', { name: '放大时间线', exact: true }).click();
      await page.getByRole('button', { name: '回到时间线开头', exact: true }).click();
      await page.getByRole('button', { name: '关闭吸附', exact: true }).click();
      const point=page.getByRole('button',{name:'音频 Cue 1',exact:true});await expect(point).toBeVisible();
      await page.evaluate(()=>{
        const samples:number[]=[];Reflect.set(window,'lightingDragSamples',samples);const point=document.querySelector('button[aria-label="音频 Cue 1"]');if(!point)throw new Error('缺少待拖动 Cue');
        point.addEventListener('pointermove',()=>{const start=performance.now();requestAnimationFrame(()=>requestAnimationFrame(()=>samples.push(performance.now()-start)));});
      });
      const box=(await point.boundingBox())!;await page.mouse.move(box.x+box.width/2,box.y+box.height/2);await page.mouse.down();
      for(let step=1;step<=20;step++){await page.mouse.move(box.x+box.width/2+step*3,box.y+box.height/2);await page.waitForTimeout(35);}
      await page.mouse.up();await page.keyboard.press('Control+s');
      await expect.poll(async()=>{const saved=await readSaved();return saved.rundown[0]!.lighting!.tracks.flatMap(track=>track.clips.flatMap(clip=>clip.events.filter(event=>event.id==='cue-0-0').map(event=>clip.start+event.at)))[0];}).toBeGreaterThan(0);
      const drag=await page.evaluate(()=>{const values:unknown=Reflect.get(window,'lightingDragSamples');if(!Array.isArray(values)||!values.every((value:unknown)=>typeof value==='number'))throw new Error('拖动测量无效');return values;});
      const dragP95=[...drag].sort((a,b)=>a-b)[Math.ceil(drag.length*.95)-1]!;
      const profiler=process.env.TBLINK_PROFILE_ZOOM ? await page.context().newCDPSession(page) : null;if(profiler){await profiler.send('Profiler.enable');await profiler.send('Profiler.start');}
      const zoom:number[]=[];
      for(let run=0;run<20;run++){
        const name=run%2 ? '缩小时间线':'放大时间线';
        await page.evaluate(name=>{const button=document.querySelector(`[aria-label="${name}"]`);if(!button)throw new Error('缺少缩放入口');button.addEventListener('click',()=>{const start=performance.now();requestAnimationFrame(()=>requestAnimationFrame(()=>Reflect.set(window,'lightingZoomMs',performance.now()-start)));},{once:true});Reflect.set(window,'lightingZoomMs',null);},name);
        await page.getByRole('button',{name,exact:true}).click();await expect.poll(()=>page.evaluate(()=>{const value:unknown=Reflect.get(window,'lightingZoomMs');return typeof value==='number'?value:null;})).not.toBeNull();
        const ms:unknown=await page.evaluate(()=>{const value:unknown=Reflect.get(window,'lightingZoomMs');return typeof value==='number'?value:null;});if(typeof ms!=='number')throw new Error('缩放测量无效');zoom.push(ms);
      }
      if(profiler){const cpu=await profiler.send('Profiler.stop');await writeFile(info.outputPath('zoom.cpuprofile'),JSON.stringify(cpu.profile));await profiler.detach();}
      const zoomP95=[...zoom].sort((a,b)=>a-b)[Math.ceil(zoom.length*.95)-1]!;
      await writeFile(info.outputPath('timeline-performance.json'),JSON.stringify({programs:200,assets:2000,cues:50000,dragP95,zoomP95,drag,zoom},null,2));expect(dragP95).toBeLessThanOrEqual(100);expect(zoomP95).toBeLessThanOrEqual(100);
      await expect(page.getByText(/工程自动保存失败/)).toHaveCount(0);
    }
    expect(errors).toEqual([]);
  } finally {
    if(!page.isClosed()){await page.screenshot({path:info.outputPath('final.png')});await writeFile(info.outputPath('page.txt'),await page.locator('body').innerText());await page.evaluate(()=>window.tbLink.setDocumentState({ version: 1, dirty: false, consoleSynced: false, name: null, projectPath: null, projectId: null }));}
    if(application.process().exitCode===null) await application.close();
  }
});
