import { playbackFramesPerSecond, resolveTimelineClipSpan, timecodeToMilliseconds } from '@tb/core/link';
import type { AudioSegment, LightingDocument, LinkCue, MtcFrameRate, ReferenceMediaClip, VisualLayer } from '@tb/schema';
import type { KeyHandlers } from '../keys/key-router';
import type { LightingTimelineProps } from './LightingTimeline';

/*
 * What the editing keys of the editor's and the lighting workbench's timeline act on, decided in one place (04 设计
 * 4.1, K6). The key router (keys/key-router.ts) says which page and which part of the timeline a key goes to; these
 * say what is selected there, which one of the selected things a key acts on, and the playhead's edit points and
 * trims the toolbar and the right-click menus share with the keys.
 */

/**
 * What can be selected on the timeline, in the order the editing keys look at them, the first first:
 * - `marker`: a timeline marker with the focus on it, which deletes and renames itself (TimelineMarkers, its own keys);
 * - `cue-points`: the lighting workbench's Cue points, selected or focused (WaveformCuePoints);
 * - `audio`: an audio segment (the editor's; the workbench's waveform is read only);
 * - `lighting-points`: lighting points (LightingTimeline);
 * - `content-clip`: a camera or media clip of the editor's content tracks;
 * - `trigger`: a trigger point (a Cue of the content timeline).
 */
export const TIMELINE_SELECTION_ORDER = ['marker', 'cue-points', 'audio', 'lighting-points', 'content-clip', 'trigger'] as const;
export type TimelineSelectionKind = (typeof TIMELINE_SELECTION_ORDER)[number];

/** What is selected, as the part of the page that knows it says; what it does not know is left out. */
export type TimelineSelectionFacts = {
  /** The lighting workbench, where the audio is read only. */
  workbench: boolean;
  marker?: boolean;
  cuePoints?: boolean;
  audio?: boolean;
  lightingPoints?: boolean;
  clip?: string | null;
  trigger?: string | null;
};

/**
 * Which of the selected things the editing keys act on: one, the first of `TIMELINE_SELECTION_ORDER`. One Delete
 * deletes one kind of thing, never the audio segment and the clip together (04 设计 3.3 d).
 */
export function timelineSelection(facts: TimelineSelectionFacts): TimelineSelectionKind | null {
  const selected: Readonly<Record<TimelineSelectionKind, boolean>> = {
    marker: facts.marker === true,
    'cue-points': facts.cuePoints === true,
    audio: !facts.workbench && facts.audio === true,
    'lighting-points': facts.lightingPoints === true,
    'content-clip': Boolean(facts.clip),
    trigger: Boolean(facts.trigger)
  };
  return TIMELINE_SELECTION_ORDER.find(kind => selected[kind]) ?? null;
}

/**
 * What Delete deletes among the lighting workbench's Cue points (WaveformCuePoints): the selected ones, else the focused
 * one if it can be changed, else none of them (the key goes on to the timeline and the lighting points).
 */
export function cuePointsToDelete(selection: readonly string[], focused: string | undefined): { kind: 'selection'; ids: readonly string[] } | { kind: 'focused'; id: string } | null {
  if (selection.length) return { kind: 'selection', ids: selection };
  return focused === undefined ? null : { kind: 'focused', id: focused };
}

/**
 * Which clipboard copy, cut and paste use: the lighting points' while a lighting clip is selected (the clipboard of
 * LightingTimeline, kept across the pages), the content clips' and trigger points' otherwise (the timeline's own,
 * emptied when the song changes). A copy never lands in the other one, and paste takes from the one it copied to
 * (04 设计 3.3 b).
 */
export function timelineClipboard(facts: { lightingClipSelected: boolean }): 'lighting' | 'content' {
  return facts.lightingClipSelected ? 'lighting' : 'content';
}

/** A content clip or trigger point, as the timeline's clipboard and its right-click menu hold it. */
export type TimelineTarget = { kind: 'clip' | 'cue'; id: string };

/** What Ctrl+C copies to the content clipboard: the selected clip, else the selected trigger point. */
export function copyTarget(selection: { clip: string | null; trigger: string | null }): TimelineTarget | null {
  if (selection.clip) return { kind: 'clip', id: selection.clip };
  return selection.trigger ? { kind: 'cue', id: selection.trigger } : null;
}

