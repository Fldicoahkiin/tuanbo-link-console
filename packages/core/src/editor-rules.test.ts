import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createEmptyLinkProject, createLightingDocument, latestSchemaVersion, legacyReadableSchemaVersion, parseLinkProject, requiredSchemaVersion, serializeLinkProject, type AutomaticMusicCandidates, type LightingDocument, type LightingTrack, type LinkProject, type ReferenceAudio, type RundownItem } from '@tb/schema';
import { describe, expect, it } from 'vitest';
import { normalizeContentTimeline } from './content-timeline';
import { setLightingCommand } from './lighting-edit';
import { setLightingLibraryViewCommand } from './lighting-library';
import { withSchemaVersion } from './project-schema-version';
import { acceptMusicStructure } from './music-structure';
import { setSongMusicCommand } from './music-analysis-command';
import { songBeats, songBeatsAtDensity, songMusicSource } from './song-beats';
import { migrateSongMusic } from './song-music-migration';
import { ma2PendingChanges } from './ma2-pending-changes';

// Editor rules from the 0.5.9 editor design (05-editor.md 6.7). Rule 5 (the renderer never decodes a whole song)
// arrives with the single waveform step (E10); the renderer half of rule 1 is in apps/desktop/src/renderer/src/link/editor-rules.test.ts.

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const view = { section: 'front', tone: 'bright', people: 3, zone: 'front', view: 'music', effectCategory: 'effect:music:0', scope: 'category', query: '' } as const;

function song(project: LinkProject, withLighting: boolean): LinkProject {
  return parseLinkProject({ ...project, rundown: [{ id: 'song', title: '歌曲', enabled: true, notes: '', cues: [], visualLayers: [], referenceMediaClips: [], ...(withLighting ? { lighting: createLightingDocument() } : {}) }] });
}
function versioned(schemaVersion: 1 | 2 | 3, withLighting: boolean): LinkProject {
  return song({ ...createEmptyLinkProject('版本'), schemaVersion }, withLighting);
}
/** What a save does to a project: the store normalizes it, the main process serializes it, the next open parses it. */
function saveAndReopen(project: LinkProject): LinkProject {
  return parseLinkProject(JSON.parse(serializeLinkProject(normalizeContentTimeline(project))));
}
const SOURCE = { assetId: 'source', relativePath: 'assets/reference-audio/song.wav', sha256: 'a'.repeat(64), durationMs: 8000 };
/** A beat every 500 ms of the source file, every fourth one strong. */
function candidates(source: Pick<ReferenceAudio, 'sha256' | 'durationMs'> = SOURCE): AutomaticMusicCandidates {
  return { sourceSha256: source.sha256, durationMs: source.durationMs, bpm: 120, items: [
    ...Array.from({ length: source.durationMs / 500 }, (_, i) => ({ id: `beat:${i}`, kind: 'beat' as const, name: '拍点', startMs: i * 500, endMs: null })),
    ...Array.from({ length: source.durationMs / 2000 }, (_, i) => ({ id: `down:${i}`, kind: 'downbeat' as const, name: '强拍', startMs: i * 2000, endMs: null }))
  ] };
}
/** The project's song with the source file as its audio and beats recognised from it. */
function withBeats(project: LinkProject, audio: ReferenceAudio = SOURCE): LinkProject {
  const withAudio = parseLinkProject({ ...project, rundown: project.rundown.map(item => ({ ...item, referenceAudio: audio })) });
  const item = withAudio.rundown[0]!, source = songMusicSource(item)!;
  return setSongMusicCommand(item.id, source, acceptMusicStructure(item, source, candidates(source), 'task'), { label: '识别节拍' }).execute(withAudio);
}
const atMs = (item: RundownItem): number[] => { const beats = songBeats(item); return beats.state === 'ready' ? beats.beats.map(beat => beat.atMs) : []; };
/** The song audio after an edit: `pieces` of the source file placed on the song, rendered to a new file. */
function edited(pieces: Array<{ startMs: number; sourceOffsetMs: number; durationMs: number }>): ReferenceAudio {
  const durationMs = Math.max(...pieces.map(piece => piece.startMs + piece.durationMs));
  return { assetId: 'render', relativePath: 'assets/reference-audio/render.wav', sha256: 'b'.repeat(64), durationMs, timeline: { source: SOURCE, segments: pieces.map((piece, index) => ({ id: `piece-${index}`, ...piece })) } };
}

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    if (entry.name === 'node_modules') return [];
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx|mts)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

