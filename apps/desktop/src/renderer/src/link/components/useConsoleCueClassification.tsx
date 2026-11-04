import { useEffect, useMemo, useState, type MouseEvent } from 'react';
import { renameConsoleCueCommand, updateConsoleCueCategoriesCommand, type CategoryChanges, consoleCueKey, hideConsoleCuesCommand, projectLightingLibrary, type ConsoleCueReference, type ConsoleLibrarySource } from '@tb/core/link';
import { useDocumentStore } from '../stores/document-store';
import { LightingCueContextMenu } from './LightingCueContextMenu';
import { requestMa2NameSync } from '../runtime/ma2-name-sync';
import { LightingCueAttributes } from './LightingCueAttributes';

export function useConsoleCueClassification(onError:(message:string)=>void){
  const project=useDocumentStore(state=>state.project);
  const library=useMemo(()=>project ? (() => { const value = projectLightingLibrary(project); return { ...value, categories: value.categories.filter(category => !category.id.startsWith('attribute:')), entries: value.entries.map(entry => ({ ...entry, categoryIds: entry.categoryIds.filter(id => !id.startsWith('attribute:')) })) }; })() : null,[project]);
  const source={endpoint:project?.ma2MaterialLibrary?.source??'',show:project?.ma2MaterialLibrary?.library?.directory.show??''};
  const [picked,setPicked]=useState<ConsoleCueReference[]>([]);
  const [context,setContext]=useState<{x:number;y:number;title:string;refs:ConsoleCueReference[];source:ConsoleLibrarySource;projectId:string;onEdit?: (() => void) | undefined}|null>(null);
  const [showRemoved,setShowRemoved]=useState(false);
  const [onlyUnclassified,setOnlyUnclassified]=useState(false);
  const [message,setMessage]=useState('');
  const [attributes,setAttributes]=useState<{ refs: ConsoleCueReference[]; title: string } | null>(null);
  useEffect(()=>setAttributes(null),[project?.projectId,source.endpoint,source.show]);
  useEffect(()=>{setPicked([]);setContext(null);setMessage('');},[project?.projectId,source.endpoint,source.show]);
  const hidden=useMemo(()=>new Set(library?.hiddenConsoleCues?.filter(ref=>ref.endpoint===source.endpoint&&ref.show===source.show).map(consoleCueKey)),[library,source.endpoint,source.show]);
  useEffect(()=>{if(!hidden.size)setShowRemoved(false);},[hidden.size]);
  const classified=useMemo(()=>new Set(library?.entries.flatMap(entry=>{
    const ref=entry.track.cueStamp;
    return ref?.mode==='fixed'&&entry.kind!=='combination'&&entry.source.endpoint===source.endpoint&&entry.source.show===source.show&&entry.categoryIds.length?[consoleCueKey({...ref,kind:entry.kind})]:[];
  })),[library,source.endpoint,source.show]);
  const isVisible=(ref:ConsoleCueReference):boolean=>hidden.has(consoleCueKey(ref))===showRemoved&&(!onlyUnclassified||!classified.has(consoleCueKey(ref)));
  const select=(ref:ConsoleCueReference,event:MouseEvent,ordered:ConsoleCueReference[]):void=>{
    const key=consoleCueKey(ref);
    if(event.shiftKey&&picked.length){const first=ordered.findIndex(value=>consoleCueKey(value)===consoleCueKey(picked[0]!));const last=ordered.findIndex(value=>consoleCueKey(value)===key);if(first>=0&&last>=0){setPicked(ordered.slice(Math.min(first,last),Math.max(first,last)+1));return;}}
    setPicked(current=>event.ctrlKey||event.metaKey?current.some(value=>consoleCueKey(value)===key)?current.filter(value=>consoleCueKey(value)!==key):[...current,ref]:[ref]);
  };
  const open=(event:MouseEvent,ref:ConsoleCueReference,title:string,onEdit?: () => void):void=>{
    event.preventDefault();event.stopPropagation();if(!project)return;
    const refs=picked.some(value=>consoleCueKey(value)===consoleCueKey(ref))?picked:[ref];
    setPicked(refs);setContext({x:event.clientX,y:event.clientY,title:refs.length>1?`已选 ${refs.length} 个 Cue`:title,refs,source,projectId:project.projectId,onEdit});
  };
  const execute=(action:'classify'|'remove'|'restore',changes?:CategoryChanges):void=>{
    if(!context)return;
    try{
      const state=useDocumentStore.getState();if(state.project?.projectId!==context.projectId)throw new Error('工程已切换，请重新选择 Cue');
      state.execute(action==='classify'?updateConsoleCueCategoriesCommand(context.refs,changes!,context.source):hideConsoleCuesCommand(context.refs,context.source,action==='remove'));
      const category=library?.categories.find(value=>value.id===changes?.add[0]);
      setMessage(action==='classify'?`已归类 ${context.refs.length} 项 · ${category?.name??''}`:action==='remove'?'已移除 · 可撤销':'已恢复');
      setPicked([]);onError('');
    }catch(cause){onError(cause instanceof Error?cause.message:String(cause));}
  };
  const memberships=context?.refs.map(ref=>library?.entries.filter(entry=>entry.source.endpoint===context.source.endpoint&&entry.source.show===context.source.show&&entry.kind===ref.kind&&entry.track.cueStamp?.mode==='fixed'&&entry.track.cueStamp.sequence===ref.sequence&&entry.track.cueStamp.cue===ref.cue).flatMap(entry=>entry.categoryIds)??[])??[];
  const union=[...new Set(memberships.flat())];const common=union.filter(id=>memberships.every(ids=>ids.includes(id)));
  const sections=new Map<string,('front'|'rim'|'effect')[]>();
  for(const entry of library?.entries??[]){const ref=entry.track.cueStamp;if(ref?.mode!=='fixed'||entry.kind==='combination'||entry.source.endpoint!==source.endpoint||entry.source.show!==source.show)continue;const key=consoleCueKey({...ref,kind:entry.kind});sections.set(key,[...new Set([...(sections.get(key)??[]),...entry.categoryIds.flatMap(id=>library?.categories.find(category=>category.id===id)?.section??[])])]);}
  const menu=context&&library?<LightingCueContextMenu {...context} categories={library.categories} navigation={library.navigation} categoryIds={common} mixedCategoryIds={union.filter(id=>!common.includes(id))} onClose={()=>setContext(null)} onAttributes={()=>setAttributes({refs:context.refs,title:context.title})} onRename={context.refs.length===1?async(name)=>{
    const state=useDocumentStore.getState();if(state.project?.projectId!==context.projectId)throw new Error('工程已切换，请重新选择 Cue');
    state.execute(renameConsoleCueCommand(context.refs[0]!,name,context.source));onError('');
    await requestMa2NameSync(state.documentId);
  }:undefined} renamesOnConsole onConfirm={changes=>execute('classify',changes)} onRemove={()=>execute('remove')} {...showRemoved?{onRestore:()=>execute('restore')}:{} }/>:null;
  return {sections,isVisible,select,open,menu:<>{menu}{attributes?<LightingCueAttributes {...attributes} onClose={()=>setAttributes(null)}/>:null}</>,picked,setPicked,classified,hidden,showRemoved,setShowRemoved,onlyUnclassified,setOnlyUnclassified,message};
}
