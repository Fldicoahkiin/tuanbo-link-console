import { expect, it } from 'vitest';
import { createEmptyLinkProject, createLightingDocument, createLightingUserLibrary, type Ma2CueDeleteResult } from '@tb/schema';
import { applyMa2CueDeletionCommand, ma2CueDeletionUsage } from './ma2-cue-delete';
import { renameConsoleCueCommand } from './lighting-library-classification';

const source = { endpoint:'192.0.2.1:30000', show:'fixture' };
function fixture() {
  const project = createEmptyLinkProject('delete'); project.schemaVersion=2;
  const library = { directory:{show:source.show,generation:'g',version:'3.7.0.5',entries:[{target:1,name:'Sequence'}]}, readAt:'2026-10-17T12:00:00.000Z', sequences:[{sequence:1,name:'Sequence',cues:[{index:1,number:'1.000',name:'First'},{index:2,number:'2.000',name:'Second'}]}],fixtureUsage:[],errors:[] };
  project.ma2MaterialLibrary = {version:1,source:source.endpoint,library,userLibrary:createLightingUserLibrary()};
  let next=renameConsoleCueCommand({sequence:1,cue:'1.000',kind:'single'},'Single',source).execute(project);
  next=renameConsoleCueCommand({sequence:1,cue:'1.000',kind:'sequence'},'Group',source).execute(next);
  const result: Ma2CueDeleteResult = { deleted:[{sequence:1,cue:'1.000'}],backups:['backup.xml'],library:{...library,sequences:[{...library.sequences[0]!,cues:[{index:1,number:'2.000',name:'Second'}]}]} };
  return {project:next,result};
}
it('removes confirmed deleted cue names while preserving a sequence category on the new first step',()=>{
  const {project,result}=fixture(); const command=applyMa2CueDeletionCommand(source.endpoint,result);
  for(const next of [command.execute(project),command.rebaseHistory!(project)]) {
    expect(next.ma2MaterialLibrary?.library?.sequences[0]?.cues.map(cue=>cue.number)).toEqual(['2.000']);
    expect(next.ma2MaterialLibrary?.userLibrary?.entries).toHaveLength(1);
    expect(next.ma2MaterialLibrary?.userLibrary?.entries[0]).toMatchObject({kind:'sequence',name:'Group',track:{cueStamp:{cue:'2.000'}}});
    expect(next.ma2MaterialLibrary?.userLibrary?.consoleRenames).toEqual([expect.objectContaining({kind:'sequence',cue:'2.000'})]);
  }
  expect(command.execute({...project,ma2MaterialLibrary:{...project.ma2MaterialLibrary!,source:'another'}})).toEqual({...project,ma2MaterialLibrary:{...project.ma2MaterialLibrary!,source:'another'}});
});
it('removes confirmed deletions even if the final directory refresh fails and blocks stale playback',()=>{
  const {project,result}=fixture(); delete result.library;
  const next=applyMa2CueDeletionCommand(source.endpoint,result).execute(project);
  expect(next.ma2MaterialLibrary?.library?.sourceUnverified).toBe(true);
  expect(next.ma2MaterialLibrary?.library?.sequences[0]?.cues.map(cue=>cue.number)).toEqual(['2.000']);
  expect(next.ma2MaterialLibrary?.library?.errors[0]?.message).toContain('重新读取控台失败');
});
it('preserves unconfirmed objects but invalidates playback after an uncertain deletion',()=>{
  const {project}=fixture();
  const result: Ma2CueDeleteResult={deleted:[],backups:['backup.xml'],error:'当前序列可能已部分删除，请回读核对'};
  const command=applyMa2CueDeletionCommand(source.endpoint,result);
  for(const next of [command.execute(project),command.rebaseHistory!(project)]) {
    expect(next.ma2MaterialLibrary?.library?.sourceUnverified).toBe(true);
    expect(next.ma2MaterialLibrary?.library?.sequences[0]?.cues).toHaveLength(2);
  }
});
it('blocks direct Cue and library combination uses',()=>{
  const {project}=fixture();
  const track=project.ma2MaterialLibrary!.userLibrary!.entries[0]!.track;
  project.rundown=[{id:'song',title:'Song',enabled:true,notes:'',cues:[],referenceMediaClips:[],visualLayers:[],lighting:{...createLightingDocument(),tracks:[track]}}];
  expect(ma2CueDeletionUsage(project,1,'1')).toContain('歌曲「Song」引用此 Cue');
  expect(ma2CueDeletionUsage(project,1,'2')).toEqual([]);
  project.rundown[0]!.lighting!.tracks=[];
  project.ma2MaterialLibrary!.userLibrary!.entries.push({...project.ma2MaterialLibrary!.userLibrary!.entries[0]!,id:'combination',kind:'combination',members:[{name:'Empty',sequence:1,cue:'1.000',executor:'',delayMs:0}]});
  expect(ma2CueDeletionUsage(project,1,'1')).toContain('组合素材引用此 Cue');
});
it('blocks preparation, templates and complete sequence bindings even when no visible point uses the Cue',()=>{
  const {project}=fixture();
  const track={...project.ma2MaterialLibrary!.userLibrary!.entries[0]!.track};delete track.cueStamp;
  const lighting=createLightingDocument();
  project.rundown=[{id:'song',title:'Song',enabled:true,notes:'',cues:[],referenceMediaClips:[],visualLayers:[],lighting}];
  lighting.tracks=[{...track,clips:[{id:'clip',name:'Preparation',start:0,duration:10000,timeLock:'time',muted:false,events:[{id:'cue',kind:'ma2',at:1000,sequence:1,executor:'1.1',cue:'2.000',action:'goto',label:'Second',preparation:{cue:'1.000',leadMs:500}}]}]}];
  expect(ma2CueDeletionUsage(project,1,'1')).toContain('歌曲「Song」编排中引用此 Cue');
  lighting.templates=[{id:'template',name:'Saved template',track:lighting.tracks[0]!}];lighting.tracks=[];
  expect(ma2CueDeletionUsage(project,1,'1')).toContain('歌曲「Song」编排中引用此 Cue');
  lighting.templates=[];lighting.ma2Bindings=[{id:'binding',timecode:1,name:'Bound sequence',readAt:'2026-10-17T12:00:00.000Z',sourceXml:'<MA/>',baselineTracks:[],mappings:[],cueCatalog:[{sequence:1,name:'Sequence',cues:[]}]}];
  expect(ma2CueDeletionUsage(project,1,'1')).toContain('歌曲「Song」的控台时间线使用此序列');
});
