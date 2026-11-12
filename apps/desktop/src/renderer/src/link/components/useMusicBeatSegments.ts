import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { acceptMusicStructure, addSongBeats, clearedSongMusic, editMusicStructure, ibtSongMusic, setSongMusicCommand, songBeats, songMusicAudio, songMusicSource, songTimeToMusicSource, type LinkDesktopApi, type PlacedSongBeats, type SongBeatSegment } from '@tb/core/link';
import { audioBeatAnalysisSchema, type ReferenceAudio, type ReferenceAudioSource, type RundownItem, type SongMusic } from '@tb/schema';
import type { useAutomaticMusicAnalysis } from '../runtime/use-automatic-music-analysis';
import { useRuntimeStore } from '../stores/runtime-store';
import { useDocumentStore } from '../stores/document-store';
import { linkDesktopViewModel } from '../view-models/link-desktop-view-model';

// One record per song and audio for the whole app, whichever page shows it (the editor or the lighting workspace):
// mounting a page again, or opening the other one, must not start the recognition again, undo a cancellation or
// apply a result twice.
const attempted = new Set<string>();
const delivered = new Set<string>();
const requested = new Set<string>();
const remember = (set: Set<string>, key: string): void => { set.add(key); if (set.size > 2000) set.delete(set.values().next().value!); };

/** The key of one song's recognition: the same on both pages, so the song has one recognition task (0.5.9 E11). */
export function musicRecognitionKey(projectPath: string | null, itemId: string | undefined, source: Pick<ReferenceAudioSource, 'sha256' | 'durationMs'> | undefined): string {
  return `${projectPath}:${itemId}:${source?.sha256}:${source?.durationMs}`;
}

/**
 * Whether a page starts the song's recognition by itself: once per song and audio in this run of the app, only when the
 * song has no beats, this computer can recognise music, nothing is playing and no task for it is known. A start
 * counts for both pages, so the other page does not start it again.
 */
export function claimAutomaticRecognition(key: string, ready: { song: boolean; projectPath: string | null; blocked: boolean; available: boolean; beats: boolean; job: boolean }): boolean {
  if (!ready.song || !ready.projectPath || ready.blocked || !ready.available || ready.beats || ready.job || attempted.has(key)) return false;
  remember(attempted, key);
  return true;
}

/** Whether a finished task's result is written to the song now: once per task, whichever page sees it first. */
export function claimRecognitionResult(key: string, taskId: string, hasBeats: boolean): { background: boolean } | null {
  const id = `${key}:${taskId}`;
  if (delivered.has(id) || hasBeats && !requested.has(key)) return null;
  const background = !requested.has(key);
  remember(delivered, id); requested.delete(key);
  return { background };
}

/**
 * Whether the panel offers the simple beat detection (IBT, 0.5.9 design 6.3): only on a computer that cannot recognise
 * music, for a song with audio and no beats now. Beats recognised on another computer are used as they are. `waiting`
 * is shown but cannot be pressed: something is playing or the runtime is busy.
 */
export type SimpleDetectionOffer = 'none' | 'ready' | 'waiting';
export function simpleDetectionOffer(input: { statusKnown: boolean; available: boolean; hasBeats: boolean; audio: boolean; blocked: boolean }): SimpleDetectionOffer {
  if (!input.statusKnown || input.available || input.hasBeats || !input.audio) return 'none';
  return input.blocked ? 'waiting' : 'ready';
}

const sameAudio = (a: ReferenceAudioSource, b: ReferenceAudioSource | undefined): boolean => Boolean(b) && a.sha256 === b!.sha256 && a.relativePath === b!.relativePath && a.durationMs === b!.durationMs;

/**
 * What to do with a finished simple detection now. It is written like every other write of this hook: not while
 * something is playing or the runtime is busy (kept until then), not over beats the song has got meanwhile, and not
 * when the song's audio changed while it ran.
 */
