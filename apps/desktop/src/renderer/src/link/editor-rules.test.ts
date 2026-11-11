import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { acceptMusicStructure, ma2PendingChanges, setSongMusicCommand, songBeats, songBeatsAtDensity, songMusicSource } from '@tb/core/link';
import { createEmptyLinkProject, createLightingDocument, parseLinkProject, type AutomaticMusicCandidates } from '@tb/schema';
import { useAudioEditor, type AudioEditor } from './components/useAudioEditor';
import { claimAutomaticRecognition, claimRecognitionResult, detectSimpleBeats, isSimpleBeats, musicRecognitionKey, simpleDetectionKey, simpleDetectionOffer, simpleDetectionState, simpleDetectionWrite, useMusicBeatSegments, writeSimpleBeats } from './components/useMusicBeatSegments';
import { useAutomaticMusicAnalysis } from './runtime/use-automatic-music-analysis';
import { useDocumentStore } from './stores/document-store';
import { useRuntimeStore } from './stores/runtime-store';

// The renderer half of the 0.5.9 editor rules (05-editor.md 6.7); the domain half is packages/core/src/editor-rules.test.ts.

vi.mock('./view-models/link-desktop-view-model', () => ({ linkDesktopViewModel: {} }));
afterEach(() => { useRuntimeStore.getState().reset(); useDocumentStore.getState().setProject(null, null); });

const LINK = fileURLToPath(new URL('.', import.meta.url));
const SOURCE = { assetId: 'audio', relativePath: 'assets/reference-audio/song.wav', sha256: 'a'.repeat(64), durationMs: 8000 };
const candidates: AutomaticMusicCandidates = { sourceSha256: SOURCE.sha256, durationMs: SOURCE.durationMs, bpm: 120, items: [
  ...Array.from({ length: 16 }, (_, i) => ({ id: `beat:${i}`, kind: 'beat' as const, name: '拍点', startMs: i * 500, endMs: null })),
  ...Array.from({ length: 4 }, (_, i) => ({ id: `down:${i}`, kind: 'downbeat' as const, name: '强拍', startMs: i * 2000, endMs: null }))
] };

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
  });
}
const song = () => useDocumentStore.getState().project!.rundown[0]!;
/** Opens a project whose song has recognised beats, as a file on disk would open. */
function openWithBeats(): void {
  const project = parseLinkProject({ ...createEmptyLinkProject('规则'), schemaVersion: 2, obsOutputMode: 'scenes', rundown: [{ id: 'song', title: '歌', referenceAudio: SOURCE, lighting: createLightingDocument() }] });
  useDocumentStore.getState().setProject(project, 'C:/shows/规则.tblink');
  const item = song(), source = songMusicSource(item)!;
  useDocumentStore.getState().execute(setSongMusicCommand('song', source, acceptMusicStructure(item, source, candidates, 'task'), { label: '识别节拍' }));
}
/** What the editor and the lighting workspace each get for the song, rendered once. */
function bothViews(): { editor: AudioEditor; lighting: ReturnType<typeof useMusicBeatSegments> } {
  const seen: Array<{ editor: AudioEditor; lighting: ReturnType<typeof useMusicBeatSegments> }> = [];
  function Harness() {
    const item = song();
    const analysis = useAutomaticMusicAnalysis(null, songMusicSource(item));
    seen.push({ editor: useAudioEditor(item, 'C:/shows/规则.tblink', false, vi.fn()), lighting: useMusicBeatSegments(item, analysis, 'rules', null, false) });
    return null;
  }
  renderToString(createElement(Harness));
  return seen[0]!;
}

describe('规则 1：编辑器和灯光工作台拿到的节拍是同一份', () => {
  it('两边都从 songBeats(item) 拿：灯光工作台拿到的就是那个结果，编辑器显示的是它的一个密度', () => {
    openWithBeats();
    const beats = songBeats(song());
    if (beats.state !== 'ready') throw new Error('节拍没有识别出来');
    const { editor, lighting } = bothViews();
    expect(lighting.data).toBe(beats);
    expect(editor.points).toEqual(songBeatsAtDensity(beats.beats, 'standard').map(beat => beat.atMs));
    expect(lighting.snapPoints).toBe(beats.editPointsMs);
  });

  it('界面代码不直接读旧的两份节拍，节拍的两个入口都经 songBeats', () => {
    const offenders = sourceFiles(LINK).flatMap(file => readFileSync(file, 'utf8').split(/\r?\n/).flatMap((line, index) =>
      /\.musicAnalysis\b|referenceAudio\??\.beats\b|\.beats\??\.(pointsMs|levels|level)\b/.test(line) ? [`${relative(LINK, file).replaceAll('\\', '/')}:${index + 1}`] : []));
    expect(offenders).toEqual([]);
    for (const file of ['components/useAudioEditor.ts', 'components/useMusicBeatSegments.ts']) expect(readFileSync(join(LINK, file), 'utf8')).toMatch(/\bsongBeats\b/);
  });
});