describe('规则 6：工程格式版本只按用到的内容决定，只升不降', () => {
  it('没有灯光和控台数据要 1；只有灯光或控台数据要 2', () => {
    expect(requiredSchemaVersion(versioned(1, false))).toBe(1);
    expect(requiredSchemaVersion(versioned(2, true))).toBe(2);
    expect(requiredSchemaVersion(versioned(2, false))).toBe(1);
  });

  it('只升不降：灯光命令把 1 升到 2，不会把 3 写回 2，也不会把 2 降成 1', () => {
    expect(setLightingCommand('song', createLightingDocument()).execute(versioned(1, false)).schemaVersion).toBe(2);
    expect(withSchemaVersion(versioned(3, false)).schemaVersion).toBe(3);
    expect(withSchemaVersion(versioned(3, true)).schemaVersion).toBe(3);
    expect(setLightingLibraryViewCommand(view).execute(versioned(1, false)).schemaVersion).toBe(2);
    const v2 = versioned(2, false);
    expect(withSchemaVersion(v2)).toBe(v2);
    const v1 = versioned(1, false);
    expect(withSchemaVersion(v1)).toBe(v1);
  });

  it('保存出来的版本永远不低于需要的版本，低了就拒绝保存', () => {
    for (const project of [versioned(1, false), versioned(2, true), withBeats(versioned(2, true))]) {
      const saved = saveAndReopen(project);
      expect(saved.schemaVersion).toBeGreaterThanOrEqual(requiredSchemaVersion(saved));
    }
    expect(() => serializeLinkProject({ ...versioned(2, true), schemaVersion: 1 })).toThrow('防止旧版本丢失数据');
  });

  it('比这一版新的工程打不开也存不了：不认识的内容会在保存时丢掉，所以整份拒绝', () => {
    const newer = latestSchemaVersion + 1;
    expect(() => parseLinkProject({ ...createEmptyLinkProject('版本'), schemaVersion: newer })).toThrow();
    // 3 since the shared song beats (E9), the first field that needs it; 0.5.8 and earlier open 1 and 2.
    expect(latestSchemaVersion).toBe(3);
    expect(legacyReadableSchemaVersion).toBe(2);
    for (const project of [versioned(1, false), versioned(2, true), versioned(2, false), withBeats(versioned(2, true))]) expect(requiredSchemaVersion(project)).toBeLessThanOrEqual(latestSchemaVersion);
  });

  it('没用新内容的 v1、v2 工程保存后版本不变，0.5.8 仍能打开', () => {
    expect(saveAndReopen(versioned(1, false)).schemaVersion).toBe(1);
    expect(saveAndReopen(versioned(2, true)).schemaVersion).toBe(2);
    expect(saveAndReopen(versioned(2, false)).schemaVersion).toBe(2);
    expect(requiredSchemaVersion(saveAndReopen(setLightingCommand('song', createLightingDocument()).execute(versioned(1, false))))).toBe(2);
    expect(saveAndReopen(setLightingCommand('song', createLightingDocument()).execute(versioned(1, false))).schemaVersion).toBe(2);
    // Opening an old project with no beats changes nothing, so it is not even marked as changed.
    const old = versioned(2, true);
    expect(migrateSongMusic(old).project).toBe(old);
  });

  it('用了共用节拍要 3；之后的灯光命令不会把 3 写回 2', () => {
    const beat = withBeats(versioned(1, false));
    expect(requiredSchemaVersion(beat)).toBe(3);
    expect(beat.schemaVersion).toBe(3);
    const lit = setLightingCommand('song', createLightingDocument()).execute(beat);
    expect(lit.schemaVersion).toBe(3);
    expect(setLightingLibraryViewCommand(view).execute(lit).schemaVersion).toBe(3);
    expect(saveAndReopen(lit).schemaVersion).toBe(3);
    expect(() => serializeLinkProject({ ...lit, schemaVersion: 2 })).toThrow('必须使用 schema 3');
  });

  it('非测试代码里不手写工程版本号，一律经 withSchemaVersion', () => {
    const roots = ['packages', 'apps'].flatMap(group => readdirSync(join(repoRoot, group), { withFileTypes: true })
      .filter(entry => entry.isDirectory()).map(entry => join(repoRoot, group, entry.name, 'src')));
    const offenders = roots.flatMap(root => {
      let files: string[];
      try { files = sourceFiles(root); } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return [];
        throw error;
      }
      return files.flatMap(file => readFileSync(file, 'utf8').split(/\r?\n/)
        .flatMap((line, index) => /schemaVersion\s*[:=]\s*[23]\b/.test(line) ? [`${relative(repoRoot, file).replaceAll('\\', '/')}:${index + 1}`] : []));
    });
    expect(offenders).toEqual([]);
    expect(sourceFiles(join(repoRoot, 'packages/core/src')).length).toBeGreaterThan(10);
  });
});