/**
 * What Ctrl+D copies and where the copy goes: right after the selected clip, or after the selected trigger point and its
 * length. `at` is null when the selected one is gone from the song (the key is taken all the same).
 */
export function duplicateTarget(selection: { clip: string | null; trigger: string | null }, clips: readonly ReferenceMediaClip[], cues: readonly LinkCue[], frameRate: MtcFrameRate): (TimelineTarget & { at: number | null }) | null {
  if (selection.clip) {
    const source = clips.find(clip => clip.id === selection.clip);
    return { kind: 'clip', id: selection.clip, at: source ? resolveTimelineClipSpan(source, frameRate).endMs : null };
  }
  if (!selection.trigger) return null;
  const source = cues.find(cue => cue.id === selection.trigger);
  return { kind: 'cue', id: selection.trigger, at: source ? timecodeToMilliseconds(source.timecode, frameRate) + (source.durationMs ?? 0) : null };
}

/**
 * What the split key splits at the playhead: the selected audio segment in the editor, while the audio can be edited;
 * else the selected content clip; else nothing.
 */
export function splitTarget(facts: { workbench: boolean; audio: boolean; audioDisabled: boolean; clip: string | null }): 'audio' | 'content-clip' | null {
  if (!facts.workbench && facts.audio && !facts.audioDisabled) return 'audio';
  return facts.clip ? 'content-clip' : null;
}

/** The lighting points `ids` taken out of the selected lighting clip, and where the selection goes after them. */
export type RemovedLightingPoints = { document: LightingDocument; trackId: string; clipId: string };

/**
 * Deleting the selected lighting points (Delete in the timeline, Delete or Backspace elsewhere on the page): the one
 * way both keys delete them. Nothing on a locked track, nor without a selected lighting clip.
 */
export function removeLightingPoints(document: LightingDocument, clipId: string | null, ids: readonly string[]): RemovedLightingPoints | null {
  const track = clipId === null ? undefined : document.tracks.find(entry => entry.clips.some(clip => clip.id === clipId));
  if (!track || track.locked || clipId === null) return null;
  const removed = new Set(ids);
  return {
    document: { ...document, tracks: document.tracks.map(entry => entry.id === track.id ? { ...entry, clips: entry.clips.map(clip => clip.id === clipId ? { ...clip, events: clip.events.filter(event => !removed.has(event.id)) } : clip) } : entry) },
    trackId: track.id,
    clipId
  };
}

/** What the timeline's keys are told of the timeline (ReferenceTimeline's props): `playheadMs` is read when a key acts. */
export type TimelineKeyProps = {
  lightingWorkspace?: boolean | undefined;
  readonly playheadMs: number;
  frameRate: MtcFrameRate;
  clips: readonly ReferenceMediaClip[];
  cues: readonly LinkCue[];
  selectedClipId: string | null;
  selectedCueId: string | null;
  /** The editor's tracks: a clip or trigger point on a locked one is not split or trimmed by the keys. Left out: none locked. */
  layers?: readonly Pick<VisualLayer, 'id' | 'locked'>[] | undefined;
  audioEditor?: {
    selected: Pick<AudioSegment, 'id' | 'startMs' | 'durationMs' | 'sourceOffsetMs'> | null | undefined; segments: readonly Pick<AudioSegment, 'startMs' | 'durationMs'>[];
    disabled: boolean; split: (timeMs: number) => Promise<void>; remove: () => Promise<void>;
    update: (id: string, patch: Partial<Pick<AudioSegment, 'startMs' | 'durationMs' | 'sourceOffsetMs'>>) => Promise<void>;
  } | undefined;
  lighting?: Pick<LightingTimelineProps, 'document' | 'selectedClipId' | 'selectedEventId' | 'selectedEventIds' | 'onChange' | 'onSelect'> | undefined;
  onPlayingChange: (playing: boolean) => void;
  onDuplicateClip: (clipId: string, startMs: number) => void;
  onDuplicateCue: (cueId: string, startMs: number) => void;
  /** `group`: the splits of one key press that are undone together (Ctrl+Shift+B); they leave the selection alone. */
  onSplitClip: (clipId: string, timeMs: number, group?: string) => void;
  onTrim: (ref: TimelineTarget, startMs: number, durationMs: number) => void;
  onDeleteClip: (clipId: string) => void;
  onDeleteCue: (cueId: string) => void;
};

