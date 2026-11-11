import { useState, type PointerEvent } from 'react';
import type { AudioSegment, LinkWaveform } from '@tb/schema';
import type { WaveformDisplay } from '../view-models/waveform-draw';
import { dragAudioSegment } from '@tb/core/link';
import type { AudioEditor } from './useAudioEditor';
import { AudioSegmentWaveform } from './AudioSegmentWaveform';
import { AudioSegmentMenu } from './AudioSegmentMenu';
import { ModalSurface } from '../ui/ModalSurface';
import { useDragSession } from './useDragSession';
import { ownKeys } from '../keys/key-owner';
import type { EditorPlayhead } from './editor-playhead';
import { trimAudioToPlayhead } from './timeline-commands';

type Drag = { id: string; edge: 'seek' | 'move' | 'start' | 'end'; clientX: number; segment: AudioSegment; deltaMs: number };
export function AudioTimelineSegments({ waveform, display, editor, pixelsPerSecond, onSelect, onSeek, scrollLeft, viewportWidth, sourceWaveform = false, snapTime, playhead, readOnly = false }: { waveform: LinkWaveform | null; display: WaveformDisplay; editor: Pick<AudioEditor, 'audio' | 'title' | 'segments' | 'selectedId' | 'disabled' | 'busy' | 'points' | 'select' | 'update' | 'remove' | 'split'>; sourceWaveform?: boolean; snapTime?: (ms: number) => number; pixelsPerSecond: number; onSelect: (id: string) => void; onSeek: (ms: number) => void; scrollLeft: number; viewportWidth: number;playhead: EditorPlayhead; readOnly?:boolean }): JSX.Element {
  // Escape, leaving the window and losing the dragged segment end the drag (DragSession).
  const session = useDragSession<Drag>();
  const drag = session.drag;
  const [context,setContext]=useState<{id:string;x:number;y:number}|null>(null);
  const [editing,setEditing]=useState<string|null>(null);
  const contextSegment=editor.segments.find(segment=>segment.id===context?.id);
  const editingSegment=editor.segments.find(segment=>segment.id===editing);
  const seek = (event: PointerEvent<HTMLElement>, segment: AudioSegment): void => {
    const rect=event.currentTarget.closest('.audio-timeline-segment')?.getBoundingClientRect()??event.currentTarget.getBoundingClientRect();
    const position = segment.startMs + (event.clientX - rect.left) / pixelsPerSecond * 1000;
    onSeek(Math.max(segment.startMs, Math.min(segment.startMs + segment.durationMs, position)));
  };
  const begin = (event: PointerEvent<HTMLElement>, segment: AudioSegment, edge: Drag['edge']): void => {
    if (readOnly || event.button !== 0) return;
    event.stopPropagation(); event.currentTarget.closest<HTMLElement>('.audio-timeline-segment')?.focus({ preventScroll: true }); editor.select(segment.id); onSelect(segment.id);
    if (edge === 'move' && editor.disabled) {
      event.preventDefault();
      session.begin(event, { id: segment.id, edge: 'seek', segment, clientX: event.clientX, deltaMs: 0 });
      seek(event, segment);
      return;
    }
    if (editor.disabled) return;
    session.begin(event, { id: segment.id, edge, segment, clientX: event.clientX, deltaMs: 0 });
  };
  const moved=(state:Drag,clientX:number):AudioSegment=>{
    if(state.edge==='seek'||Math.abs(clientX-state.clientX)<4)return state.segment;
    const delta=(clientX-state.clientX)/pixelsPerSecond*1000;
    const anchor=state.edge==='end'?state.segment.startMs+state.segment.durationMs:state.segment.startMs;
    return dragAudioSegment(editor.segments,state.id,state.edge,(snapTime?.(anchor+delta)??anchor+delta)-anchor,editor.audio?.durationMs??0);
  };
  const move = (event: PointerEvent<HTMLElement>): void => {
    const current = session.current();
    if (!current) return;
    event.stopPropagation();
    if (current.edge === 'seek') { seek(event, current.segment); return; }
    const next=moved(current,event.clientX);
    const deltaMs=current.edge==='end'?next.durationMs-current.segment.durationMs:next.startMs-current.segment.startMs;
    session.update({ ...current, deltaMs });
  };
  const end = (event: PointerEvent<HTMLElement>): void => {
    const current = session.current();
    if (!current) return;
    event.stopPropagation();
    const segment = current.segment;
    if (current.edge === 'seek') { seek(event, segment); session.end(); return; }
    const next=moved(current,event.clientX);
    if(next.startMs!==segment.startMs||next.sourceOffsetMs!==segment.sourceOffsetMs||next.durationMs!==segment.durationMs)void editor.update(segment.id,{startMs:next.startMs,sourceOffsetMs:next.sourceOffsetMs,durationMs:next.durationMs});
    else if(current.edge==='move'&&Math.abs(event.clientX-current.clientX)<4)seek(event,segment);
    session.end();
  };
  return <>
    {editor.segments.map((segment, index) => {
      const active = drag?.id === segment.id ? drag : null;
      const start = segment.startMs + (active?.edge === 'move' || active?.edge === 'start' ? active.deltaMs : 0);
      const duration = segment.durationMs + (active?.edge === 'end' ? active.deltaMs : active?.edge === 'start' ? -active.deltaMs : 0);
      return <div key={segment.id} className={`audio-timeline-segment${!readOnly && editor.selectedId === segment.id ? ' selected' : ''}`} role={readOnly ? undefined : "button"} tabIndex={readOnly ? undefined : 0} aria-label={readOnly ? "歌曲参考波形" : `音频片段 ${index + 1}`} aria-pressed={readOnly ? undefined : editor.selectedId===segment.id} aria-disabled={editor.disabled} aria-busy={editor.busy} title={readOnly ? undefined : `音频片段 ${index + 1} · 单击定位，拖动移动，两端裁剪，右键编辑`} style={{ left: Math.max(0, start) / 1000 * pixelsPerSecond, width: Math.max(2, duration / 1000 * pixelsPerSecond),cursor:readOnly?'crosshair':editor.busy?'progress':editor.disabled?'crosshair':'grab' }}
        onPointerDown={(event) => begin(event, segment, 'move')} onPointerMove={move} onPointerUp={end} onPointerCancel={session.end} onLostPointerCapture={session.end}
        onContextMenu={(event) => { if(readOnly)return; event.preventDefault(); event.stopPropagation(); event.currentTarget.focus();editor.select(segment.id); onSelect(segment.id);setContext({id:segment.id,x:event.clientX,y:event.clientY}); }}
        onDoubleClick={event=>{if(readOnly)return;event.stopPropagation();if(!editor.disabled)setEditing(segment.id);}}
        // Its own keys: Enter selects it, Delete and Backspace delete it once selected. S splits the selected segment
        // at the playhead with the timeline's other editing keys (keymap.ts `edit.split`, ReferenceTimeline).
        {...(readOnly ? {} : ownKeys('Enter', 'Delete', 'Backspace'))}
        onKeyDown={(event) => { if(readOnly)return; if (event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); editor.select(segment.id); onSelect(segment.id); } if(editor.disabled||editor.selectedId!==segment.id)return; if (event.key === 'Delete'||event.key==='Backspace') { event.preventDefault(); event.stopPropagation(); void editor.remove(); } }}>
        <AudioSegmentWaveform waveform={waveform} display={display} sourceStartMs={(sourceWaveform ? segment.sourceOffsetMs : segment.startMs) + (active?.edge === 'start' ? active.deltaMs : 0)} durationMs={duration} startMs={start} pixelsPerSecond={pixelsPerSecond} scrollLeft={scrollLeft} viewportWidth={viewportWidth} />
        {duration / 1000 * pixelsPerSecond > 65 ? <span className="audio-segment-name" style={{ left: Math.max(8, scrollLeft - start / 1000 * pixelsPerSecond + 8) }}>{editor.title}{editor.busy ? <small role="status">处理中…</small> : null}<small>{(duration / 1000).toFixed(2)}s</small></span> : null}
        {!readOnly ? <><span className="audio-trim-handle start" title="调整音频起点" onPointerDown={(event) => begin(event, segment, 'start')} />
        <span className="audio-trim-handle end" title="调整音频终点" onPointerDown={(event) => begin(event, segment, 'end')} /></> : null}
      </div>;
    })}
    {!readOnly&&context&&contextSegment?<AudioSegmentMenu {...context} segment={contextSegment} playhead={playhead} disabled={editor.disabled} onClose={()=>setContext(null)} onEdit={()=>setEditing(contextSegment.id)} onSplit={()=>{void editor.split(playhead.read());}} onRemove={()=>{void editor.remove();}} onTrim={edge=>{void editor.update(contextSegment.id,trimAudioToPlayhead(contextSegment,playhead.read(),edge));}}/>:null}
    {!readOnly&&editingSegment?<ModalSurface label="编辑音频片段" className="cue-point-dialog" onClose={()=>setEditing(null)}><form className="effect-binding-form" onSubmit={event=>{event.preventDefault();const values=new FormData(event.currentTarget);void editor.update(editingSegment.id,{startMs:Math.round(Number(values.get('start'))*1000),sourceOffsetMs:Math.round(Number(values.get('offset'))*1000),durationMs:Math.round(Number(values.get('duration'))*1000)});setEditing(null);}}><h3>编辑音频片段</h3><label>位置（秒）<input name="start" type="number" min="0" step="0.001" defaultValue={editingSegment.startMs/1000} required/></label><label>素材入点（秒）<input name="offset" type="number" min="0" step="0.001" defaultValue={editingSegment.sourceOffsetMs/1000} required/></label><label>时长（秒）<input name="duration" type="number" min="0.001" step="0.001" defaultValue={editingSegment.durationMs/1000} required/></label><footer><button type="button" onClick={()=>setEditing(null)}>取消</button><button disabled={editor.disabled}>应用</button></footer></form></ModalSurface>:null}
    {editor.points.filter((time) => time / 1000 * pixelsPerSecond >= scrollLeft - 8 && time / 1000 * pixelsPerSecond <= scrollLeft + viewportWidth + 8).map((time) => <button className="audio-beat-marker" key={time} aria-label={`节拍 ${(time / 1000).toFixed(3)} 秒`} title={`节拍 ${(time / 1000).toFixed(3)} 秒 · 点击定位`} style={{ left: time / 1000 * pixelsPerSecond }} onPointerDown={(event) => event.stopPropagation()} onClick={(event) => { event.stopPropagation(); onSeek(time); }} />)}
  </>;
}