describe('规则 1：编辑器和灯光工作台拿到的节拍是同一份', () => {
  it('一首歌的节拍只从 songBeats(item) 来，同一首歌再问一次是同一个结果', () => {
    const item = withBeats(versioned(1, false)).rundown[0]!;
    const first = songBeats(item);
    expect(first.state).toBe('ready');
    expect(songBeats(item)).toBe(first);
    if (first.state !== 'ready') throw new Error('节拍没有识别出来');
    // The editor shows a density of the very same beats; at full density it is the same array.
    expect(songBeatsAtDensity(first.beats, 'dense')).toBe(first.beats);
    expect(songBeatsAtDensity(first.beats, 'sparse')).toBe(songBeatsAtDensity(first.beats, 'sparse'));
    expect(songBeatsAtDensity(first.beats, 'sparse').every(beat => beat.strong)).toBe(true);
    // Analysed from the music track's source file, never from the rendered song.
    expect(songMusicSource({ ...item, referenceAudio: edited([{ startMs: 0, sourceOffsetMs: 0, durationMs: 4000 }]) })).toEqual(SOURCE);
  });
});

describe('规则 2：剪掉、挪动、加前空白以后，节拍跟着音乐走，不用重新分析', () => {
  const item = withBeats(versioned(1, false)).rundown[0]!;
  it('没剪过的歌：拍点原样', () => {
    expect(atMs(item)).toEqual(Array.from({ length: 16 }, (_, i) => i * 500));
  });
  it('剪掉一段：拍点 = 原拍点 + 片段位移，被剪掉部分的拍点消失', () => {
    const cut = { ...item, referenceAudio: edited([{ startMs: 0, sourceOffsetMs: 0, durationMs: 2000 }, { startMs: 2000, sourceOffsetMs: 4000, durationMs: 3000 }]) };
    expect(atMs(cut)).toEqual([0, 500, 1000, 1500, 2000, 2500, 3000, 3500, 4000, 4500]);
    const beats = songBeats(cut);
    if (beats.state !== 'ready') throw new Error('节拍没有跟过来');
    // Source 4000 ms (a strong beat) now plays at 2000 ms.
    expect(beats.beats.find(beat => beat.atMs === 2000)).toMatchObject({ sourceId: 'beat:4000', strong: true });
    expect(beats.segments.map(segment => [segment.startMs, segment.endMs, segment.sourceId])).toEqual([[0, 2000, 'segment:0'], [2000, 5000, 'segment:0']]);
  });
  it('挪动片段、加前空白：拍点一起挪', () => {
    const moved = { ...item, referenceAudio: edited([{ startMs: 0, sourceOffsetMs: 0, durationMs: 2000 }, { startMs: 3000, sourceOffsetMs: 2000, durationMs: 2000 }]) };
    expect(atMs(moved)).toEqual([0, 500, 1000, 1500, 3000, 3500, 4000, 4500]);
    const padded = { ...item, referenceAudio: edited([{ startMs: 1000, sourceOffsetMs: 0, durationMs: 8000 }]) };
    expect(atMs(padded)).toEqual(Array.from({ length: 16 }, (_, i) => 1000 + i * 500));
  });
  it('换了音乐：节拍失效，等重新识别', () => {
    const other = { ...item, referenceAudio: { ...SOURCE, assetId: 'other', sha256: 'c'.repeat(64) } };
    expect(songBeats(other)).toMatchObject({ state: 'stale', reason: '音乐换了，需要重新识别节拍' });
  });
});

