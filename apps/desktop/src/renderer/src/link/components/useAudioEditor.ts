import { useEffect, useMemo, useRef, useState } from 'react';
import { audioTracks, audioTracksEndMs, editedSongDurationMs, editReferenceAudioCommand, setReferenceAudioCommand, songBeats, songBeatsAtDensity, splitAudioSegments, updateAudioSegment } from '@tb/core/link';
import { referenceAudioSchema, type AudioBeatLevel, type AudioSegment, type AudioTrack, type RundownItem } from '@tb/schema';
import { useDocumentStore } from '../stores/document-store';
import { useRuntimeStore } from '../stores/runtime-store';
import { linkDesktopViewModel } from '../view-models/link-desktop-view-model';
import { songBeatSnapPoints } from './timeline-snap-points';

export function useAudioEditor(item: RundownItem | null, projectPath: string | null, disabled: boolean, notify: (message: string, tone?: 'info' | 'error') => void, beforeEdit?: () => Promise<void>) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedTrackId, setSelectedTrackId] = useState<string | null>(null);
  // How densely the beats are shown and split at; decided here and never saved.
  const [level, setLevel] = useState<AudioBeatLevel>('standard');
  const [busy, setBusy] = useState(false);
  const processing = useRef(false);
  const audio = item?.referenceAudio;
  useEffect(() => { setSelectedId(null); }, [item?.id]);
  const tracks = audio ? audioTracks(audio, item?.title) : [];
  const activeTrack = tracks.find(track => track.id === selectedTrackId) ?? tracks[0];
  const segments = activeTrack?.segments ?? [];
  const selected = segments.find((segment) => segment.id === selectedId) ?? null;
  // The song's beats come from songBeats(item), the same as in the lighting workspace (useMusicBeatSegments); they
  // are recognised and cleared there, by the 音乐识别 panel of either page.
  const beats = item ? songBeats(item) : undefined;
  const shown = beats?.state === 'ready' ? songBeatsAtDensity(beats.beats, level) : null;
  const points = useMemo(() => shown ? shown.map(beat => beat.atMs) : [], [shown]);
  // What dragging, trimming and moving the playhead snap to: the beats drawn now and the section edges (0.5.9 E12).
  const snapPoints = songBeatSnapPoints(beats, level);
  const currentItem = (): RundownItem | undefined => useDocumentStore.getState().project?.rundown.find((entry) => entry.id === item?.id);
  const current = (): boolean => currentItem()?.referenceAudio === audio;
  const commit = (next: NonNullable<RundownItem['referenceAudio']>, label: string): void => {
    if (!item || !current()) throw new Error('节目或音频已经变了，请重新操作');
    if (disabled || useRuntimeStore.getState().state !== 'idle') throw new Error('请停止播放后再应用音频修改');
    useDocumentStore.getState().execute(editReferenceAudioCommand(item.id, next, label));
  };
  const run = async (operation: () => void | Promise<void>): Promise<void> => {
    if (processing.current) { notify('请等待音频处理完成', 'info'); return; }
    processing.current = true; setBusy(true);
    try { await operation(); } catch (error) { notify(error instanceof Error ? error.message : String(error), 'error'); }
    finally { processing.current = false; setBusy(false); }
  };
  const render = async (next: AudioTrack[], label: string): Promise<void> => {
    if (!disabled && beforeEdit) await beforeEdit();
    if (disabled || useRuntimeStore.getState().state !== 'idle') throw new Error('请停止播放后编辑音频片段');
    if (!audio || !projectPath) throw new Error('请先保存工程并添加歌曲音频');
    if (!next.length) {
      if (!item || !current()) throw new Error('节目或音频已经变了，请重新操作');
      useDocumentStore.getState().execute(setReferenceAudioCommand(item.id, null));
      return;
    }
    // A song that lasts past its music keeps that silence after an edit (editedSongDurationMs); others end with it.
    const durationMs = editedSongDurationMs(audio, next);
    const rendered = referenceAudioSchema.parse(await linkDesktopViewModel.renderAudioSegments({ projectPath, source: next[0]!.source, segments: next[0]!.segments, tracks: next,
      ...(durationMs === undefined ? {} : { durationMs }) }));
    commit(rendered, label);
  };
  const selectTrack = (trackId: string, id: string | null): void => { setSelectedTrackId(trackId); setSelectedId(id); };
  const changeTrack = (trackId: string, next: AudioSegment[], label: string): Promise<void> => render(tracks.flatMap(track => track.id === trackId ? next.length ? [{ ...track, segments: next }] : [] : [track]), label);
  const update = (track: AudioTrack, id: string, patch: Partial<Pick<AudioSegment, 'startMs' | 'durationMs' | 'sourceOffsetMs'>>): Promise<void> => run(async () => {
    const sourceAudio = { ...track.source, durationMs: audioTracksEndMs([track]), timeline: { source: track.source, segments: track.segments } };
    await changeTrack(track.id, updateAudioSegment(sourceAudio, id, patch), '编辑音频片段');
  });
  const remove = (track: AudioTrack, id: string | null): Promise<void> => run(async () => { await changeTrack(track.id, track.segments.filter(segment => segment.id !== id), '删除音频片段'); setSelectedId(null); });
  return {
    audio, title: activeTrack?.title ?? '歌曲音频', tracks, activeTrackId: activeTrack?.id, segments, selected, selectedId, setSelectedId, level, setLevel, points, snapPoints,
    /** The song has beats saved. */
    hasBeats: beats?.state === 'ready', simpleBeats: beats?.state === 'ready' && beats.method === 'ibt', beatsStale: beats?.state === 'stale' ? beats.reason : null, busy, disabled: disabled || busy,
    trackEditor: (track: AudioTrack) => ({ audio: track.source, title: track.title, segments: track.segments, selectedId: activeTrack?.id === track.id ? selectedId : null, busy, disabled: disabled || busy, points: track.id === tracks[0]?.id ? points : [], select: (id: string | null) => selectTrack(track.id, id), update: (id: string, patch: Partial<Pick<AudioSegment, 'startMs' | 'durationMs' | 'sourceOffsetMs'>>) => update(track, id, patch), remove: () => remove(track, selectedId), split: (timeMs:number) => run(async()=>{ const next=splitAudioSegments(track.segments,[timeMs]);if(next.length===track.segments.length)throw new Error('播放头需要位于音频片段内部');await changeTrack(track.id,next,'分割音频片段'); }) }),
    removeTrack: (id: string) => run(() => render(tracks.filter(track => track.id !== id), '删除音轨')),
    select: (id: string | null) => { setSelectedId(id); if (id) setSelectedTrackId(tracks.find(track => track.segments.some(segment => segment.id === id))?.id ?? null); },
    splitAtBeats: () => run(async () => {
      if (!audio || !activeTrack || !points.length) throw new Error('这首歌还没有节拍，先在「音乐识别」里识别一次');
      const next = splitAudioSegments(segments, points);
      if (next.length === segments.length) throw new Error('当前音轨内没有可切分的节拍点');
      await changeTrack(activeTrack.id, next, '按节拍切分音频');
    }),
    split: (timeMs: number) => run(async () => {
      if (!audio || !activeTrack) return;
      const next = splitAudioSegments(segments, [timeMs]);
      if (next.length === segments.length) throw new Error('播放头需要位于音频片段内部');
      await changeTrack(activeTrack.id, next, '分割音频片段');
    }),
    update: (id: string, patch: Partial<Pick<AudioSegment, 'startMs' | 'durationMs' | 'sourceOffsetMs'>>) => activeTrack ? update(activeTrack, id, patch) : Promise.resolve(),
    remove: () => activeTrack && selected ? remove(activeTrack, selected.id) : Promise.resolve()
  };
}

export type AudioEditor = ReturnType<typeof useAudioEditor>;
