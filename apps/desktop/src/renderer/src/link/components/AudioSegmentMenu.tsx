import { useEffect, useLayoutEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Scissors, SlidersHorizontal, Trash2, ChevronsLeft, ChevronsRight } from 'lucide-react';
import type { AudioSegment } from '@tb/schema';

export function AudioSegmentMenu({ x,y,segment,playheadMs,disabled,onClose,onEdit,onSplit,onTrim,onRemove }: {
  x:number;y:number;segment:AudioSegment;playheadMs:number;disabled:boolean;
  onClose:()=>void;onEdit:()=>void;onSplit:()=>void;onTrim:(edge:'start'|'end')=>void;onRemove:()=>void;
}):JSX.Element {
  const menu=useRef<HTMLDivElement>(null);
  const inside=playheadMs>segment.startMs&&playheadMs<segment.startMs+segment.durationMs;
  useLayoutEffect(()=>{
    const element=menu.current;if(!element)return;
    const rect=element.getBoundingClientRect();
    element.style.left=`${Math.max(8,Math.min(x,window.innerWidth-rect.width-8))}px`;
    element.style.top=`${Math.max(8,Math.min(y,window.innerHeight-rect.height-8))}px`;
    element.focus();
  },[x,y]);
  useEffect(()=>{
    const close=(event:PointerEvent):void=>{if(event.target instanceof Node&&!menu.current?.contains(event.target))onClose();};
    window.addEventListener('pointerdown',close);window.addEventListener('blur',onClose);window.addEventListener('resize',onClose);
    return()=>{window.removeEventListener('pointerdown',close);window.removeEventListener('blur',onClose);window.removeEventListener('resize',onClose);};
  },[onClose]);
  const run=(action:()=>void):void=>{onClose();action();};
  return createPortal(<div ref={menu} tabIndex={-1} role="menu" aria-label="音频片段菜单" className="timeline-edit-menu" style={{left:x,top:y}} onContextMenu={event=>event.preventDefault()} onPointerDown={event=>event.stopPropagation()} onKeyDown={event=>{
    event.stopPropagation();
    if(event.key==='Escape'){event.preventDefault();onClose();return;}
    if(!['ArrowDown','ArrowUp','Home','End'].includes(event.key))return;
    event.preventDefault();const buttons=[...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
    const current=buttons.findIndex(button=>button===document.activeElement);
    buttons[event.key==='Home'?0:event.key==='End'?buttons.length-1:(current+(event.key==='ArrowUp'?-1:1)+buttons.length)%buttons.length]?.focus();
  }}>
    <button role="menuitem" disabled={disabled} onClick={()=>run(onEdit)}><SlidersHorizontal/><span>编辑片段</span></button>
    <button role="menuitem" disabled={disabled||!inside} onClick={()=>run(onSplit)}><Scissors/><span>在播放头分割</span><kbd>S</kbd></button>
    <button role="menuitem" disabled={disabled||!inside} onClick={()=>run(()=>onTrim('start'))}><ChevronsRight/><span>将开头修剪至播放头</span></button>
    <button role="menuitem" disabled={disabled||!inside} onClick={()=>run(()=>onTrim('end'))}><ChevronsLeft/><span>将结尾修剪至播放头</span></button>
    <hr/><button role="menuitem" className="danger" disabled={disabled} onClick={()=>run(onRemove)}><Trash2/><span>删除音频片段</span><kbd>Delete</kbd></button>
  </div>,document.body);
}