/** Delete in the timeline: the one kind of thing `timelineSelection` says, the first that is selected. */
export function deleteTimelineSelection(props: TimelineKeyProps): void {
  const lighting = props.lighting;
  const kind = timelineSelection({ workbench: props.lightingWorkspace === true, audio: Boolean(props.audioEditor?.selected), lightingPoints: Boolean(lighting?.selectedEventId), clip: props.selectedClipId, trigger: props.selectedCueId });
  switch (kind) {
    case 'audio': if (props.audioEditor && !props.audioEditor.disabled) void props.audioEditor.remove(); return;
    case 'lighting-points': {
      if (!lighting?.selectedEventId) return;
      const removed = removeLightingPoints(lighting.document, lighting.selectedClipId, lighting.selectedEventIds ?? [lighting.selectedEventId]);
      if (!removed) return;
      lighting.onChange(removed.document, '删除灯光点');
      lighting.onSelect(removed.trackId, removed.clipId);
      return;
    }
    case 'content-clip': if (props.selectedClipId) props.onDeleteClip(props.selectedClipId); return;
    case 'trigger': if (props.selectedCueId) props.onDeleteCue(props.selectedCueId); return;
    // Markers and Cue points delete themselves (TimelineMarkers, WaveformCuePoints), before the timeline is asked.
    case 'marker': case 'cue-points': case null: return;
  }
}

/**
 * The timeline's editing keys (keymap.ts, scope `timeline`), each there only while it has something to act on, as the
 * timeline's own listener did before the key router (K6): copy and paste leave the lighting points' clipboard to them
 * (`timelineClipboard`), split and duplicate need something selected; Delete is always there.
 */
export function timelineEditKeys(props: TimelineKeyProps, clipboard: TimelineTarget | null, setClipboard: (target: TimelineTarget) => void): KeyHandlers {
  const content = timelineClipboard({ lightingClipSelected: Boolean(props.lighting?.selectedClipId) }) === 'content';
  const selection = { clip: props.selectedClipId, trigger: props.selectedCueId };
  const copied = copyTarget(selection);
  const duplicate = duplicateTarget(selection, props.clips, props.cues, props.frameRate);
  const split = splitTarget({ workbench: props.lightingWorkspace === true, audio: Boolean(props.audioEditor?.selected), audioDisabled: props.audioEditor?.disabled ?? true, clip: props.selectedClipId });
  const copyTo = (target: TimelineTarget, at: number): void => { if (target.kind === 'clip') props.onDuplicateClip(target.id, at); else props.onDuplicateCue(target.id, at); };
  return {
    ...(content && copied ? { 'edit.copy': () => setClipboard(copied) } : {}),
    ...(content && clipboard ? { 'edit.paste': () => copyTo(clipboard, props.playheadMs) } : {}),
    ...(duplicate ? { 'edit.duplicate': () => { if (duplicate.at !== null) copyTo(duplicate, duplicate.at); } } : {}),
    ...(split ? { 'edit.split': () => { if (split === 'audio') void props.audioEditor?.split(props.playheadMs); else if (props.selectedClipId) props.onSplitClip(props.selectedClipId, props.playheadMs); } } : {}),
    'edit.delete': () => deleteTimelineSelection(props)
  };
}

/** Whether the clip or trigger point `id` is on a locked track. */
function onLockedTrack(props: TimelineKeyProps, target: TimelineTarget): boolean {
  const layerId = target.kind === 'clip' ? props.clips.find(clip => clip.id === target.id)?.layerId : props.cues.find(cue => cue.id === target.id)?.layerId;
  return layerId !== undefined && (props.layers ?? []).some(layer => layer.id === layerId && layer.locked);
}

/** Where the selected clip or trigger point (with a length) starts and ends, or null without one. */
function selectedSpan(props: TimelineKeyProps): { target: TimelineTarget; span: { startMs: number; endMs: number } } | null {
  const clip = props.selectedClipId ? props.clips.find(entry => entry.id === props.selectedClipId) : undefined;
  if (clip) return { target: { kind: 'clip', id: clip.id }, span: resolveTimelineClipSpan(clip, props.frameRate) };
  const cue = props.selectedCueId ? props.cues.find(entry => entry.id === props.selectedCueId) : undefined;
  if (!cue || cue.durationMs === undefined) return null;
  const startMs = timecodeToMilliseconds(cue.timecode, props.frameRate);
  return { target: { kind: 'cue', id: cue.id }, span: { startMs, endMs: startMs + cue.durationMs } };
}

