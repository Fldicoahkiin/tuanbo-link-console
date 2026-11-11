import { ClipboardPaste, Copy, CopyPlus, Scissors, Trash2, SkipBack, SkipForward, Volume2, VolumeX, ChevronsLeft, ChevronsRight } from 'lucide-react';
import { resolveTimelineClipSpan, resolveTimelineCueSpan, timecodeToMilliseconds } from '@tb/core/link';
import type { LinkCue, MtcFrameRate, ReferenceMediaClip, VisualLayer } from '@tb/schema';
import { Menu, MenuItem, MenuSeparator } from '../ui';
import { usePlayheadMs, type EditorPlayhead } from './editor-playhead';

export type TimelineTarget = { kind: 'clip' | 'cue'; id: string };
export type TimelineContext = { target: TimelineTarget | null; x: number; y: number };
type Actions = {
  onDeleteClip: (id: string) => void;
  onDeleteCue: (id: string) => void;
  onDuplicateClip: (id: string, at: number) => void;
  onDuplicateCue: (id: string, at: number) => void;
  onSplitClip: (id: string, at: number) => void;
  onTrim: (target: TimelineTarget, start: number, duration: number) => void;
  onSetClipEmbeddedAudioEnabled: (id: string, enabled: boolean) => void;
};

export function TimelineContextMenu({ context, clipboard, clips, cues, layers, frameRate, playhead, actions, onCopy, onSeek, onClose }: {
  context: TimelineContext; clipboard: TimelineTarget | null; clips: ReferenceMediaClip[]; cues: LinkCue[]; layers: VisualLayer[];
  frameRate: MtcFrameRate; playhead: EditorPlayhead; actions: Actions;
  onCopy: (target: TimelineTarget) => void; onSeek: (at: number) => void; onClose: () => void;
}): JSX.Element {
  // Open for a moment: it follows the playhead every frame, as it did before (0.5.9 E2).
  const playheadMs = usePlayheadMs(playhead);
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
  const trim = (start: number, duration: number): void => { if (target) actions.onTrim(target, start, duration); };
  const name = clip?.label ?? cue?.actions.find((action) => action.kind === 'obs.setProgramScene')?.sceneName ?? cue?.name ?? '时间线';
  return <Menu x={context.x} y={context.y} label="时间线右键菜单" title={locked ? `${name} · 已锁定` : name} onClose={onClose}>
    {target && source ? <>
      <MenuItem icon={Copy} shortcut="Ctrl+C" onSelect={() => run(() => onCopy(target))}>复制</MenuItem>
      <MenuItem icon={CopyPlus} shortcut="Ctrl+D" disabled={locked} onSelect={() => run(() => duplicate(target, span?.endMs ?? startMs ?? playheadMs))}>{span ? '在后方创建副本' : '在原位置创建副本'}</MenuItem>
    </> : null}
    <MenuItem icon={ClipboardPaste} shortcut="Ctrl+V" disabled={!canPaste} onSelect={() => { if (clipboard) run(() => duplicate(clipboard, playheadMs)); }}>粘贴到播放头</MenuItem>
    {target && source ? <>
      <MenuSeparator />
      {clip && span ? <MenuItem icon={Scissors} shortcut="S" disabled={locked || !inside} onSelect={() => run(() => actions.onSplitClip(clip.id, playheadMs))}>在播放头分割</MenuItem> : null}
      {span ? <>
        <MenuItem icon={ChevronsRight} disabled={locked || !inside} onSelect={() => run(() => trim(playheadMs, span.endMs - playheadMs))}>将开头修剪至播放头</MenuItem>
        <MenuItem icon={ChevronsLeft} disabled={locked || !inside} onSelect={() => run(() => trim(span.startMs, playheadMs - span.startMs))}>将结尾修剪至播放头</MenuItem>
      </> : null}
      <MenuItem icon={SkipBack} disabled={startMs === null} onSelect={() => { if (startMs !== null) run(() => onSeek(startMs)); }}>{span ? '定位到开头' : '定位到触发点'}</MenuItem>
      {span ? <MenuItem icon={SkipForward} onSelect={() => run(() => onSeek(span.endMs))}>定位到结尾</MenuItem> : null}
      {clip ? <MenuItem icon={clip.embeddedAudioEnabled === false ? Volume2 : VolumeX} disabled={locked} onSelect={() => run(() => actions.onSetClipEmbeddedAudioEnabled(clip.id, clip.embeddedAudioEnabled === false))}>{clip.embeddedAudioEnabled === false ? '开启素材原声' : '关闭素材原声'}</MenuItem> : null}
      <MenuSeparator />
      <MenuItem icon={Trash2} danger shortcut="Delete" disabled={locked} onSelect={() => run(() => { if (clip) actions.onDeleteClip(clip.id); else if (cue) actions.onDeleteCue(cue.id); })}>删除</MenuItem>
    </> : null}
  </Menu>;
}
