import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { acceptMusicStructure, ma2PendingChanges, setSongMusicCommand, songBeats, songBeatsAtDensity, songMusicSource } from '@tb/core/link';
import { createEmptyLinkProject, createLightingDocument, parseLinkProject, type AutomaticMusicCandidates } from '@tb/schema';
import { useAudioEditor, type AudioEditor } from './components/useAudioEditor';
import { useMusicBeatSegments } from './components/useMusicBeatSegments';
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