describe('规则 2：剪过的歌，两边看到的拍点都在歌曲时间上', () => {
  it('歌曲音频剪掉一段后，编辑器和灯光工作台都不用重新识别，拍点跟着片段走', () => {
    openWithBeats();
    const rendered = { assetId: 'render', relativePath: 'assets/reference-audio/render.wav', sha256: 'b'.repeat(64), durationMs: 4000,
      timeline: { source: SOURCE, segments: [{ id: 'a', startMs: 0, sourceOffsetMs: 0, durationMs: 2000 }, { id: 'b', startMs: 2000, sourceOffsetMs: 6000, durationMs: 2000 }] } };
    useDocumentStore.setState(state => ({ project: { ...state.project!, rundown: [{ ...song(), referenceAudio: rendered }] } }));
    const { editor, lighting } = bothViews();
    expect(lighting.data?.beats.map(beat => beat.atMs)).toEqual([0, 500, 1000, 1500, 2000, 2500, 3000, 3500]);
    expect(editor.points).toEqual([0, 1000, 2000, 3000]);
    expect(lighting.stale).toBeNull();
  });
});

describe('规则 3：旧工程打开后只剩一份节拍', () => {
  it('打开时两种旧数据都搬到歌上，旧字段不留，工程标成有改动等保存', () => {
    const older = parseLinkProject({ ...createEmptyLinkProject('旧工程'), schemaVersion: 2, obsOutputMode: 'scenes', rundown: [
      { id: 'song', title: '歌', referenceAudio: { ...SOURCE, beats: { sourceSha256: SOURCE.sha256, level: 'standard', pointsMs: [0, 1000, 2000] } }, lighting: { ...createLightingDocument(), version: 2, musicAnalysis: acceptMusicStructure({}, SOURCE, candidates, 'old').structure } }
    ] });
    useDocumentStore.getState().setProject(older, 'C:/shows/旧工程.tblink');
    expect(song().referenceAudio?.beats).toBeUndefined();
    expect(song().lighting?.musicAnalysis).toBeUndefined();
    expect(song().music?.method).toBe('automatic');
    expect(useDocumentStore.getState().songMusicOpening).toMatchObject({ moved: 1, dropped: [{ itemId: 'song' }] });
    expect(useDocumentStore.getState().dirty).toBe(true);
  });
});

describe('规则 4：重新识别节拍不产生 MA2 待同步改动', () => {
  it('经文档历史重新识别，灯光文档还是原来那个对象，撤销重做也一样', () => {
    openWithBeats();
    const lighting = song().lighting, pending = ma2PendingChanges(useDocumentStore.getState().project);
    const source = songMusicSource(song())!;
    useDocumentStore.getState().execute(setSongMusicCommand('song', source, acceptMusicStructure(song(), source, candidates, 'again'), { label: '重新识别' }));
    expect(song().lighting).toBe(lighting);
    expect(ma2PendingChanges(useDocumentStore.getState().project)).toEqual(pending);
    useDocumentStore.getState().undo();
    expect(song().lighting).toBe(lighting);
  });
});

