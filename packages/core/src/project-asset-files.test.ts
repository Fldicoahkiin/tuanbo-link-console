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
});
