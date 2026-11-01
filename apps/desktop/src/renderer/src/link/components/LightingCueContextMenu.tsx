import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Plus, Trash2, Sun, ScanLine, Sparkles, RotateCcw, Check, Minus, Pencil, ArrowLeft, Tags, ListFilter, ListOrdered } from 'lucide-react';
import type { LightingCategory, LightingUserLibrary } from '@tb/schema';
import { lightingCategoryNavigation } from '@tb/core/link';
import { Ma2ConsoleName } from './Ma2ConsoleName';
import { Button, Disclosure, IconButton, MenuItem, MenuSeparator, TextInput } from '../ui';
import '../lighting-cue-context-menu.css';

const sections = [['front', '面光', Sun], ['rim', '轮廓', ScanLine], ['effect', '效果', Sparkles]] as const;

/**
 * One small menu for both console cues and classified cues. It looks like the shared menu, and also
 * holds two small forms: a new name, and the categories. Category changes stay in the menu until the
 * operator presses 确定.
 */
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
  // Moving between the actions and the categories replaces the buttons, so focus moves with them.
  useEffect(()=>{if(!renaming)root.current?.querySelector<HTMLButtonElement>('button')?.focus({preventScroll:true});},[classifying,renaming]);
  const close=useRef(onClose);close.current=onClose;
  useLayoutEffect(()=>{
    const element=root.current;if(!element)return;
    const place=():void=>{const box=element.getBoundingClientRect();const left=Math.max(8,Math.min(x,window.innerWidth-box.width-8)),top=Math.max(8,Math.min(y,window.innerHeight-box.height-8));setPosition(current=>current.left===left&&current.top===top?current:{left,top});};
    place();const observer=new ResizeObserver(place);observer.observe(element);window.addEventListener('resize',place);
    return()=>{observer.disconnect();window.removeEventListener('resize',place);};
  },[x,y]);
  useEffect(()=>{
    const previous=document.activeElement;
    const outside=(event:PointerEvent):void=>{if(event.target instanceof Node&&!root.current?.contains(event.target))close.current();};
    const escape=(event:KeyboardEvent):void=>{if(event.key==='Escape'){event.preventDefault();close.current();}};
    window.addEventListener('pointerdown',outside,true);window.addEventListener('keydown',escape,true);
    return()=>{window.removeEventListener('pointerdown',outside,true);window.removeEventListener('keydown',escape,true);if(previous instanceof HTMLElement&&previous.isConnected)previous.focus({preventScroll:true});};
  },[]);
  const apply=(action:()=>void):void=>{action();onClose();};
  const pressed=(category:LightingCategory):boolean|'mixed'=>changes[category.id]??(categoryIds.includes(category.id)?true:mixedCategoryIds.includes(category.id)?'mixed':false);
  const toggle=(category:LightingCategory):void=>setChanges(current=>({...current,[category.id]:!(current[category.id]??categoryIds.includes(category.id))}));
  const mark=(category:LightingCategory):JSX.Element|null=>{const state=pressed(category);return state===true?<Check aria-hidden="true"/>:state==='mixed'?<Minus aria-hidden="true"/>:null;};
  const leaves=categories.filter(category=>category.section===section&&(section==='effect'?category.view==='music'||category.view==='beat':category.zone===zone&&(section==='rim'||category.tone===tone)));
  const ordered = lightingCategoryNavigation({ version: 1, categories, entries: [], ...(navigation ? { navigation } : {}) }).filter(item => item.kind === 'category');
  const categoryButton = (category: LightingCategory): JSX.Element => <button type="button" className="cue-menu-chip" key={category.id} aria-pressed={pressed(category)} onClick={() => toggle(category)}>{mark(category)}<span>{category.name}</span></button>;
  const customButtons = (common: boolean): JSX.Element[] => ordered.filter(item => (item.display === 'common') === common).flatMap(item => { const category = categories.find(value => value.id === item.categoryId); return category ? [categoryButton(category)] : []; });
  const common = customButtons(true);
  const more = customButtons(false);
  const choice = <Value extends string>(value: Value, label: string, current: Value | null, pick: (value: Value) => void): JSX.Element => <button type="button" key={value} className="cue-menu-choice" aria-pressed={current === value} onClick={() => pick(value)}>{label}</button>;
  return createPortal(<div ref={root} className="ui-menu lighting-cue-context-menu" data-view={renaming ? 'rename' : classifying ? 'classify' : 'actions'} style={position} role="dialog" aria-label="Cue 右键菜单" onContextMenu={event=>event.preventDefault()} onKeyDown={event=>{
    if(event.key!=='ArrowDown'&&event.key!=='ArrowUp'&&event.key!=='Tab')return;
    if(renaming&&event.key!=='Tab')return;
    const buttons=[...event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),summary')].filter(element=>element.getClientRects().length>0);const index=buttons.indexOf(document.activeElement as HTMLElement);
    event.preventDefault();buttons[(index+(event.key==='ArrowUp'||event.key==='Tab'&&event.shiftKey?-1:1)+buttons.length)%buttons.length]?.focus();
  }}>
    <div className="cue-menu-heading">{classifying && !renaming ? <IconButton size="sm" label="返回右键菜单" icon={ArrowLeft} onClick={() => setClassifying(false)}/> : null}<div className="ui-menu-title cue-menu-title" title={title}>{classifying ? '设置分类' : title}</div></div>
    {renaming?<form className="cue-menu-rename" onSubmit={event=>{event.preventDefault();if(renameBusy)return;setRenameBusy(true);void Promise.resolve().then(()=>onRename?.(name.trim())).then(onClose).catch((cause:unknown)=>setRenameError(cause instanceof Error?cause.message:String(cause))).finally(()=>setRenameBusy(false));}}>
      <TextInput ref={nameInput} aria-label="Cue 名称" value={name} maxLength={512} required disabled={renameBusy} aria-invalid={renameError ? true : undefined} onChange={event=>{setName(event.target.value);setRenameError('');}}/>
      {renamesOnConsole?<Ma2ConsoleName name={name}/>:null}
      {renameError?<p className="cue-menu-error" role="alert">{renameError}</p>:null}
      <footer><Button type="button" variant="ghost" size="sm" disabled={renameBusy} onClick={()=>{setRenaming(false);setName(title);setRenameError('');}}>取消</Button><Button type="submit" variant="primary" size="sm" loading={renameBusy} disabled={!name.trim()||name.trim()===title}>{renameBusy?'正在提交…':'确定'}</Button></footer>
    </form>:!classifying?<div className="ui-menu-items" role="menu" aria-label="Cue 操作">
      {onRestore ? <MenuItem icon={RotateCcw} onSelect={() => apply(onRestore)}>恢复素材</MenuItem> : <>
        {onEdit ? <MenuItem icon={ListOrdered} onSelect={() => apply(onEdit)}>编辑 Cue 步骤</MenuItem> : null}
        {onAttributes ? <MenuItem icon={ListFilter} onSelect={() => apply(onAttributes)}>查看灯具属性</MenuItem> : null}
        <MenuItem icon={Tags} opens onSelect={() => setClassifying(true)}>设置分类</MenuItem>
        {onRename ? <MenuItem icon={Pencil} onSelect={() => setRenaming(true)}>重命名</MenuItem> : null}
        {onAdd ? <MenuItem icon={Plus} onSelect={() => apply(onAdd)}>添加到播放头</MenuItem> : null}
        <MenuSeparator/>
        <MenuItem icon={Trash2} danger title="保留控台 Cue 和已编排歌曲" onSelect={() => apply(onRemove)}>移除素材</MenuItem>
      </>}
    </div>:<>
      <div className="cue-menu-classifications">
        {common.length ? <div className="cue-menu-destinations" aria-label="常用分类">{common}</div> : null}
        {more.length ? <Disclosure className="cue-menu-group" title="更多分类"><div className="cue-menu-destinations" aria-label="更多分类">{more}</div></Disclosure> : null}
        <Disclosure className="cue-menu-group" title="面光、轮廓和效果用途">
          <div className="cue-menu-sections">{sections.map(([value,label,Icon])=><button type="button" key={value} className="cue-menu-choice" data-section={value} aria-pressed={section===value} onClick={()=>{setSection(value);const previous=categories.find(category=>category.section===value&&(changes[category.id]??categoryIds.includes(category.id)));setTone(previous?.tone??null);setZone(previous?.zone??null);}}><Icon aria-hidden="true"/>{label}</button>)}</div>
          {section && section!=='effect'?<>
            {section==='front'?<div className="cue-menu-options" aria-label="亮度">{([['bright','亮调'],['middle','中调'],['dark','暗调']] as const).map(([value,label])=>choice(value,label,tone,setTone))}</div>:null}
            <div className="cue-menu-options" aria-label="区域">{([['front','前区'],['middle','中区'],['back','后区']] as const).map(([value,label])=>choice(value,label,zone,setZone))}</div>
          </>:null}
          {leaves.length ? <div className="cue-menu-leaves" data-section={section??undefined}>{leaves.map(category=><button type="button" key={category.id} className="cue-menu-chip" aria-label={`归入 ${category.section==='front'?'面光':category.section==='rim'?'轮廓':'效果'} ${category.name}`} title={category.name} data-section={category.section} aria-pressed={pressed(category)} onClick={()=>toggle(category)}>{mark(category)}<span>{section==='effect'?category.name:`${category.people}人`}</span></button>)}</div> : null}
        </Disclosure>
      </div>
      <footer><Button variant="ghost" size="sm" onClick={onClose}>取消</Button><Button variant="primary" size="sm" disabled={!Object.keys(changes).length} onClick={()=>apply(()=>onConfirm({add:Object.keys(changes).filter(id=>changes[id]),remove:Object.keys(changes).filter(id=>!changes[id])}))}>确定</Button></footer>
    </>}
  </div>,document.body);
}
