import { describe, expect, it } from 'vitest';
import { createEmptyLinkProject, parseLinkProject } from '@tb/schema';
import { audioSegments } from './audio-edit';
import { projectAssetFiles } from './project-asset-files';

const source = { assetId: 'original', relativePath: 'assets/reference-audio/original.wav', sha256: 'a'.repeat(64), durationMs: 5000 };
const track = { assetId: 'track', relativePath: 'assets/reference-audio/track.wav', sha256: 'b'.repeat(64), durationMs: 5000 };
const mixed = { assetId: 'mixed', relativePath: 'assets/reference-audio/mixed.wav', sha256: 'c'.repeat(64), durationMs: 5000 };

describe('工程素材文件', () => {
  it('列出歌曲音频、编辑前音频、各音轨来源与导入素材，同一文件只列一次', () => {
    const project = parseLinkProject({ ...createEmptyLinkProject('素材清单'), mediaAssets: [
      { id: 'video', name: '开场.mp4', kind: 'video', relativePath: 'assets/reference-media/video.mp4', sha256: 'd'.repeat(64), byteLength: 10, durationMs: 1000, width: 64, height: 64 }
    ], rundown: [
      { id: 'edited', title: '改过的歌', cues: [], referenceAudio: { ...mixed, timeline: { source, segments: audioSegments(source), tracks: [
        { id: 'one', title: '人声', source, segments: audioSegments(source) },
        { id: 'two', title: '伴奏', source: track, segments: audioSegments(track) }
      ] } } },
      { id: 'same', title: '同一首', cues: [], referenceAudio: mixed },
      { id: 'empty', title: '没有音频', cues: [] }
    ] });
    expect(projectAssetFiles(project)).toEqual([
      { relativePath: mixed.relativePath, sha256: mixed.sha256, label: '歌曲音频 · 改过的歌' },
      { relativePath: source.relativePath, sha256: source.sha256, label: '编辑前音频 · 改过的歌' },
      { relativePath: track.relativePath, sha256: track.sha256, label: '音轨「伴奏」 · 改过的歌' },
      { relativePath: 'assets/reference-media/video.mp4', sha256: 'd'.repeat(64), label: '视频素材 · 开场.mp4' }
    ]);
  });

  it('只列软件放在 assets 素材子目录里的音视频和图片文件', () => {
    const asset = (id: string, relativePath: string) => ({ id, name: id, kind: 'audio' as const, relativePath, sha256: 'e'.repeat(64), byteLength: 10, durationMs: 1000 });
    const project = parseLinkProject({ ...createEmptyLinkProject('手写工程'), mediaAssets: [
      asset('root', 'song.wav'), asset('loose', 'assets/song.wav'), asset('nested', 'assets/reference-media/old/song.wav'),
      asset('text', 'assets/reference-media/notes.txt'), asset('upper', 'assets/reference-media/song.WAV')
    ], rundown: [{ id: 'song', title: '歌', cues: [], referenceAudio: { ...source, relativePath: 'assets/reference-audio/clip.mp4' } }] });
    expect(projectAssetFiles(project).map(file => file.relativePath)).toEqual(['assets/reference-media/song.WAV']);
  });
});