describe('规则 3：旧工程打开后只剩一份节拍', () => {
  const structure = acceptMusicStructure({}, SOURCE, candidates(), 'old').structure;
  const levels = { dense: [0, 250, 500, 750, 1000, 1250, 1500, 1750], standard: [0, 500, 1000, 1500], sparse: [0, 1000] };
  function oldProject(): LinkProject {
    return parseLinkProject({ ...createEmptyLinkProject('旧工程'), schemaVersion: 2, rundown: [
      { id: 'both', title: '两份都有', referenceAudio: { ...SOURCE, beats: { sourceSha256: SOURCE.sha256, level: 'standard', levels, pointsMs: levels.standard } }, lighting: { ...createLightingDocument(), version: 2, musicAnalysis: structure } },
      { id: 'ibt', title: '只有简易检测', referenceAudio: { ...SOURCE, beats: { sourceSha256: SOURCE.sha256, level: 'sparse', levels, pointsMs: levels.sparse } } },
      { id: 'plain', title: '没有节拍' }
    ] });
  }
  it('两种旧数据都无损搬进 item.music，旧字段删掉，工程升到 3', () => {
    const before = oldProject();
    const { project, moved } = migrateSongMusic(before);
    expect(moved).toBe(2);
    expect(project.schemaVersion).toBe(3);
    const [both, ibt, plain] = project.rundown;
    expect(both!.music).toMatchObject({ method: 'automatic', sourceSha256: SOURCE.sha256 });
    expect(both!.music!.structure).toEqual(structure);
    expect(ibt!.music!.method).toBe('ibt');
    // Every beat of every saved density is still there, and the sparsest density is the strong beats.
    expect(ibt!.music!.structure.beats.map(beat => beat.atMs)).toEqual(levels.dense);
    expect(ibt!.music!.structure.beats.filter(beat => beat.strong).map(beat => beat.atMs)).toEqual(levels.sparse);
    for (const item of project.rundown) { expect(item.referenceAudio?.beats).toBeUndefined(); expect(item.lighting?.musicAnalysis).toBeUndefined(); }
    expect(plain).toBe(before.rundown[2]);
    // Saved and opened again, nothing more changes.
    const reopened = parseLinkProject(JSON.parse(serializeLinkProject(project)));
    expect(reopened).toEqual(project);
    expect(migrateSongMusic(reopened).project).toBe(reopened);
    // The editor and the lighting workspace see the same beats as before.
    expect(atMs(both!)).toEqual(structure.beats.map(beat => beat.atMs));
    expect(atMs(ibt!)).toEqual(levels.dense);
  });
  it('两份都有时用音乐识别的那份；简易检测的那份交给运行日志', () => {
    const { dropped } = migrateSongMusic(oldProject());
    expect(dropped).toEqual([{ itemId: 'both', title: '两份都有', beats: { sourceSha256: SOURCE.sha256, level: 'standard', levels, pointsMs: levels.standard } }]);
  });
  it('3 版工程里出现旧字段，打不开', () => {
    const migrated = migrateSongMusic(oldProject()).project;
    const raw = JSON.parse(serializeLinkProject(migrated)) as LinkProject;
    raw.rundown[0]!.lighting = { ...raw.rundown[0]!.lighting!, musicAnalysis: structure };
    expect(() => parseLinkProject(raw)).toThrow('节拍存了两份');
  });
});

describe('规则 4：重新识别节拍不产生 MA2 待同步改动', () => {
  const track = (at: number): LightingTrack => ({ id: 'track', name: '灯光', kind: 'ma2', color: '#68c9ed', group: '', muted: false, solo: false, locked: false, channel: 1, controller: 7, portProfileId: '', noteNames: {},
    clips: [{ id: 'clip', name: '编排', start: 0, duration: 8000, timeLock: 'time', muted: false, events: [{ id: 'cue', kind: 'ma2', at, sequence: 1, executor: '1.101', cue: '1', action: 'goto', label: '开场' }] }] });
  function bound(editedAt: number): LightingDocument {
    return { ...createLightingDocument(), tracks: [track(editedAt)], ma2Bindings: [{ id: 'binding', timecode: 7, name: '灯光 7', readAt: '2026-11-11T00:00:00.000Z', sourceXml: '<MA/>', baselineTracks: [track(0)], mappings: [], playback: 'editable', timeOriginMs: 0 }] };
  }
  it('节拍改在歌上，灯光文档还是原来那个对象，待同步改动一样', () => {
    for (const editedAt of [0, 500]) {
      const project = setLightingCommand('song', bound(editedAt)).execute(withBeats(versioned(2, false)));
      const item = project.rundown[0]!, source = songMusicSource(item)!;
      const pending = ma2PendingChanges(project);
      expect(pending.length).toBe(editedAt ? 1 : 0);
      const again = setSongMusicCommand('song', source, acceptMusicStructure(item, source, candidates(), 'again'), { label: '重新识别' }).execute(project);
      expect(again.rundown[0]!.music).not.toBe(item.music);
      expect(again.rundown[0]!.lighting).toBe(item.lighting);
      expect(ma2PendingChanges(again)).toEqual(pending);
      const background = setSongMusicCommand('song', source, acceptMusicStructure(item, source, candidates(), 'auto'), { label: '自动识别', background: true });
      expect(background.rebaseHistory?.(project).rundown[0]!.lighting).toBe(item.lighting);
    }
  });
});
