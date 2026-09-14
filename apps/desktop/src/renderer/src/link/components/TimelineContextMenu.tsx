import { useLayoutEffect, useRef, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { ClipboardPaste, Copy, CopyPlus, Scissors, Trash2, SkipBack, SkipForward, Volume2, VolumeX, ChevronsLeft, ChevronsRight } from 'lucide-react';
import { resolveTimelineClipSpan, resolveTimelineCueSpan, timecodeToMilliseconds } from '@tb/core/link';
import type { LinkCue, MtcFrameRate, ReferenceMediaClip, VisualLayer } from '@tb/schema';

export type TimelineTarget = { kind: 'clip' | 'cue'; id: string };
export type TimelineContext = { target: TimelineTarget | null; x: number; y: number };
type Actions = {
  onDeleteClip: (id: string) => void;
  onDeleteCue: (id: string) => void;
  onDuplicateClip: (id: string, at: number) => void;
  onDuplicateCue: (id: string, at: number) => void;
  onSplitClip: (id: string, at: number) => void;
  onTrimClip: (id: string, start: number, duration: number) => void;
  onTrimCue: (id: string, start: number, duration: number) => void;
  onSetClipEmbeddedAudioEnabled: (id: string, enabled: boolean) => void;
};

export function TimelineContextMenu({ context, clipboard, clips, cues, layers, frameRate, playheadMs, actions, onCopy, onSeek, onClose }: {
  context: TimelineContext; clipboard: TimelineTarget | null; clips: ReferenceMediaClip[]; cues: LinkCue[]; layers: VisualLayer[];
  frameRate: MtcFrameRate; playheadMs: number; actions: Actions;
  onCopy: (target: TimelineTarget) => void; onSeek: (at: number) => void; onClose: () => void;
}): JSX.Element {
  const menu = useRef<HTMLDivElement>(null);
  const target = context.target;
  const clip = target?.kind === 'clip' ? clips.find((entry) => entry.id === target.id) : undefined;
  const cue = target?.kind === 'cue' ? cues.find((entry) => entry.id === target.id) : undefined;
  const source = clip ?? cue;
  const span = clip ? resolveTimelineClipSpan(clip, frameRate) : cue?.durationMs !== undefined ? resolveTimelineCueSpan(cue, frameRate) : null;
  const startMs = span?.startMs ?? (cue ? timecodeToMilliseconds(cue.timecode, frameRate) : null);
  const locked = layers.some((layer) => layer.id === source?.layerId && layer.locked);
  const copied = clipboard?.kind === 'clip' ? clips.find((entry) => entry.id === clipboard.id) : cues.find((entry) => entry.id === clipboard?.id);
  const canPaste = Boolean(copied) && !layers.some((layer) => layer.id === copied?.layerId && layer.locked);
  const inside = span !== null && playheadMs > span.startMs && playheadMs < span.endMs;
  const run = (action: () => void): void => { onClose(); action(); };
  const duplicate = (item: TimelineTarget, at: number): void => { if (item.kind === 'clip') actions.onDuplicateClip(item.id, at); else actions.onDuplicateCue(item.id, at); };
  const trim = (start: number, duration: number): void => { if (clip) actions.onTrimClip(clip.id, start, duration); else if (cue) actions.onTrimCue(cue.id, start, duration); };
  useLayoutEffect(() => {
    const element = menu.current;
    if (!element) return;
    const bounds = element.getBoundingClientRect();
    element.style.left = `${Math.max(8, Math.min(context.x, window.innerWidth - bounds.width - 8))}px`;
    element.style.top = `${Math.max(8, Math.min(context.y, window.innerHeight - bounds.height - 8))}px`;
    element.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
  }, [context]);
  const keyboard = (event: KeyboardEvent<HTMLDivElement>): void => {
    event.stopPropagation();
    if (event.key === 'Escape' || event.key === 'Tab') { event.preventDefault(); onClose(); return; }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
    const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (current + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
    buttons[next]?.focus();
  };
  return createPortal(<div ref={menu} role="menu" aria-label="时间线右键菜单" className="timeline-edit-menu" style={{ left: context.x, top: context.y }} onKeyDown={keyboard} onContextMenu={(event) => event.preventDefault()} onPointerDown={(event) => event.stopPropagation()}>
    <div className="timeline-menu-title">{clip?.label ?? cue?.actions.find((action) => action.kind === 'obs.setProgramScene')?.sceneName ?? cue?.name ?? '时间线'}{locked ? ' · 已锁定' : ''}</div>
    {target && source ? <>
      <button role="menuitem" onClick={() => run(() => onCopy(target))}><Copy /><span>复制</span><kbd>Ctrl+C</kbd></button>
      <button role="menuitem" disabled={locked} onClick={() => run(() => duplicate(target, span?.endMs ?? startMs ?? playheadMs))}><CopyPlus /><span>{span ? '在后方创建副本' : '在原位置创建副本'}</span><kbd>Ctrl+D</kbd></button>
    </> : null}
    <button role="menuitem" disabled={!canPaste} onClick={() => clipboard && run(() => duplicate(clipboard, playheadMs))}><ClipboardPaste /><span>粘贴到播放头</span><kbd>Ctrl+V</kbd></button>
    {target && source ? <>
      <hr />
      {clip && span ? <button role="menuitem" disabled={locked || !inside} onClick={() => run(() => actions.onSplitClip(clip.id, playheadMs))}><Scissors /><span>在播放头分割</span><kbd>S</kbd></button> : null}
      {span ? <>
        <button role="menuitem" disabled={locked || !inside} onClick={() => run(() => trim(playheadMs, span.endMs - playheadMs))}><ChevronsRight /><span>将开头修剪至播放头</span></button>
        <button role="menuitem" disabled={locked || !inside} onClick={() => run(() => trim(span.startMs, playheadMs - span.startMs))}><ChevronsLeft /><span>将结尾修剪至播放头</span></button>
      </> : null}
      <button role="menuitem" disabled={startMs === null} onClick={() => startMs !== null && run(() => onSeek(startMs))}><SkipBack /><span>{span ? '定位到开头' : '定位到触发点'}</span></button>
      {span ? <button role="menuitem" onClick={() => run(() => onSeek(span.endMs))}><SkipForward /><span>定位到结尾</span></button> : null}
      {clip ? <button role="menuitem" disabled={locked} onClick={() => run(() => actions.onSetClipEmbeddedAudioEnabled(clip.id, clip.embeddedAudioEnabled === false))}>{clip.embeddedAudioEnabled === false ? <Volume2 /> : <VolumeX />}<span>{clip.embeddedAudioEnabled === false ? '开启素材原声' : '关闭素材原声'}</span></button> : null}
      <hr />
      <button role="menuitem" className="danger" disabled={locked} onClick={() => run(() => { if (clip) actions.onDeleteClip(clip.id); else if (cue) actions.onDeleteCue(cue.id); })}><Trash2 /><span>删除</span><kbd>Delete</kbd></button>
    </> : null}
  </div>, document.body);
}