describe('规则 5：界面不解码整首音频，波形只有主进程那一套（E10）', () => {
  it('界面代码里没有 OfflineAudioContext、decodeAudioData 和 wavesurfer', () => {
    const offenders = sourceFiles(LINK).flatMap(file => readFileSync(file, 'utf8').split(/\r?\n/).flatMap((line, index) =>
      /\bOfflineAudioContext\b|\bdecodeAudioData\b|wavesurfer/i.test(line) ? [`${relative(LINK, file).replaceAll('\\', '/')}:${index + 1}`] : []));
    expect(offenders).toEqual([]);
    const desktop = JSON.parse(readFileSync(join(LINK, '../../../../package.json'), 'utf8')) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
    expect(Object.keys({ ...desktop.dependencies, ...desktop.devDependencies }).filter(name => /wavesurfer/i.test(name))).toEqual([]);
  });

  it('首页、编辑器和灯光工作台的波形都经同一个 useSongWaveform 拿，都用 WaveformCanvas 画', () => {
    for (const file of ['components/PlayerWaveformTimeline.tsx', 'components/ReferenceTimeline.tsx', 'components/AudioTrackLane.tsx']) expect(readFileSync(join(LINK, file), 'utf8')).toMatch(/\buseSongWaveform\(/);
    const hooks = sourceFiles(LINK).filter(file => /export function useSongWaveform\b/.test(readFileSync(file, 'utf8')));
    expect(hooks.map(file => relative(LINK, file).replaceAll('\\', '/'))).toEqual(['components/ReferenceWaveform.tsx']);
    const canvases = sourceFiles(LINK).filter(file => /\bdrawWaveformCanvas\(/.test(readFileSync(file, 'utf8')));
    expect(canvases.map(file => relative(LINK, file).replaceAll('\\', '/')).sort()).toEqual(['components/ReferenceWaveform.tsx', 'view-models/waveform-draw.ts']);
  });
});

describe('规则 6：版本只按用到的内容决定', () => {
  it('第一次存下节拍，工程才升到 3；没有节拍的工程打开后版本不变', () => {
    const plain = parseLinkProject({ ...createEmptyLinkProject('普通'), obsOutputMode: 'scenes', rundown: [{ id: 'song', title: '歌', referenceAudio: SOURCE }] });
    useDocumentStore.getState().setProject(plain, 'C:/shows/普通.tblink');
    expect(useDocumentStore.getState().project?.schemaVersion).toBe(1);
    expect(useDocumentStore.getState().dirty).toBe(false);
    openWithBeats();
    expect(useDocumentStore.getState().project?.schemaVersion).toBe(3);
  });
});

describe('规则 7：编辑器里也能识别音乐，和灯光工作台共用一个识别任务（E11）', () => {
  it('两个页面用同一个时间线和同一把钥匙：识别和节拍都不再只在灯光工作台开', () => {
    const timeline = readFileSync(join(LINK, 'components/ReferenceTimeline.tsx'), 'utf8');
    expect(timeline).toMatch(/useAutomaticMusicAnalysis\(props\.projectPath, musicSource\)/);
    expect(timeline).toMatch(/useMusicBeatSegments\(props\.musicItem, analysis, musicRecognitionKey\(/);
    expect(timeline).not.toMatch(/lightingWorkspace \? props\.(musicItem|projectPath) :/);
    const users = sourceFiles(LINK).filter(file => /(?<!function )\b(useMusicBeatSegments|useAutomaticMusicAnalysis)\(/.test(readFileSync(file, 'utf8')));
    expect(users.map(file => relative(LINK, file).replaceAll('\\', '/'))).toEqual(['components/ReferenceTimeline.tsx']);
  });

  it('同一首歌只开一次识别：一个页面开了，另一个页面不再开；结果只写一次', () => {
    const key = musicRecognitionKey('C:/shows/共用.tblink', 'song', SOURCE);
    const ready = { song: true, projectPath: 'C:/shows/共用.tblink', blocked: false, available: true, beats: false, job: false };
    expect(musicRecognitionKey('C:/shows/共用.tblink', 'song', { ...SOURCE })).toBe(key);
    expect(claimAutomaticRecognition(key, ready)).toBe(true); // the lighting workbench starts it
    expect(claimAutomaticRecognition(key, ready)).toBe(false); // the editor, opened next, does not
    expect(claimRecognitionResult(key, 'task-1', false)).toEqual({ background: true });
    expect(claimRecognitionResult(key, 'task-1', false)).toBeNull(); // the other page sees the same finished task
    // Another audio for the song is another recognition.
    expect(claimAutomaticRecognition(musicRecognitionKey('C:/shows/共用.tblink', 'song', { ...SOURCE, sha256: 'c'.repeat(64) }), ready)).toBe(true);
  });

  it('播放中、在忙或这台电脑不能识别时不自己开，停下来以后才开', () => {
    const key = musicRecognitionKey('C:/shows/等待.tblink', 'song', SOURCE);
    const ready = { song: true, projectPath: 'C:/shows/等待.tblink', blocked: false, available: true, beats: false, job: false };
    expect(claimAutomaticRecognition(key, { ...ready, blocked: true })).toBe(false);
    expect(claimAutomaticRecognition(key, { ...ready, available: false })).toBe(false);
    expect(claimAutomaticRecognition(key, { ...ready, job: true })).toBe(false);
    expect(claimAutomaticRecognition(key, ready)).toBe(true);
  });

  it('灯光工作台识别过的节拍，编辑器直接显示，不再识别', () => {
    openWithBeats();
    const beats = songBeats(song());
    if (beats.state !== 'ready') throw new Error('节拍没有识别出来');
    const { editor, lighting } = bothViews();
    expect(editor.hasBeats).toBe(true);
    expect(editor.points).toEqual(songBeatsAtDensity(beats.beats, 'standard').map(beat => beat.atMs));
    expect(lighting.data).toBe(beats);
    const key = musicRecognitionKey('C:/shows/规则.tblink', 'song', songMusicSource(song()));
    expect(claimAutomaticRecognition(key, { song: true, projectPath: 'C:/shows/规则.tblink', blocked: false, available: true, beats: Boolean(lighting.data), job: false })).toBe(false);
  });

  it('简易检测只在两个页面共用的那一处：界面上只有 useMusicBeatSegments 调它，也没有“检测节拍”“应用标记”', () => {
    const lines = (pattern: RegExp) => sourceFiles(LINK).flatMap(file => readFileSync(file, 'utf8').split(/\r?\n/).flatMap((line, index) =>
      pattern.test(line) ? [`${relative(LINK, file).replaceAll('\\', '/')}:${index + 1}`] : []));
    expect(lines(/\banalyzeAudioBeats\b|\bibtSongMusic\b/).filter(at => !at.startsWith('components/useMusicBeatSegments.ts:'))).toEqual([]);
    expect(lines(/检测节拍|应用标记/)).toEqual([]);
    openWithBeats();
    const { editor } = bothViews();
    expect(Object.keys(editor).filter(key => ['analyze', 'mark', 'clearMarks', 'pendingBeats'].includes(key))).toEqual([]);
  });
});

describe('规则 8：没装识别组件的电脑用简易检测，点了才跑（设计 6.3）', () => {
  const offer = { statusKnown: true, available: false, hasBeats: false, audio: true, blocked: false };
  it('只在这台电脑不能识别、这首歌现在没有节拍时给按钮；播放中给但不能点', () => {
    expect(simpleDetectionOffer({ ...offer, available: true })).toBe('none'); // 装了组件
    expect(simpleDetectionOffer(offer)).toBe('ready'); // 没装且没节拍
    expect(simpleDetectionOffer({ ...offer, hasBeats: true })).toBe('none'); // 没装，但别的电脑识别过
    expect(simpleDetectionOffer({ ...offer, blocked: true })).toBe('waiting'); // 播放中
    expect(simpleDetectionOffer({ ...offer, statusKnown: false })).toBe('none');
    expect(simpleDetectionOffer({ ...offer, audio: false })).toBe('none');
  });

  /** Opens a project whose song has music and no beats. */
  const openPlain = (): void => useDocumentStore.getState().setProject(parseLinkProject({ ...createEmptyLinkProject('简易'), schemaVersion: 2, obsOutputMode: 'scenes', rundown: [{ id: 'song', title: '歌', referenceAudio: SOURCE, lighting: createLightingDocument() }] }), 'C:/shows/简易.tblink');
  const result = { dense: [0, 500, 1000, 1500, 2000, 2500, 3000, 3500], standard: [0, 1000, 2000, 3000], sparse: [0, 2000] };

  it('结果写成一条 setSongMusicCommand，method 是 ibt，两个页面读到同一份，撤销一次就没了', async () => {
    openPlain();
    const before = useDocumentStore.getState().past.length;
    const analyze = vi.fn(() => Promise.resolve(result));
    expect(await detectSimpleBeats('one', 'song', 'C:/shows/简易.tblink', analyze)).toBe('found');
    expect(analyze).toHaveBeenCalledWith({ projectPath: 'C:/shows/简易.tblink', source: songMusicSource(song()) });
    expect(writeSimpleBeats('one', false)).toBe('write');
    expect(writeSimpleBeats('one', false)).toBe('none'); // written once
    expect(useDocumentStore.getState().past.length).toBe(before + 1);
    expect(song().music?.method).toBe('ibt');
    const beats = songBeats(song());
    const { editor, lighting } = bothViews();
    expect(lighting.data).toBe(beats);
    expect(isSimpleBeats(lighting)).toBe(true);
    expect(editor.simpleBeats).toBe(true);
    expect(editor.points).toEqual(songBeatsAtDensity(lighting.data!.beats, 'standard').map(beat => beat.atMs));
    useDocumentStore.getState().undo();
    expect(song().music).toBeUndefined();
  });

  it('没检测到节奏点不写；检测时音频换了不写，并说清楚', async () => {
    openPlain();
    const before = useDocumentStore.getState().past.length;
    expect(await detectSimpleBeats('empty', 'song', 'C:/shows/简易.tblink', () => Promise.resolve({ ...result, dense: [], standard: [], sparse: [] }))).toBe('empty');
    expect(writeSimpleBeats('empty', false)).toBe('none');
    const replaced = () => { useDocumentStore.setState(state => ({ project: { ...state.project!, rundown: [{ ...song(), referenceAudio: { ...SOURCE, sha256: 'd'.repeat(64) } }] } })); return Promise.resolve(result); };
    expect(await detectSimpleBeats('changed', 'song', 'C:/shows/简易.tblink', replaced)).toBe('found');
    expect(() => writeSimpleBeats('changed', false)).toThrow('检测时音频被改了，请重新检测');
    expect(useDocumentStore.getState().past.length).toBe(before);
    expect(song().music).toBeUndefined();
  });

  it('什么时候写：播放中或在忙先留着，期间有了节拍就不写，音频换了报错', () => {
    const ready = { blocked: false, hasBeats: false, sameAudio: true };
    expect(simpleDetectionWrite(ready)).toBe('write');
    expect(simpleDetectionWrite({ ...ready, blocked: true })).toBe('wait');
    expect(simpleDetectionWrite({ ...ready, hasBeats: true })).toBe('skip');
    expect(simpleDetectionWrite({ ...ready, sameAudio: false })).toBe('stale');
  });

  it('检测回来时在播放：先留着不写，停下来写一次，只有一条历史；回来前有了节拍就不写', async () => {
    openPlain();
    const before = useDocumentStore.getState().past.length;
    expect(await detectSimpleBeats('playing', 'song', 'C:/shows/简易.tblink', () => Promise.resolve(result))).toBe('found');
    expect(writeSimpleBeats('playing', true)).toBe('wait');
    expect(writeSimpleBeats('playing', true)).toBe('wait');
    expect(simpleDetectionState('playing')).toEqual({ running: false, pending: true });
    expect(song().music).toBeUndefined();
    expect(useDocumentStore.getState().past.length).toBe(before);
    expect(writeSimpleBeats('playing', false)).toBe('write');
    expect(writeSimpleBeats('playing', false)).toBe('none');
    expect(useDocumentStore.getState().past.length).toBe(before + 1);
    expect(song().music?.method).toBe('ibt');

    openWithBeats();
    const recognised = song().music;
    expect(await detectSimpleBeats('late', 'song', 'C:/shows/规则.tblink', () => Promise.resolve(result))).toBe('found');
    expect(writeSimpleBeats('late', false)).toBe('skip');
    expect(song().music).toBe(recognised);
  });

  it('同一首歌同一时间只跑一个：在一个页面点了，另一个页面再点不再跑', async () => {
    openPlain();
    const key = simpleDetectionKey('C:/shows/简易.tblink', 'song');
    let finish: (value: typeof result) => void = () => undefined;
    const analyze = vi.fn(() => new Promise<typeof result>(resolve => { finish = resolve; }));
    const first = detectSimpleBeats(key, 'song', 'C:/shows/简易.tblink', analyze);
    expect(simpleDetectionState(key)).toEqual({ running: true, pending: false });
    expect(await detectSimpleBeats(key, 'song', 'C:/shows/简易.tblink', analyze)).toBe('running');
    finish(result);
    expect(await first).toBe('found');
    expect(await detectSimpleBeats(key, 'song', 'C:/shows/简易.tblink', analyze)).toBe('running'); // kept, not yet written
    expect(analyze).toHaveBeenCalledTimes(1);
    expect(writeSimpleBeats(key, false)).toBe('write');
  });
});