export type SimpleDetectionWrite = 'wait' | 'skip' | 'stale' | 'write';
export function simpleDetectionWrite(input: { blocked: boolean; hasBeats: boolean; sameAudio: boolean }): SimpleDetectionWrite {
  if (input.blocked) return 'wait';
  if (input.hasBeats) return 'skip';
  return input.sameAudio ? 'write' : 'stale';
}

// One simple detection per song for the whole app, like the recognition above: a run started on one page is the same
// run on the other, and its result, kept while something plays, is written once by whichever page is open then.
type SimpleResult = { itemId: string; source: ReferenceAudioSource; music: SongMusic };
const simpleRunning = new Set<string>();
const simplePending = new Map<string, SimpleResult>();
const simpleListeners = new Set<() => void>();
let simpleVersion = 0;
const simpleChanged = (): void => { simpleVersion += 1; for (const listener of simpleListeners) listener(); };
const subscribeSimple = (listener: () => void): (() => void) => { simpleListeners.add(listener); return () => { simpleListeners.delete(listener); }; };
const readSimpleVersion = (): number => simpleVersion;
/** The key of one song's simple detection: per project and song, so a result survives an audio change and is refused. */
export const simpleDetectionKey = (projectPath: string | null, itemId: string | undefined): string => `${projectPath}:${itemId}`;
export const simpleDetectionState = (key: string): { running: boolean; pending: boolean } => ({ running: simpleRunning.has(key), pending: simplePending.has(key) });

const findSong = (itemId: string): RundownItem => {
  const song = useDocumentStore.getState().project?.rundown.find(entry => entry.id === itemId);
  if (!song) throw new Error('节目已经不在了，这次没有写入节拍');
  return song;
};

/**
 * Runs the simple beat detection on the song's music source and keeps the result for `writeSimpleBeats`. Nothing is
 * written here. `running`: a detection for this song is already on its way, none is started; `empty`: no clear beats.
 */
export async function detectSimpleBeats(key: string, itemId: string, projectPath: string, analyze: LinkDesktopApi['analyzeAudioBeats'] = payload => linkDesktopViewModel.analyzeAudioBeats(payload)): Promise<'running' | 'empty' | 'found'> {
  if (simpleRunning.has(key) || simplePending.has(key)) return 'running';
  const source = songMusicSource(findSong(itemId));
  if (!source) throw new Error('先添加音乐');
  simpleRunning.add(key); simpleChanged();
  try {
    const result = audioBeatAnalysisSchema.parse(await analyze({ projectPath, source }));
    if (!result.dense.length) return 'empty';
    simplePending.set(key, { itemId, source, music: ibtSongMusic(source, result) });
    return 'found';
  } finally { simpleRunning.delete(key); simpleChanged(); }
}

/** Writes the kept result as one `setSongMusicCommand` (one undo step) when `simpleDetectionWrite` says so. */
export function writeSimpleBeats(key: string, blocked: boolean): SimpleDetectionWrite | 'none' {
  const kept = simplePending.get(key);
  if (!kept) return 'none';
  const song = useDocumentStore.getState().project?.rundown.find(entry => entry.id === kept.itemId);
  const decision = simpleDetectionWrite({ blocked, hasBeats: song ? songBeats(song).state === 'ready' : false, sameAudio: song ? sameAudio(kept.source, songMusicSource(song)) : false });
  if (decision === 'wait') return decision;
  simplePending.delete(key); simpleChanged();
  if (decision === 'stale') throw new Error(song ? '检测时音频被改了，请重新检测' : '节目已经不在了，这次没有写入节拍');
  if (decision === 'write') useDocumentStore.getState().execute(setSongMusicCommand(kept.itemId, kept.source, kept.music, { label: '简易检测音乐节拍' }));
  return decision;
}
// Beats tapped by hand (Ctrl+J, 剪映's 手动踩点) while something plays or the runtime is busy: kept per song, like the
// simple detection's result (and on the same signal), and written as one step once it stops (rule row 「一首歌的节拍」).
type Taps = { itemId: string; audio: ReferenceAudio; songMs: number[] };
const tapsPending = new Map<string, Taps>();