const inside = (span: { startMs: number; endMs: number }, ms: number): boolean => ms > span.startMs && ms < span.endMs;

/**
 * The editor's keys that cut at the playhead (scope `editor`, 剪映's Q, W and Ctrl+Shift+B): Q and W trim the selected
 * audio segment, else the selected clip or trigger point, to the playhead, the same trims as the right-click menus'
 * 「将开头/结尾修剪至播放头」 (`trimToPlayhead`, `trimAudioToPlayhead`); Ctrl+Shift+B splits every clip the playhead is
 * in, and the audio there. Nothing on a locked track or with the playhead outside; the key is taken all the same.
 */
export function editorEditKeys(props: TimelineKeyProps): KeyHandlers {
  const trim = (side: TrimSide): void => {
    const at = props.playheadMs, audio = props.audioEditor;
    if (audio?.selected && !audio.disabled && timelineSelection({ workbench: false, audio: true, clip: props.selectedClipId, trigger: props.selectedCueId }) === 'audio') {
      const segment = audio.selected;
      if (inside({ startMs: segment.startMs, endMs: segment.startMs + segment.durationMs }, at)) void audio.update(segment.id, trimAudioToPlayhead(segment, at, side));
      return;
    }
    const selected = selectedSpan(props);
    if (!selected || onLockedTrack(props, selected.target) || !inside(selected.span, at)) return;
    const trimmed = trimToPlayhead(selected.span, at, side);
    props.onTrim(selected.target, trimmed.startMs, trimmed.durationMs);
  };
  return {
    'edit.trimLeft': () => trim('start'),
    'edit.trimRight': () => trim('end'),
    'edit.splitAll': () => {
      // One press, one step back: every clip's split goes into the same undo step (the audio's is its own, it is
      // saved through the audio editor).
      const at = props.playheadMs, group = `split-all:${crypto.randomUUID()}`;
      for (const clip of props.clips) {
        if (!onLockedTrack(props, { kind: 'clip', id: clip.id }) && inside(resolveTimelineClipSpan(clip, props.frameRate), at)) props.onSplitClip(clip.id, at, group);
      }
      const audio = props.audioEditor;
      if (audio && !audio.disabled && audio.segments.some(segment => inside({ startMs: segment.startMs, endMs: segment.startMs + segment.durationMs }, at))) void audio.split(at);
    }
  };
}

/**
 * Where a key moves the playhead to: `from` is where the last key put it (a seek not drawn yet included), `to` puts it
 * there. ReferenceTimeline merges the seeks of a held key into one per frame drawn (`useFrameValue`, 04 设计 4.9), so
 * holding → does not ask OBS to seek thirty times a second.
 */
export type TimelineSeek = { from: () => number; to: (milliseconds: number) => void };

/** How many frames Shift+← and Shift+→ move (剪映's 多帧, to be checked at the venue). */
export const MANY_FRAMES = 5;

/**
 * The editor's keys that play and move the playhead (scope `editor`); the lighting workbench has its own, which the
 * user can change (useTimelineStamp). Moving the playhead pauses first. The playhead is put there without snapping to
 * the edges.
 */
export function editorTransportKeys(props: Pick<TimelineKeyProps, 'frameRate' | 'onPlayingChange'> & { durationMs: number }, playPause: () => void, seek: TimelineSeek): KeyHandlers {
  const go = (milliseconds: number): void => { props.onPlayingChange(false); seek.to(milliseconds); };
  const frameMs = 1_000 / playbackFramesPerSecond(props.frameRate);
  return {
    'transport.playPause': playPause,
    'transport.start': () => go(0), 'transport.end': () => go(props.durationMs),
    'transport.prevFrame': () => go(seek.from() - frameMs), 'transport.nextFrame': () => go(seek.from() + frameMs)
  };
}

/**
 * The keys both timelines share that play, pause and move the playhead (scope `timeline`): K pauses and L plays
 * (剪映's J/K/L, without the reverse play or the speeding up), Shift+←/→ move `MANY_FRAMES` frames, ↑↓ go to the
 * previous or next edit point (the toolbar's 「定位」 menu). Moving pauses first.
 */
