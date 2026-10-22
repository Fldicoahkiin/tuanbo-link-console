import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Plus, Trash2, Sun, ScanLine, Sparkles, RotateCcw, Check, Minus, Pencil, ArrowLeft, ChevronRight, Tags, ListFilter } from 'lucide-react';
import type { LightingCategory, LightingUserLibrary } from '@tb/schema';
import { lightingCategoryNavigation } from '@tb/core/link';
import { Ma2ConsoleName } from './Ma2ConsoleName';
import '../lighting-cue-context-menu.css';

/** One small menu for both console cues and classified cues. Changes remain local until the operator confirms. */
export function LightingCueContextMenu({x,y,title,categories,navigation,categoryIds=[],mixedCategoryIds=[],onConfirm,onRemove,onAdd,onRestore,onRename,renamesOnConsole=false,onAttributes,onEdit,onClose}:{
  onEdit?: (() => void) | undefined;
  x:number;y:number;title:string;categories:LightingCategory[];categoryIds?:string[];mixedCategoryIds?:string[];
  navigation?: LightingUserLibrary['navigation'];
  onConfirm:(changes:{add:string[];remove:string[]})=>void;onRemove:()=>void;onAdd?:(()=>void)|undefined;onRestore?:()=>void;onClose:()=>void;
  onRename?:((name:string)=>void|Promise<void>)|undefined;
  /** The new name is also written to MA2, so the menu shows how the console will display it. */
  renamesOnConsole?:boolean;
  onAttributes?: (() => void) | undefined;
}):JSX.Element {
  const root=useRef<HTMLDivElement>(null);
  const initial=categories.find(category=>categoryIds.includes(category.id));
  const [section,setSection]=useState<'front'|'rim'|'effect'|null>(initial?.section??null);
  const [changes,setChanges]=useState<Record<string,boolean>>({});
  const [tone,setTone]=useState<'bright'|'middle'|'dark'|null>(initial?.tone??null);
  const [zone,setZone]=useState<'front'|'middle'|'back'|null>(initial?.zone??null);
  const [position,setPosition]=useState({left:x,top:y});
  const [renaming,setRenaming]=useState(false);
  const [classifying,setClassifying]=useState(false);
  const [name,setName]=useState(title);
  const [renameError,setRenameError]=useState('');
  const [renameBusy,setRenameBusy]=useState(false);
  const nameInput=useRef<HTMLInputElement>(null);
  useEffect(()=>{if(renaming){nameInput.current?.focus();nameInput.current?.select();}},[renaming]);
  const close=useRef(onClose);close.current=onClose;
  useLayoutEffect(()=>{
    const element=root.current;if(!element)return;
    const place=():void=>{const box=element.getBoundingClientRect();const left=Math.max(8,Math.min(x,window.innerWidth-box.width-8)),top=Math.max(8,Math.min(y,window.innerHeight-box.height-8));setPosition(current=>current.left===left&&current.top===top?current:{left,top});};
    place();const observer=new ResizeObserver(place);observer.observe(element);window.addEventListener('resize',place);
    return()=>{observer.disconnect();window.removeEventListener('resize',place);};
  },[x,y]);
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
  const ordered = lightingCategoryNavigation({ version: 1, categories, entries: [], ...(navigation ? { navigation } : {}) }).filter(item => item.kind === 'category');
  const categoryButton = (category: LightingCategory): JSX.Element => <button key={category.id} aria-pressed={changes[category.id] ?? (categoryIds.includes(category.id) ? true : mixedCategoryIds.includes(category.id) ? 'mixed' : false)} onClick={() => setChanges(current => ({ ...current, [category.id]: !(current[category.id] ?? categoryIds.includes(category.id)) }))}>{(changes[category.id] ?? categoryIds.includes(category.id)) ? <Check/> : mixedCategoryIds.includes(category.id) && changes[category.id] === undefined ? <Minus/> : null}{category.name}</button>;
  const customButtons = (common: boolean): JSX.Element[] => ordered.filter(item => (item.display === 'common') === common).flatMap(item => { const category = categories.find(value => value.id === item.categoryId); return category ? [categoryButton(category)] : []; });
  return createPortal(<div ref={root} className="lighting-cue-context-menu" style={position} role="dialog" aria-label="Cue 右键菜单" onContextMenu={event=>event.preventDefault()} onKeyDown={event=>{
    if(event.key!=='ArrowDown'&&event.key!=='ArrowUp'&&event.key!=='Tab')return;
    if(renaming&&event.key!=='Tab')return;
    const buttons=[...event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),summary')].filter(element=>element.getClientRects().length>0);const index=buttons.indexOf(document.activeElement as HTMLElement);
    event.preventDefault();buttons[(index+(event.key==='ArrowUp'||event.key==='Tab'&&event.shiftKey?-1:1)+buttons.length)%buttons.length]?.focus();
  }}>
    <div className="cue-menu-heading">{classifying && !renaming ? <button aria-label="返回右键菜单" onClick={() => setClassifying(false)}><ArrowLeft/></button> : null}<div className="cue-menu-title" title={title}>{classifying ? '设置分类' : title}</div></div>
    {renaming?<form className="cue-menu-rename" onSubmit={event=>{event.preventDefault();if(renameBusy)return;setRenameBusy(true);void Promise.resolve().then(()=>onRename?.(name.trim())).then(onClose).catch((cause:unknown)=>setRenameError(cause instanceof Error?cause.message:String(cause))).finally(()=>setRenameBusy(false));}}>
      <input ref={nameInput} aria-label="Cue 名称" value={name} maxLength={512} required disabled={renameBusy} onChange={event=>{setName(event.target.value);setRenameError('');}}/>
      {renamesOnConsole?<Ma2ConsoleName name={name}/>:null}
      {renameError?<p role="alert">{renameError}</p>:null}
      <footer><button type="button" disabled={renameBusy} onClick={()=>{setRenaming(false);setName(title);setRenameError('');}}>取消</button><button className="cue-menu-confirm" type="submit" disabled={renameBusy||!name.trim()||name.trim()===title}>{renameBusy?'正在提交…':'确定'}</button></footer>
    </form>:onRestore?<button onClick={()=>apply(onRestore)}><RotateCcw/>恢复素材</button>:!classifying?<div className="cue-menu-actions">
      {onEdit ? <button onClick={() => apply(onEdit)}><Pencil/>编辑 Cue 步骤</button> : null}
      {onAttributes ? <button onClick={() => apply(onAttributes)}><ListFilter/>查看灯具属性</button> : null}
      <button onClick={() => setClassifying(true)}><Tags/>设置分类<ChevronRight/></button>
      {onRename ? <button onClick={() => setRenaming(true)}><Pencil/>重命名</button> : null}
      {onAdd ? <button onClick={() => apply(onAdd)}><Plus/>添加到播放头</button> : null}
      <button className="danger" title="保留控台 Cue 和已编排歌曲" onClick={() => apply(onRemove)}><Trash2/>移除素材</button>
    </div>:<>
      <div className="cue-menu-classifications">
      <div className="cue-menu-destinations" aria-label="常用分类">{customButtons(true)}</div>
      {ordered.some(item => item.display !== 'common') ? <details><summary>更多分类</summary><div className="cue-menu-destinations" aria-label="更多分类">{customButtons(false)}</div></details> : null}
      <details><summary>面光、轮廓和效果用途</summary>
      <div className="cue-menu-sections">{([['front','面光',Sun],['rim','轮廓',ScanLine],['effect','效果',Sparkles]] as const).map(([value,name,Icon])=><button key={value} data-section={value} aria-pressed={section===value} onClick={()=>{setSection(value);const previous=categories.find(category=>category.section===value&&(changes[category.id]??categoryIds.includes(category.id)));setTone(previous?.tone??null);setZone(previous?.zone??null);}}><Icon/>{name}</button>)}</div>
      {section && section!=='effect'?<>
        {section==='front'?<div className="cue-menu-options">{([['bright','亮调'],['middle','中调'],['dark','暗调']] as const).map(([value,name])=><button key={value} aria-pressed={tone===value} onClick={()=>setTone(value)}>{name}</button>)}</div>:null}
        <div className="cue-menu-options">{([['front','前区'],['middle','中区'],['back','后区']] as const).map(([value,name])=><button key={value} aria-pressed={zone===value} onClick={()=>setZone(value)}>{name}</button>)}</div>
      </>:null}
      <div className="cue-menu-destinations" data-section={section??undefined}>{leaves.map(category=><button key={category.id} aria-label={`归入 ${category.section==='front'?'面光':category.section==='rim'?'轮廓':'效果'} ${category.name}`} title={category.name} data-section={category.section} aria-pressed={changes[category.id]??(categoryIds.includes(category.id)?true:mixedCategoryIds.includes(category.id)?'mixed':false)} onClick={()=>setChanges(current=>({...current,[category.id]:!(current[category.id]??categoryIds.includes(category.id))}))}>{(changes[category.id]??categoryIds.includes(category.id))?<Check/>:changes[category.id]===undefined&&mixedCategoryIds.includes(category.id)?<Minus/>:null}{section==='effect'?category.name:`${category.people}人`}</button>)}</div>
      </details></div>
      <footer><button onClick={onClose}>取消</button><button className="cue-menu-confirm" disabled={!Object.keys(changes).length} onClick={()=>apply(()=>onConfirm({add:Object.keys(changes).filter(id=>changes[id]),remove:Object.keys(changes).filter(id=>!changes[id])}))}>确定</button></footer>
    </>}
  </div>,document.body);
}