/**
 * What a tap or a write of kept taps did: `waiting` kept for later (`first`: the first one kept); `written`: how many
 * beats are new and how many fell where the song plays no music, `kept` when they had been kept until now.
 */
export type BeatTapResult = { kind: 'waiting'; first: boolean } | { kind: 'written'; added: number; outside: number; kept: boolean } | { kind: 'none' };

/** Writes the song's beats `songMs` (the song's time) as one `setSongMusicCommand`, unless none of them is new. */
function writeTaps(itemId: string, songMs: readonly number[], kept: boolean): BeatTapResult {
  const added = addSongBeats(findSong(itemId), songMs);
  if (added.added > 0) useDocumentStore.getState().execute(setSongMusicCommand(itemId, added.audio, added.music, { label: '手动踩点' }));
  return { kind: 'written', added: added.added, outside: added.outside, kept };
}

/** A beat tapped at `songMs` on the song `itemId`: written now, or kept while `blocked` (`key`: `simpleDetectionKey`). */
export function tapBeat(key: string, itemId: string, songMs: number, blocked: boolean): BeatTapResult {
  if (!blocked) return writeTaps(itemId, [songMs], false);
  const audio = findSong(itemId).referenceAudio;
  if (!audio) throw new Error('这首歌还没有音乐，添加音乐后再踩点');
  const kept = tapsPending.get(key);
  if (kept && kept.audio === audio) { kept.songMs.push(songMs); return { kind: 'waiting', first: false }; }
  tapsPending.set(key, { itemId, audio, songMs: [songMs] }); simpleChanged();
  return { kind: 'waiting', first: true };
}

/** Writes the taps kept for `key` once nothing blocks them; dropped with a reason when the song's audio changed meanwhile. */
export function writeBeatTaps(key: string, blocked: boolean): BeatTapResult {
  const kept = tapsPending.get(key);
  if (!kept || blocked) return kept ? { kind: 'waiting', first: false } : { kind: 'none' };
  tapsPending.delete(key); simpleChanged();
  const song = useDocumentStore.getState().project?.rundown.find(entry => entry.id === kept.itemId);
  if (!song) throw new Error('节目已经不在了，这次没有写入踩的拍点');
  if (song.referenceAudio !== kept.audio) throw new Error('踩点时音乐被改了，这次没有写入踩的拍点，请重新踩');
  return writeTaps(kept.itemId, kept.songMs, true);
}
export const beatTapsWaiting = (key: string): number => tapsPending.get(key)?.songMs.length ?? 0;

/** What to tell the operator after a tap or a write, or null. */
export function beatTapText(result: BeatTapResult): string | null {
  if (result.kind === 'waiting') return result.first ? '踩的拍点先记下了，停止播放后一起写进这首歌。' : null;
  if (result.kind === 'none') return null;
  const parts = [
    result.kept && result.added ? `写进了 ${result.added} 个踩的拍点。` : '',
    result.outside ? `有 ${result.outside} 个踩在没有音乐的地方，没有加。` : '',
    !result.added && !result.outside ? (result.kept ? '踩的拍点这首歌里都已经有了，没有新加。' : '这里已经有拍点了。') : ''
  ].join('');
  return parts || null;
}

/** Whether the song's beats now are those of the simple detection, shown as 简易检测的节拍 on both pages. */
export const isSimpleBeats = (beats: Pick<MusicBeatSegments, 'data'>): boolean => beats.data?.state === 'ready' && beats.data.method === 'ibt';
const NO_BEATS_FOUND ='没有检测到明显节奏点，请按听感手动放置灯光 Cue';

