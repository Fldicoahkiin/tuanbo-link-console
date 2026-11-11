import { playbackFramesPerSecond, resolveTimelineClipSpan, timecodeToMilliseconds } from '@tb/core/link';
import type { AudioSegment, LightingDocument, LinkCue, MtcFrameRate, ReferenceMediaClip } from '@tb/schema';
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
  audioEditor?: { selected: unknown; disabled: boolean; split: (timeMs: number) => Promise<void>; remove: () => Promise<void> } | undefined;
  lighting?: Pick<LightingTimelineProps, 'document' | 'selectedClipId' | 'selectedEventId' | 'selectedEventIds' | 'onChange' | 'onSelect'> | undefined;
  onPlayingChange: (playing: boolean) => void;
  onDuplicateClip: (clipId: string, startMs: number) => void;
  onDuplicateCue: (cueId: string, startMs: number) => void;
  onSplitClip: (clipId: string, timeMs: number) => void;
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
 * (`timelineClipboard`), split and duplicate need something selected; Delete and the stop key are always there.
 */
export function timelineEditKeys(props: TimelineKeyProps, clipboard: TimelineTarget | null, setClipboard: (target: TimelineTarget) => void, stop: (() => void) | undefined): KeyHandlers {
  const content = timelineClipboard({ lightingClipSelected: Boolean(props.lighting?.selectedClipId) }) === 'content';
  const selection = { clip: props.selectedClipId, trigger: props.selectedCueId };
  const copied = copyTarget(selection);
  const duplicate = duplicateTarget(selection, props.clips, props.cues, props.frameRate);
  const split = splitTarget({ workbench: props.lightingWorkspace === true, audio: Boolean(props.audioEditor?.selected), audioDisabled: props.audioEditor?.disabled ?? true, clip: props.selectedClipId });
  const copyTo = (target: TimelineTarget, at: number): void => { if (target.kind === 'clip') props.onDuplicateClip(target.id, at); else props.onDuplicateCue(target.id, at); };
  return {
    ...(stop ? { 'transport.stop': stop } : {}),
    ...(content && copied ? { 'edit.copy': () => setClipboard(copied) } : {}),
    ...(content && clipboard ? { 'edit.paste': () => copyTo(clipboard, props.playheadMs) } : {}),
    ...(duplicate ? { 'edit.duplicate': () => { if (duplicate.at !== null) copyTo(duplicate, duplicate.at); } } : {}),
    ...(split ? { 'edit.split': () => { if (split === 'audio') void props.audioEditor?.split(props.playheadMs); else if (props.selectedClipId) props.onSplitClip(props.selectedClipId, props.playheadMs); } } : {}),
    'edit.delete': () => deleteTimelineSelection(props)
  };
}

/**
 * The editor's keys that play and move the playhead (scope `editor`); the lighting workbench has its own, which the
 * user can change (useTimelineStamp). Moving the playhead pauses first. `seekTo` puts the playhead there, without
 * snapping to the edges.
 */
export function editorTransportKeys(props: Pick<TimelineKeyProps, 'playheadMs' | 'frameRate' | 'onPlayingChange'>, playPause: () => void, seekTo: (milliseconds: number) => void): KeyHandlers {
  const step = (milliseconds: number): void => { props.onPlayingChange(false); seekTo(props.playheadMs + milliseconds); };
  const frameMs = 1_000 / playbackFramesPerSecond(props.frameRate);
  return {
    'transport.playPause': playPause,
    'transport.start': () => { props.onPlayingChange(false); seekTo(0); },
    'transport.prevFrame': () => step(-frameMs), 'transport.nextFrame': () => step(frameMs),
    'transport.backMany': () => step(-1_000), 'transport.forwardMany': () => step(1_000)
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
