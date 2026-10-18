import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Plus, Trash2, Sun, ScanLine, Sparkles, RotateCcw, Check, Minus, Pencil } from 'lucide-react';
import type { LightingCategory } from '@tb/schema';
import '../lighting-cue-context-menu.css';

/** One small menu for both console cues and classified cues. Changes remain local until the operator confirms. */
export function LightingCueContextMenu({x,y,title,categories,categoryIds=[],mixedCategoryIds=[],onConfirm,onRemove,onAdd,onRestore,onRename,onClose}:{
  x:number;y:number;title:string;categories:LightingCategory[];categoryIds?:string[];mixedCategoryIds?:string[];
  onConfirm:(changes:{add:string[];remove:string[]})=>void;onRemove:()=>void;onAdd?:(()=>void)|undefined;onRestore?:()=>void;onClose:()=>void;
  onRename?:((name:string)=>void|Promise<void>)|undefined;
}):JSX.Element {
  const root=useRef<HTMLDivElement>(null);
  const initial=categories.find(category=>categoryIds.includes(category.id));
  const [section,setSection]=useState<'front'|'rim'|'effect'|null>(initial?.section??null);
  const [changes,setChanges]=useState<Record<string,boolean>>({});
  const [tone,setTone]=useState<'bright'|'middle'|'dark'|null>(initial?.tone??null);
  const [zone,setZone]=useState<'front'|'middle'|'back'|null>(initial?.zone??null);
  const [position,setPosition]=useState({left:x,top:y});
  const [renaming,setRenaming]=useState(false);
  const [name,setName]=useState(title);
  const [renameError,setRenameError]=useState('');
  const [renameBusy,setRenameBusy]=useState(false);
  const nameInput=useRef<HTMLInputElement>(null);
  useEffect(()=>{if(renaming){nameInput.current?.focus();nameInput.current?.select();}},[renaming]);
  const close=useRef(onClose);close.current=onClose;
  useLayoutEffect(()=>{const box=root.current?.getBoundingClientRect();if(box)setPosition({left:Math.max(8,Math.min(x,window.innerWidth-box.width-8)),top:Math.max(8,Math.min(y,window.innerHeight-box.height-8))});},[x,y,section,tone,zone,renaming,renameError]);
  useEffect(()=>{
    const previous=document.activeElement;
    root.current?.querySelector<HTMLButtonElement>('button')?.focus({preventScroll:true});
    const outside=(event:PointerEvent):void=>{if(event.target instanceof Node&&!root.current?.contains(event.target))close.current();};
    const escape=(event:KeyboardEvent):void=>{if(event.key==='Escape'){event.preventDefault();close.current();}};
    window.addEventListener('pointerdown',outside,true);window.addEventListener('keydown',escape,true);
    return()=>{window.removeEventListener('pointerdown',outside,true);window.removeEventListener('keydown',escape,true);if(previous instanceof HTMLElement&&previous.isConnected)previous.focus({preventScroll:true});};
  },[]);
  const apply=(action:()=>void):void=>{action();onClose();};
  const leaves=categories.filter(category=>category.section===section&&(section==='effect'?category.view==='music'||category.view==='beat':category.zone===zone&&(section==='rim'||category.tone===tone)));
  return createPortal(<div ref={root} className="lighting-cue-context-menu" style={position} role="dialog" aria-label="Cue 右键菜单" onContextMenu={event=>event.preventDefault()} onKeyDown={event=>{
    if(event.key!=='ArrowDown'&&event.key!=='ArrowUp'&&event.key!=='Tab')return;
    if(renaming&&event.key!=='Tab')return;
    const buttons=[...event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled)')];const index=buttons.indexOf(document.activeElement as HTMLElement);
    event.preventDefault();buttons[(index+(event.key==='ArrowUp'||event.key==='Tab'&&event.shiftKey?-1:1)+buttons.length)%buttons.length]?.focus();
  }}>
    <div className="cue-menu-heading"><div className="cue-menu-title" title={title}>{title}</div>{onRename&&!renaming?<button type="button" aria-label="重命名" title="重命名" onClick={()=>setRenaming(true)}><Pencil/>重命名</button>:null}</div>
    {renaming?<form className="cue-menu-rename" onSubmit={event=>{event.preventDefault();if(renameBusy)return;setRenameBusy(true);void Promise.resolve().then(()=>onRename?.(name.trim())).then(onClose).catch((cause:unknown)=>setRenameError(cause instanceof Error?cause.message:String(cause))).finally(()=>setRenameBusy(false));}}>
      <input ref={nameInput} aria-label="Cue 名称" value={name} maxLength={512} required disabled={renameBusy} onChange={event=>{setName(event.target.value);setRenameError('');}}/>
      {renameError?<p role="alert">{renameError}</p>:null}
      <footer><button type="button" disabled={renameBusy} onClick={()=>{setRenaming(false);setName(title);setRenameError('');}}>取消</button><button className="cue-menu-confirm" type="submit" disabled={renameBusy||!name.trim()||name.trim()===title}>{renameBusy?'正在提交…':'确定'}</button></footer>
    </form>:onRestore?<button onClick={()=>apply(onRestore)}><RotateCcw/>恢复素材</button>:<>
      <div className="cue-menu-sections">{([['front','面光',Sun],['rim','轮廓',ScanLine],['effect','效果',Sparkles]] as const).map(([value,name,Icon])=><button key={value} data-section={value} aria-pressed={section===value} onClick={()=>{setSection(value);const previous=categories.find(category=>category.section===value&&(changes[category.id]??categoryIds.includes(category.id)));setTone(previous?.tone??null);setZone(previous?.zone??null);}}><Icon/>{name}</button>)}</div>
      {section && section!=='effect'?<>
        {section==='front'?<div className="cue-menu-options">{([['bright','亮调'],['middle','中调'],['dark','暗调']] as const).map(([value,name])=><button key={value} aria-pressed={tone===value} onClick={()=>setTone(value)}>{name}</button>)}</div>:null}
        <div className="cue-menu-options">{([['front','前区'],['middle','中区'],['back','后区']] as const).map(([value,name])=><button key={value} aria-pressed={zone===value} onClick={()=>setZone(value)}>{name}</button>)}</div>
      </>:null}
      <div className="cue-menu-destinations" data-section={section??undefined}>{leaves.map(category=><button key={category.id} aria-label={`归入 ${category.section==='front'?'面光':category.section==='rim'?'轮廓':'效果'} ${category.name}`} title={category.name} data-section={category.section} aria-pressed={changes[category.id]??(categoryIds.includes(category.id)?true:mixedCategoryIds.includes(category.id)?'mixed':false)} onClick={()=>setChanges(current=>({...current,[category.id]:!(current[category.id]??categoryIds.includes(category.id))}))}>{(changes[category.id]??categoryIds.includes(category.id))?<Check/>:changes[category.id]===undefined&&mixedCategoryIds.includes(category.id)?<Minus/>:null}{section==='effect'?category.name:`${category.people}人`}</button>)}</div>
      <footer>{onAdd?<button onClick={()=>apply(onAdd)}><Plus/>添加到播放头</button>:null}<button className="danger" title="只移除软件素材，保留控台 Cue 和已编排歌曲" onClick={()=>apply(onRemove)}><Trash2/>删除</button><button className="cue-menu-confirm" disabled={!Object.keys(changes).length} onClick={()=>apply(()=>onConfirm({add:Object.keys(changes).filter(id=>changes[id]),remove:Object.keys(changes).filter(id=>!changes[id])}))}>确定</button></footer>
    </>}
  </div>,document.body);
}
