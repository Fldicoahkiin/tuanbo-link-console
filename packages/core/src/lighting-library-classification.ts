import { lightingLibraryEntrySchema, type LinkProject } from '@tb/schema';
import type { LinkCommand } from './link-command';
import { projectLightingLibrary, setLightingLibraryCommand } from './lighting-library';

export type ConsoleCueReference = { sequence:number; cue:string; kind:'single'|'sequence' };
export type ConsoleLibrarySource = { endpoint:string; show:string };
export function consoleCueKey(ref:ConsoleCueReference):string { return `${ref.kind}:${ref.sequence}:${ref.cue}`; }

function checkSource(project:LinkProject, source:ConsoleLibrarySource):void {
  const pool=project.ma2MaterialLibrary;
  if (!pool?.library || pool.source!==source.endpoint || pool.library.directory.show!==source.show) throw new Error('控台目录已变化，请重新选择 Cue');
}

/** Classification only stores references. It never sends a console action or changes song events. */
export function classifyConsoleCuesCommand(refs:ConsoleCueReference[], categoryId:string, source:ConsoleLibrarySource):LinkCommand {
  return updateConsoleCueCategoriesCommand(refs,{add:[categoryId],remove:[]},source);
}
export type CategoryChanges={add:string[];remove:string[]};
export function updateConsoleCueCategoriesCommand(refs:ConsoleCueReference[], changes:CategoryChanges, source:ConsoleLibrarySource):LinkCommand {
  const inputs=new Map(refs.map(ref=>[consoleCueKey(ref),{ref,id:crypto.randomUUID()}]));
  return {id:crypto.randomUUID(),label:'归类控台 Cue',scope:'lighting',execute(project){
    checkSource(project,source);
    const library=projectLightingLibrary(project);
    if([...changes.add,...changes.remove].some(id=>!library.categories.some(category=>category.id===id)))throw new Error('分类已移除，请重新选择');
    const entries=[...library.entries];
    const sequences=new Map(project.ma2MaterialLibrary!.library!.sequences.map(sequence=>[sequence.sequence,sequence]));
    const existing=new Map(entries.flatMap((entry,index)=>{
      const ref=entry.track.cueStamp;
      return entry.source.endpoint===source.endpoint && entry.source.show===source.show && ref?.mode==='fixed' && ref.executor==='' && entry.kind!=='combination' ? [[consoleCueKey({...ref,kind:entry.kind}),index] as const] : [];
    }));
    for(const [key,{ref,id}] of inputs){
      const sequence=sequences.get(ref.sequence);const cue=sequence?.cues.find(value=>value.number===ref.cue);
      if(!sequence || !cue)throw new Error(`序列 ${ref.sequence} / Cue ${ref.cue} 已不在当前读取目录中`);
      const index=existing.get(key);const old=index===undefined?undefined:entries[index];
      if(old){entries[index!]={...old,categoryIds:[...new Set([...old.categoryIds.filter(id=>!changes.remove.includes(id)),...changes.add])]};continue;}
      if(!changes.add.length)continue;
      const name=ref.kind==='sequence'?sequence.name:cue.name;
      const entry=lightingLibraryEntrySchema.parse({id,name,originalName:name,revision:1,kind:ref.kind,categoryIds:[...new Set(changes.add)],favorite:false,
        source:{...source,verified:!project.ma2MaterialLibrary!.library!.sourceUnverified},
        track:{id,name,kind:'ma2',color:'#68c9ed',group:'',muted:false,solo:false,locked:false,channel:1,portProfileId:'',controller:7,noteNames:{},clips:[],cueStamp:{mode:'fixed',sequence:ref.sequence,cue:ref.cue,executor:''}}
      });
      existing.set(key,entries.length);entries.push(entry);
    }
    return setLightingLibraryCommand({...library,entries}).execute(project);
  },undo:before=>before};
}

export function hideConsoleCuesCommand(refs:ConsoleCueReference[], source:ConsoleLibrarySource, hidden:boolean):LinkCommand {
  const keys=new Set(refs.map(consoleCueKey));
  return {id:crypto.randomUUID(),label:hidden?'移除控台素材':'恢复控台素材',scope:'lighting',execute(project){
    checkSource(project,source);const library=projectLightingLibrary(project);
    const kept=(library.hiddenConsoleCues??[]).filter(ref=>ref.endpoint!==source.endpoint || ref.show!==source.show || !keys.has(consoleCueKey(ref)));
    const added=hidden?[...new Map(refs.map(ref=>[consoleCueKey(ref),{...source,...ref}])).values()]:[];
    return setLightingLibraryCommand({...library,hiddenConsoleCues:[...kept,...added]}).execute(project);
  },undo:before=>before};
}
