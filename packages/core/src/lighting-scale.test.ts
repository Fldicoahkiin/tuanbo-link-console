import { writeFile, mkdir } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { createEmptyLinkProject, createLightingDocument, createLightingUserLibrary, parseLinkProject } from '@tb/schema';
import { setLightingCommand } from './lighting-edit';
import { setLightingLibraryCommand } from './lighting-library';

it('200 节目 / 2000 素材 / 50000 Cue：分类与当前歌曲修改保留其他对象，不复制全工程', async () => {
  const base=createEmptyLinkProject('规定规模构造基准');base.schemaVersion=2;
  base.mediaAssets=Array.from({length:2000},(_,i)=>({id:`asset-${i}`,name:`素材${i}`,kind:'image',folderId:null,relativePath:`assets/${i}.png`,sha256:'a'.repeat(64),byteLength:100,width:1920,height:1080}));
  base.rundown=Array.from({length:200},(_,song)=>{const lighting=createLightingDocument();lighting.tracks=[{id:`track-${song}`,name:'灯光',kind:'ma2',color:'#abcdef',group:'',muted:false,solo:false,locked:false,channel:1,controller:7,portProfileId:'',noteNames:{},clips:[{id:`clip-${song}`,name:'Cue',timeLock:'time',start:0,duration:30000,muted:false,events:Array.from({length:250},(_,index)=>({id:`cue-${song}-${index}`,kind:'ma2',at:index*100,sequence:1,executor:'',cue:String(index+1),label:`Cue ${index}`,action:'goto'}))}]}];return{id:`song-${song}`,title:`节目${song}`,enabled:true,notes:'',visualLayers:[],referenceMediaClips:[],cues:[],lighting};});
  let project=parseLinkProject(base);const library=createLightingUserLibrary();const classification:number[]=[],editing:number[]=[];
  for(let run=0;run<22;run++){
    let start=performance.now();const categorized=setLightingLibraryCommand(library).execute(project);const categoryMs=performance.now()-start;
    expect(categorized.rundown).toBe(project.rundown);expect(categorized.mediaAssets).toBe(project.mediaAssets);
    const document=categorized.rundown[0]!.lighting!;start=performance.now();const edited=setLightingCommand('song-0',{...document,markers:[{id:'m',name:'重点',startMs:run,endMs:null}]}).execute(categorized);const editMs=performance.now()-start;
    expect(edited.rundown[1]).toBe(project.rundown[1]);expect(edited.mediaAssets).toBe(project.mediaAssets);expect(edited.rundown[0]).not.toBe(project.rundown[0]);
    if(run>=2){classification.push(categoryMs);editing.push(editMs);}project=edited;
  }
  const p95=(values:number[]):number=>[...values].sort((a,b)=>a-b)[Math.ceil(values.length*.95)-1]!;
  const evidence={kind:'纯领域构造数据，非 Electron 或硬件验收',programs:200,assets:2000,cues:50000,classificationP95:p95(classification),editingP95:p95(editing),classification,editing};
  if(process.env.TBLINK_LIGHTING_METRICS){await mkdir(process.env.TBLINK_LIGHTING_METRICS,{recursive:true});await writeFile(`${process.env.TBLINK_LIGHTING_METRICS}/core-scale.json`,JSON.stringify(evidence,null,2));}
  expect(p95(classification)).toBeLessThanOrEqual(100);expect(p95(editing)).toBeLessThanOrEqual(100);
});