/**
 * The song's beats and sections for the editor and the lighting workspace, from `songBeats(item)`, on the song's own
 * time. Recognition runs on `songMusicSource(item)`, the music track's source file, and every change is a
 * `setSongMusicCommand` on the song, never on its lighting. `scope` is the song's `musicRecognitionKey`.
 */
export function useMusicBeatSegments(item: RundownItem | undefined, analysis: ReturnType<typeof useAutomaticMusicAnalysis>, scope: string, projectPath: string | null, playing: boolean, notify?: (message: string, tone: 'info' | 'error') => void) {
  const runtimeBusy = useRuntimeStore(state => state.state !== 'idle');
  const blocked = playing || runtimeBusy;
  const [error, setError] = useState('');
  const [selectedId, select] = useState<string | null>(null);
  const source = item ? songMusicSource(item) : undefined;
  const placed = item ? songBeats(item) : undefined;
  const data: PlacedSongBeats | undefined = placed && (placed.state === 'ready' || placed.state === 'cleared') ? placed : undefined;
  const stale = placed?.state === 'stale' ? placed.reason : null;
  const points = data?.segments ?? noSegments;
  const snapPoints = data?.state === 'ready' ? data.editPointsMs : noPoints;
  const busy = analysis.submitting || Boolean(analysis.job && ['queued', 'checking', 'running', 'pausing', 'cancelling'].includes(analysis.job.state));
  const itemId = item?.id;
  /** The song as it is now: an edit always starts from the store, not from the last render. */
  const current = useCallback((): RundownItem => {
    const song = useDocumentStore.getState().project?.rundown.find(entry => entry.id === itemId);
    if (!song) throw new Error('节目已经不在了，这次没有修改节拍');
    return song;
  }, [itemId]);
  const commit = useCallback((music: SongMusic, label: string, background = false): void => {
    // The beats belong to the audio they came from: beats from before 0.5.9 keep the song audio they were analysed from.
    const song = current(), audio = songMusicAudio(song, music);
    if (!audio) throw new Error('这首歌的音乐换了，这次没有修改节拍。请重新识别');
    useDocumentStore.getState().execute(setSongMusicCommand(song.id, audio, music, { label, background }));
  }, [current]);
  const run = useCallback((action: () => void): void => { if (blocked) return; try { action(); setError(''); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); } }, [blocked]);
  useEffect(() => {
    if (claimAutomaticRecognition(scope, { song: Boolean(item && source), projectPath, blocked, available: analysis.status?.available === true, beats: Boolean(data), job: Boolean(analysis.job) })) void analysis.start();
  }, [item, source, projectPath, blocked, analysis, data, scope]);
  useEffect(() => {
    const job = analysis.job;
    if (!item || !source || blocked || job?.state !== 'completed' || !job.candidates) return;
    const claim = claimRecognitionResult(scope, job.taskId, Boolean(data));
    if (claim) run(() => commit(acceptMusicStructure(current(), source, job.candidates!, job.taskId), '自动识别音乐节拍与段落', claim.background));
  }, [analysis.job, item, source, scope, blocked, data, run, commit, current]);
  const [notice, setNotice] = useState('');
  useSyncExternalStore(subscribeSimple, readSimpleVersion, readSimpleVersion);
  const simpleKey = simpleDetectionKey(projectPath, itemId), { running: detecting, pending: simplePendingWrite } = simpleDetectionState(simpleKey);
  const offer = simpleDetectionOffer({ statusKnown: Boolean(analysis.status || analysis.error), available: analysis.status?.available === true, hasBeats: data?.state === 'ready', audio: Boolean(source && projectPath), blocked });
  useEffect(() => {
    if (!simplePendingWrite || blocked) return;
    try { if (writeSimpleBeats(simpleKey, blocked) === 'write') { setError(''); remember(attempted, scope); } } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  }, [simplePendingWrite, blocked, simpleKey, scope]);
  const taps = beatTapsWaiting(simpleKey);
  useEffect(() => {
    if (!taps || blocked) return;
    try { const text = beatTapText(writeBeatTaps(simpleKey, blocked)); if (text) notify?.(text, 'info'); } catch (cause) { notify?.(cause instanceof Error ? cause.message : String(cause), 'error'); }
  }, [taps, blocked, simpleKey, notify]);
  /** Ctrl+J: a beat at `songMs`, written now or kept until nothing plays. */
  const tap = (songMs: number): void => {
    if (!itemId) return;
    try { const text = beatTapText(tapBeat(simpleKey, itemId, songMs, blocked)); if (text) notify?.(text, 'info'); } catch (cause) { notify?.(cause instanceof Error ? cause.message : String(cause), 'error'); }
  };
  const simpleDetect = (): void => {
    if (offer !== 'ready' || detecting || simplePendingWrite || !itemId || !projectPath) return;
    setError(''); setNotice('');
    void detectSimpleBeats(simpleKey, itemId, projectPath)
      .then(found => setNotice(found === 'empty' ? NO_BEATS_FOUND : ''))
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)));
  };
  const start = (): void => {
    if (blocked || busy) return;
    remember(requested, scope); remember(attempted, scope); setError('');
    void analysis.start();
  };
  const clear = (): void => run(() => {
    if (!source) return;
    const song = current();
    commit(data && song.music ? editMusicStructure(song, { kind: 'clear' }) : clearedSongMusic(source, 'dismissed'), '清除音乐识别标记');
    remember(attempted, scope); requested.delete(scope); analysis.clear(); select(null);
  });
  const cancel = (): void => {
    remember(attempted, scope); requested.delete(scope);
    if (analysis.job) remember(delivered, `${scope}:${analysis.job.taskId}`);
    if (!blocked && !data && source) run(() => commit(clearedSongMusic(source, 'cancelled'), '取消音乐分析'));
    void analysis.control('cancel');
  };
  const sourceSegment = (id: string): SongBeatSegment => {
    const segment = points.find(entry => entry.id === id);
    if (!segment) throw new Error('段落已不存在');
    return segment;
  };
  const remove = (id: string): void => run(() => { commit(editMusicStructure(current(), { kind: 'remove-segment', id: sourceSegment(id).sourceId }), '删除音乐段落'); select(null); });
  const removeBeat = (id: string): void => run(() => {
    const beat = data?.beats.find(entry => entry.id === id);
    if (!beat) throw new Error('拍点已不存在');
    commit(editMusicStructure(current(), { kind: 'remove-beat', id: beat.sourceId }), '删除音乐拍点');
  });
  /** `segment` in song time, as the panel shows it; saved in the time of the audio the beats belong to. */
  const update = (segment: SongBeatSegment): void => run(() => {
    if (!data) throw new Error('还没有音乐识别结果');
    const startMs = songTimeToMusicSource(data, segment.startMs), endMs = songTimeToMusicSource(data, segment.endMs);
    if (startMs === undefined || endMs === undefined) throw new Error('这个位置的音乐被剪掉了，段落的开始和结束要放在有音乐的地方');
    const { sourceId, ...fields } = segment;
    commit(editMusicStructure(current(), { kind: 'segment', segment: { ...fields, id: sourceId, startMs, endMs } }), '修改音乐段落');
  });
  return { data, stale, snapPoints, points, error, blocked, busy, selected: points.find(segment => segment.id === selectedId), select, remove, removeBeat, update, start, cancel, clear, tap,
    simple: { offer, detecting, waitingToWrite: simplePendingWrite, notice: simplePendingWrite && blocked ? '检测好了，停止播放后会写入节拍。' : notice, run: simpleDetect } };
}
const noSegments: readonly SongBeatSegment[] = [];
const noPoints: readonly number[] = [];
export type MusicBeatSegments = ReturnType<typeof useMusicBeatSegments>;