export function timelineTransportKeys(facts: { frameRate: MtcFrameRate; durationMs: number; editPoints: readonly number[]; playing: boolean },
  controls: { playPause: () => void; onPlayingChange: (playing: boolean) => void; seek: TimelineSeek }): KeyHandlers {
  const go = (milliseconds: number): void => { controls.onPlayingChange(false); controls.seek.to(Math.max(0, Math.min(facts.durationMs, milliseconds))); };
  const frameMs = 1_000 / playbackFramesPerSecond(facts.frameRate);
  return {
    'transport.pause': () => { if (facts.playing) controls.onPlayingChange(false); },
    'transport.play': () => { if (!facts.playing) controls.playPause(); },
    'transport.backMany': () => go(controls.seek.from() - MANY_FRAMES * frameMs),
    'transport.forwardMany': () => go(controls.seek.from() + MANY_FRAMES * frameMs),
    'transport.prevEditPoint': () => go(previousEditPoint(facts.editPoints, controls.seek.from(), facts.frameRate)),
    'transport.nextEditPoint': () => go(nextEditPoint(facts.editPoints, controls.seek.from(), facts.frameRate, facts.durationMs))
  };
}

/** Half a frame: an edit point closer to the playhead than that is where the playhead already is. */
const halfFrameMs = (frameRate: MtcFrameRate): number => 1_000 / playbackFramesPerSecond(frameRate) / 2;

/** The edit point before the playhead (the toolbar's 「上一剪辑点」), or the start. */
export function previousEditPoint(points: readonly number[], playheadMs: number, frameRate: MtcFrameRate): number {
  return [...points].filter(point => point < playheadMs - halfFrameMs(frameRate)).sort((a, b) => b - a)[0] ?? 0;
}

/** The edit point after the playhead (the toolbar's 「下一剪辑点」), or the end. */
export function nextEditPoint(points: readonly number[], playheadMs: number, frameRate: MtcFrameRate, durationMs: number): number {
  return [...points].filter(point => point > playheadMs + halfFrameMs(frameRate)).sort((a, b) => a - b)[0] ?? durationMs;
}

/** Which end of a clip a trim to the playhead moves: 「将开头修剪至播放头」 the start, 「将结尾修剪至播放头」 the end. */
export type TrimSide = 'start' | 'end';

/** A content clip or trigger point trimmed to the playhead: where it starts and how long it is after it. */
export function trimToPlayhead(span: { startMs: number; endMs: number }, playheadMs: number, side: TrimSide): { startMs: number; durationMs: number } {
  return side === 'start' ? { startMs: playheadMs, durationMs: span.endMs - playheadMs } : { startMs: span.startMs, durationMs: playheadMs - span.startMs };
}

/** An audio segment trimmed to the playhead, on whole milliseconds: what changes of it. */
export function trimAudioToPlayhead(segment: Pick<AudioSegment, 'startMs' | 'durationMs' | 'sourceOffsetMs'>, playheadMs: number, side: TrimSide): Partial<Pick<AudioSegment, 'startMs' | 'durationMs' | 'sourceOffsetMs'>> {
  const at = Math.round(playheadMs);
  return side === 'start'
    ? { startMs: at, sourceOffsetMs: segment.sourceOffsetMs + at - segment.startMs, durationMs: segment.startMs + segment.durationMs - at }
    : { durationMs: at - segment.startMs };
}

/**
 * Whether a click on the timeline toolbar gives the keys back to the timeline, so the timeline's keys keep working after
 * a button was clicked with the mouse (0.5.9): the timeline's editing keys leave the toolbar's buttons alone. A button
 * pressed from the keyboard keeps the focus. So does a button that opens a menu or a panel: the menu takes the focus,
 * and the panel closes on Escape and gives the focus back to its button. `aria-expanded` is read before the page
 * redraws, so "true" means this click closes the panel. Clicks in a menu or panel the toolbar opened come through the
 * toolbar on the page but are not in it.
 */
export function keysBackToTimeline<B extends { getAttribute(name: string): string | null }>(click: { detail: number; target: { closest(selectors: 'button'): B | null } | null },
  toolbar: { contains(button: B): boolean }): boolean {
  const button = click.target?.closest('button') ?? null;
  if (click.detail === 0 || button === null || !toolbar.contains(button)) return false;
  return button.getAttribute('aria-haspopup') === null || button.getAttribute('aria-expanded') === 'true';
}
